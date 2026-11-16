import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensurePrivateFile } from "../src/private-fs.js";
import { OutboundBridgeClient } from "../src/bridge-client.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function freePort() {
  const server = createServer(); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port; await new Promise<void>((done) => server.close(() => done())); return port;
}
async function serverFixture(enabled: boolean) {
  const path = await mkdtemp(join(tmpdir(), "local-browser-bridge-")); directories.push(path);
  const port = await freePort(); const bearer = "synthetic-local-browser-bridge-bearer-123456789";
  const env: Record<string, string> = { META_AUTH_MODE: "instagram", META_TOKEN_STORE_PATH: join(path, "token.json"), META_INSTAGRAM_PUBLISH_LOG: join(path, "publish.jsonl"),
    INSTAGRAM_MCP_HUB_STATE_PATH: join(path, "hub.json"), INSTAGRAM_MCP_HTTP_PORT: String(port), INSTAGRAM_MCP_HTTP_BEARER_TOKEN: bearer,
    ...(enabled ? { INSTAGRAM_MCP_BROWSER_BRIDGE: "true" } : {}) };
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("src/server.ts")], env, cwd: resolve("."), stderr: "pipe" });
  const client = new Client({ name: "browser-bridge-sdk-fixture", version: "1" });
  await client.connect(transport);
  return { path, port, bearer, client, transport };
}

describe("one-process stdio browser bridge", () => {
  it("refuses full HTTP transport when browser-only mode is requested in client environment", async () => {
    const path = await mkdtemp(join(tmpdir(),"sample-browser-env-conflict-")); directories.push(path);
    const child = spawn(process.execPath,["--import","tsx",resolve("src/server.ts")],{
      env:{PATH:process.env.PATH,...(process.env.SYSTEMROOT?{SYSTEMROOT:process.env.SYSTEMROOT}:{}),...(process.env.WINDIR?{WINDIR:process.env.WINDIR}:{}),...(process.env.TEMP?{TEMP:process.env.TEMP}:{}),...(process.env.TMP?{TMP:process.env.TMP}:{}),META_TOKEN_STORE_PATH:join(path,"token.json"),META_INSTAGRAM_PUBLISH_LOG:join(path,"publish.jsonl"),INSTAGRAM_MCP_HUB_STATE_PATH:join(path,"hub.json"),INSTAGRAM_MCP_HTTP_PORT:String(await freePort()),INSTAGRAM_MCP_HTTP_BEARER_TOKEN:"sample-private-loopback-bearer-123456789",INSTAGRAM_MCP_BROWSER_BRIDGE:"true",INSTAGRAM_MCP_TRANSPORT:"http"},stdio:["ignore","pipe","pipe"]
    });
    let stderr=""; child.stderr.on("data",data=>{stderr+=data.toString();});
    const timer=setTimeout(()=>child.kill("SIGTERM"),process.platform==="win32"?15000:1500);
    const code=await new Promise<number|null>(done=>child.once("exit",done)); clearTimeout(timer);
    expect(code).toBe(1); expect(stderr).toContain("BROWSER_BRIDGE_TRANSPORT_CONFLICT");
  });
  it("keeps the HTTP bridge disabled by default", async () => {
    const subject = await serverFixture(false);
    try {
      expect((await subject.client.listTools()).tools.some((tool) => tool.name === "meta_auth_status")).toBe(true);
      await expect(fetch(`http://127.0.0.1:${subject.port}/health`)).rejects.toThrow();
    } finally { await subject.client.close(); }
  });

  it("shares the stdio runtime with a bounded loopback companion and closes it with stdio", async () => {
    const subject = await serverFixture(true);
    const baseUrl = `http://127.0.0.1:${subject.port}`;
    try {
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/mcp`, { method:"POST",headers:{authorization:`Bearer ${subject.bearer}`,"content-type":"application/json"},body:"{}" })).status).toBe(404);
      expect((await fetch(`${baseUrl}/bridge/register`, {method:"POST",headers:{authorization:`Bearer ${subject.bearer}`,"content-type":"application/json","x-api-protocol-version":"1","x-bridge-source":"phone"},body:JSON.stringify({source:"phone",mode:"phone_standalone",accountBinding:"sample:phone",capabilities:["inbox.list"]})})).status).toBe(403);
      expect((await fetch(`${baseUrl}/bridge/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      const accountBinding = "instagram:browser:fixture";
      const { bearer: bearerToken } = subject;
      const bridgeConfig = { baseUrl, bearerToken, mode: "browser_native_host" as const, source: "browser" as const,
        accountBinding, capabilities: ["account.inspect", "inbox.list"], allowLoopbackHttp: true };
      const credentialsPath = join(subject.path, "browser-bridge.json");
      await writeFile(credentialsPath, JSON.stringify(bridgeConfig), { mode: 0o600 });
      await ensurePrivateFile(credentialsPath);
      const companion = new OutboundBridgeClient({ ...bridgeConfig, credentialsPath });
      const registration = await companion.register();
      await companion.heartbeat(registration.bridgeId, { availability: "ready", capabilities: bridgeConfig.capabilities, accountBinding, accountHandle: "fixture_owner", surface: "instagram" });
      const pending = subject.client.callTool({ name: "meta_read_source", arguments: { source: "browser", operation: "inbox.list", limit: 1 } });
      let task;
      for (let attempt = 0; attempt < 100 && !task; attempt += 1) {
        task = (await companion.poll(registration.bridgeId, 1))[0];
        if (!task) await new Promise((done) => setTimeout(done, 10));
      }
      expect(task?.operation).toBe("inbox.list");
      await companion.submit(registration.bridgeId, task!.id, { source: "browser", nativeRef: "/direct/inbox", accountBinding,
        capturedAt: new Date().toISOString(), availability: "ready", coverage: "partial", historyCompleteness: "limited",
        data: { username: "fixture_owner", items: [{ id: "fixture-thread" }] }, errors: [] }, task!.contextHash);
      const result = await pending;
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(payload.observations).toContainEqual(expect.objectContaining({ source: "browser", accountBinding, data: expect.objectContaining({ username: "fixture_owner" }) }));
    } finally { await subject.client.close(); }
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
  // Includes process startup and Windows ACL-protected fixture files. The
  // production router/client deadlines remain independently bounded.
  }, process.platform === "win32" ? 60_000 : 15_000);
});
