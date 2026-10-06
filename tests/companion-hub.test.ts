import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionHub } from "../src/companion-hub.js";

const roots: string[] = [];
async function makeHub() {
  const root = await mkdtemp(join(tmpdir(), "instagram-hub-"));
  roots.push(root);
  return new CompanionHub({ storagePath: join(root, "hub.json"), leaseMs: 1_000 });
}

const registration = {
  mode: "browser_native_host" as const,
  source: "browser" as const,
  accountBinding: "acct:one",
  capabilities: ["inbox.list", "message.send"]
};

describe("CompanionHub", () => {
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("registers, polls, completes a read, and replays the same read task id", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [] });
    const first = await hub.poll(bridgeId, 1, bridgeToken);
    expect(first).toMatchObject([{ id: task.id, kind: "read", operation: "inbox.list" }]);
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toMatchObject([{ id: task.id }]);
    await hub.submit(bridgeId, task.id, { items: [] }, undefined, bridgeToken);
    expect(await hub.result(task.id)).toMatchObject({ status: "complete", result: { items: [] } });
  });

  it("leases a write only once and rejects a mismatched or expired result", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await hub.enqueue({ kind: "write", source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "approved" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toHaveLength(1);
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toHaveLength(0);
    await expect(hub.submit(bridgeId, task.id, { status: "ACK" }, "fedcba9876543210", bridgeToken)).rejects.toThrow();
    expect(await hub.result(task.id)).toMatchObject({ status: "outcome_unknown" });

    const expired = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [], ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(hub.submit(bridgeId, expired.id, { items: [] }, undefined, bridgeToken)).rejects.toThrow();
  });

  it("allows only one poller across two hub instances to lease a mutation", async () => {
    const firstHub = await makeHub();
    const { bridgeId, bridgeToken } = await firstHub.register(registration);
    const task = await firstHub.enqueue({ kind: "write", source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "one shot" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    const secondHub = new CompanionHub({ storagePath: join(roots.at(-1)!, "hub.json"), leaseMs: 1_000 });
    const [first, second] = await Promise.all([
      firstHub.poll(bridgeId, 1, bridgeToken),
      secondHub.poll(bridgeId, 1, bridgeToken)
    ]);
    expect([...first, ...second].filter((candidate) => candidate.id === task.id)).toHaveLength(1);
  });

  it("allows only one child process to poll a dispatched mutation", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await hub.enqueue({ kind: "write", source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "cross process" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    const root = roots.at(-1)!;
    const gatePath = join(root, "start-gate");
    const script = `import { existsSync } from 'node:fs'; import { CompanionHub } from './src/companion-hub.ts'; while (!existsSync(process.env.HUB_GATE)) await new Promise(r => setTimeout(r, 5)); const hub = new CompanionHub({ storagePath: process.env.HUB_STATE, lockTimeoutMs: 3000 }); const tasks = await hub.poll(process.env.HUB_BRIDGE_ID, 1, process.env.HUB_BRIDGE_TOKEN); process.stdout.write(JSON.stringify(tasks.map(task => task.id)));`;
    const childPoll = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, HUB_STATE: join(root, "hub.json"), HUB_GATE: gatePath, HUB_BRIDGE_ID: bridgeId, HUB_BRIDGE_TOKEN: bridgeToken },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`poll child exited ${code}: ${stderr}`)));
    });
    const first = childPoll();
    const second = childPoll();
    await new Promise((resolve) => setTimeout(resolve, 75));
    await writeFile(gatePath, "go", { mode: 0o600 });
    const results = await Promise.all([first, second]);
    const delivered = results.flatMap((value) => JSON.parse(value) as string[]);
    expect(delivered.filter((id) => id === task.id)).toHaveLength(1);
  });

  it("rejects a result from another registered bridge and preserves the original lease across restart", async () => {
    const firstHub = await makeHub();
    const firstBridge = await firstHub.register(registration);
    const secondBridge = await firstHub.register(registration);
    const task = await firstHub.enqueue({ kind: "write", source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "bound" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    expect(await firstHub.poll(firstBridge.bridgeId, 1, firstBridge.bridgeToken)).toHaveLength(1);
    const restartedHub = new CompanionHub({ storagePath: join(roots.at(-1)!, "hub.json"), leaseMs: 1_000 });
    expect(await restartedHub.poll(firstBridge.bridgeId, 1, firstBridge.bridgeToken)).toHaveLength(0);
    await expect(restartedHub.submit(secondBridge.bridgeId, task.id, { status: "ACK" }, "0123456789abcdef", secondBridge.bridgeToken)).rejects.toThrow(/assignment mismatch/);
    expect(await restartedHub.result(task.id)).toMatchObject({ status: "leased" });
  });

  it("fails closed on corrupt lock state and leaves it untouched for explicit recovery", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const lockPath = `${join(roots.at(-1)!, "hub.json")}.lock`;
    await writeFile(lockPath, "ambiguous lock", { mode: 0o600 });
    await expect(hub.poll(bridgeId, 1, bridgeToken)).rejects.toThrow(/owner data is corrupt/);
    expect(await readFile(lockPath, "utf8")).toBe("ambiguous lock");
  });

  it.each(["accessToken", "access_token", "ACCESS-TOKEN", "refreshToken", "clientSecret", "apiKey", "privateKey", "sessionKey", "cookies", "proxyAuthorization", "passwordHash", "passphrase", "deviceId"])("rejects nested sensitive result key %s before saving any receipt", async (key) => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [] });
    await hub.poll(bridgeId, 1, bridgeToken);
    await expect(hub.submit(bridgeId, task.id, { nested: { [key]: "FAKE_ACCESS_TOKEN_SENTINEL" } }, undefined, bridgeToken))
      .rejects.toThrow(/sensitive result field/);
    expect(await hub.result(task.id)).toMatchObject({ status: "leased" });
    const persisted = await readFile(join(roots.at(-1)!, "hub.json"), "utf8");
    expect(persisted).not.toContain("FAKE_ACCESS_TOKEN_SENTINEL");
  });

  it("does not scan ordinary message text for credential-like words", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [] });
    await hub.poll(bridgeId, 1, bridgeToken);
    await hub.submit(bridgeId, task.id, { messages: [{ text: "The message literally says accessToken and password." }] }, undefined, bridgeToken);
    expect(await hub.result(task.id)).toMatchObject({ status: "complete", result: { messages: [{ text: "The message literally says accessToken and password." }] } });
  });

  it("persists private state with restrictive permissions and excludes payload text from audit", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    await hub.enqueue({ kind: "write", source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "private body" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    await hub.heartbeat({ bridgeId, bridgeToken, status: { online: true } });
    const path = join(roots.at(-1)!, "hub.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { audit: unknown[] };
    expect(JSON.stringify(persisted.audit)).not.toContain("private body");
  });
});
