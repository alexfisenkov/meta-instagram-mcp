import { createHmac, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { StudentVault } from "../src/student/vault.js";

const run = promisify(execFile);
const entrypoint = fileURLToPath(new URL("../src/student-server.ts", import.meta.url));

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolveListen, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", () => resolveListen()); });
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("test_port_unavailable");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function testEnv(directory: string, configFile: string, port: number, key: Buffer) {
  return {
    ...process.env,
    META_BROKER_SERVICE_TOKEN: "synthetic-service-token-for-startup-test",
    META_BROKER_SUBJECT_KEY: randomBytes(32).toString("base64"),
    META_BROKER_VAULT_KEY: key.toString("base64"),
    META_BROKER_STATE_DIR: directory,
    META_BROKER_CALLBACK_URL: "https://broker.example/meta/oauth/callback",
    META_BROKER_PLATFORM_ORIGIN: "https://platform.example",
    META_BROKER_CONFIG_FILE: configFile,
    META_BROKER_PORT: String(port),
    META_BROKER_REFRESH_INTERVAL_MS: "60000",
    YOUTUBE_OAUTH_CLIENT_ID: "synthetic-client.apps.googleusercontent.com",
    YOUTUBE_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
    YOUTUBE_OAUTH_REDIRECT_URL: "https://broker.example/youtube/oauth/callback",
  };
}

async function waitStarted(child: ReturnType<typeof spawn>): Promise<string> {
  return await new Promise((resolveStarted, reject) => {
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.split("\n").some((line) => line.includes('"event":"student_broker_started"'))) resolveStarted(stdout);
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.split("\n").some((line) => line.includes('"event":"student_broker_started"'))) resolveStarted(stderr); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`broker_startup_exit_${code}:${stderr}`)));
  });
}

async function waitExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

it("releases the Meta writer lock when a corrupt YouTube vault aborts startup and a Meta-only rollback serves all six products", async () => {
  const directory = await mkdtemp(join(tmpdir(), "student-startup-rollback-"));
  const key = randomBytes(32), youtubeDirectory = join(directory, "youtube"), configFile = join(directory, "config.json");
  let rollbackChild: ReturnType<typeof spawn> | undefined;
  const meta = await StudentVault.open(directory, key); await meta.close();
  await mkdir(youtubeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(youtubeDirectory, "vault.json"), "{synthetic-corrupt-youtube-vault", { mode: 0o600 });
  const youtubeConfig = { version: 1, products: [{ product: "youtube", key: "youtube", provider: "youtube", googleClientIdEnv: "YOUTUBE_OAUTH_CLIENT_ID", googleClientSecretEnv: "YOUTUBE_OAUTH_CLIENT_SECRET", callbackUrlEnv: "YOUTUBE_OAUTH_REDIRECT_URL", apiVersion: "v3", admission: "live", testSubjects: [] }] };
  await writeFile(configFile, JSON.stringify(youtubeConfig), { mode: 0o600 });

  try {
    const failedPort = await freePort();
    await expect(run(process.execPath, ["--import", "tsx", entrypoint], { env: testEnv(directory, configFile, failedPort, key), timeout: 5000 })).rejects.toMatchObject({ code: 1, stderr: '{"event":"student_broker_start_failed"}\n' });
    await expect(lstat(join(directory, ".writer-lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = await StudentVault.open(directory, key); await reopened.close();

    await writeFile(configFile, JSON.stringify({ version: 1, products: [] }), { mode: 0o600 });
    const rollbackPort = await freePort(), env = testEnv(directory, configFile, rollbackPort, key);
    delete (env as NodeJS.ProcessEnv).YOUTUBE_OAUTH_CLIENT_ID;
    delete (env as NodeJS.ProcessEnv).YOUTUBE_OAUTH_CLIENT_SECRET;
    delete (env as NodeJS.ProcessEnv).YOUTUBE_OAUTH_REDIRECT_URL;
    rollbackChild = spawn(process.execPath, ["--import", "tsx", entrypoint], { env, stdio: ["ignore", "pipe", "pipe"] });
    await waitStarted(rollbackChild);
    const now = Math.floor(Date.now() / 1000), header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), payload = Buffer.from(JSON.stringify({ iss: "masterskaya-platform", aud: "meta-student-broker", tenantId: "masterskaya", sub: "owner-test", iat: now, exp: now + 60 })).toString("base64url");
    const subject = `${header}.${payload}.${createHmac("sha256", Buffer.from(env.META_BROKER_SUBJECT_KEY, "base64")).update(`${header}.${payload}`).digest("base64url")}`;
    const response = await fetch(`http://127.0.0.1:${rollbackPort}/student/mcp`, { method: "POST", headers: { Authorization: `Bearer ${env.META_BROKER_SERVICE_TOKEN}`, "X-Meta-Subject": subject, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "meta_connections_catalog", arguments: {} } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0].text).products).toHaveLength(6);
    rollbackChild.kill("SIGTERM"); await waitExit(rollbackChild); rollbackChild = undefined;
  } finally {
    if (rollbackChild) { rollbackChild.kill("SIGTERM"); await waitExit(rollbackChild); }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
