import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionHub } from "../src/companion-hub.js";
import { startHttpServer, type Listener, type HttpServerOptions } from "../src/http-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpOptions } from "../src/transport-config.js";

const listeners: Listener[] = [];
const dirs: string[] = [];
const bearer = "http-test-bearer-token-value-0123456789";
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function start(overrides: Partial<Pick<HttpServerOptions, "oauthHandler" | "webhookReceiver" | "oauthPath" | "webhookPath">> = {}) {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "instagram-http-")); dirs.push(dir);
  const hub = new CompanionHub({ storagePath: join(dir, "hub.json") });
  const listener = await startHttpServer({
    host: "127.0.0.1", port, bearerSecret: bearer, allowedHosts: [`127.0.0.1:${port}`],
    allowedOrigins: [`http://127.0.0.1:${port}`], maxRequestBytes: 1_024,
    hub,
    ...overrides
  });
  listeners.push(listener);
  return { url: `http://127.0.0.1:${port}`, port, hub };
}
async function rawPost(url: string, headers: Record<string, string>, body: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: Number(target.port), path: target.pathname, method: "POST", headers: { "content-type": "application/json", ...headers } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(body);
  });
}
async function rawPostWithHeaders(url: string, headers: string[], body: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: Number(target.port), path: target.pathname, method: "POST", headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("native Streamable HTTP endpoint", () => {
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("requires bearer and enforces Host, Origin, size, and minimal public health", async () => {
    expect(createHttpOptions({ bearerSecret: bearer, allowedHosts: ["api.example.test"], allowedOrigins: ["https://api.example.test"] })).toMatchObject({
      host: "127.0.0.1", allowedHosts: ["api.example.test"], allowedOrigins: ["https://api.example.test"]
    });
    expect(() => createHttpOptions({ bearerSecret: bearer, allowedOrigins: ["https://*.example.test"] })).toThrow(/Origin/);
    const { url } = await start();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(Object.keys(await (await fetch(`${url}/health`)).json() as object)).toEqual(["status"]);
    expect((await fetch(`${url}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
    expect(await rawPost(`${url}/mcp`, { ...headers, host: "attacker.example" }, "{}" )).toBe(403);
    expect(await rawPostWithHeaders(`${url}/mcp`, ["host", `127.0.0.1:${new URL(url).port}`, "authorization", `Bearer ${bearer}`, "authorization", `Bearer ${bearer}`, "content-type", "application/json"], "{}" )).toBe(400);
    expect(await rawPostWithHeaders(`${url}/mcp`, ["host", `127.0.0.1:${new URL(url).port}`, "authorization", `Bearer ${bearer}`, "origin", `${url}`, "origin", "https://attacker.example", "content-type", "application/json"], "{}" )).toBe(403);
    expect((await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, origin: "https://attacker.example" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}/mcp`, { method: "POST", headers, body: "x".repeat(2_048) })).status).toBe(413);
  });

  it("serves initialize, all existing tools, and a tool call through the shared factory", async () => {
    const { url } = await start();
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } }
    });
    const client = new Client({ name: "http-integration-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(18);
      expect(tools.tools.map((tool) => tool.name)).toContain("meta_auth_status");
      const result = await client.callTool({ name: "meta_scope_presets", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
    } finally { await client.close(); }
  });

  it("handles authenticated bridge registration, typed task delivery, and result read-back", async () => {
    const { url, hub } = await start();
    const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-api-protocol-version": "1", "x-bridge-source": "browser" };
    const registered = await fetch(`${url}/bridge/register`, { method: "POST", headers, body: JSON.stringify({ mode: "browser_native_host", source: "browser", accountBinding: "acct:test", capabilities: ["inbox.list", "message.send"] }) });
    expect(registered.status).toBe(201);
    const identity = await registered.json() as { bridgeId: string; bridgeToken: string };
    const readTask = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:test", operation: "inbox.list", payload: { limit: 10 }, targetRefs: [] });
    const poll = await fetch(`${url}/bridge/poll`, { method: "POST", headers, body: JSON.stringify({ ...identity, maxTasks: 5 }) });
    expect(await poll.json()).toMatchObject({ tasks: [{ id: readTask.id, operation: "inbox.list" }] });
    const submitted = await fetch(`${url}/bridge/result`, { method: "POST", headers, body: JSON.stringify({ ...identity, taskId: readTask.id, result: { items: [] } }) });
    expect(submitted.status).toBe(204);
    expect(await hub.result(readTask.id)).toMatchObject({ status: "complete", result: { items: [] } });
  });

  it("keeps OAuth and webhook routes injectable and passes webhook raw bytes unchanged", async () => {
    let seen = "";
    const { url } = await start({ webhookReceiver: { async handle(input) {
      seen = Buffer.from(input.rawBody ?? []).toString("hex");
      return { status: 200, body: "received", contentType: "text/plain; charset=utf-8" };
    } } });
    expect((await fetch(`${url}/oauth/callback`)).status).toBe(404);
    const body = "{ \"raw\": [1,  2] }";
    const response = await fetch(`${url}/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(200);
    expect(seen).toBe(Buffer.from(body).toString("hex"));
  });
});
