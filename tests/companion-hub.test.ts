import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionHub } from "../src/companion-hub.js";
import { createUiApprovalAuthority } from "../src/ui-approval.js";
import { assertPrivateFile, ensurePrivateFile } from "../src/private-fs.js";
import { createHash } from "node:crypto";

const roots: string[] = [];
const authorities = new WeakMap<CompanionHub, Awaited<ReturnType<typeof createUiApprovalAuthority>>>();
async function makeHub(options: { leaseMs?: number; now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "instagram-hub-"));
  roots.push(root);
  const authority = await createUiApprovalAuthority({ privateKeyPath: join(root, "approval.json"), projectRoot: process.cwd() });
  const hub = new CompanionHub({ storagePath: join(root, "hub.json"), leaseMs: options.leaseMs ?? 30_000, now: options.now, approvalPublicKey: authority.publicKey });
  authorities.set(hub, authority);
  return hub;
}

function enqueueWrite(hub: CompanionHub, input: Omit<Parameters<CompanionHub["enqueueApprovedWrite"]>[0], "kind" | "requestId" | "fingerprint">) {
  const authority = authorities.get(hub)!;
  return hub.enqueueApprovedWrite({ ...input, kind: "write", requestId: "req-0123456789abcdef", fingerprint: createHash("sha256").update(JSON.stringify(input.payload)).digest("hex") }, (task) => authority.sign(task));
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

  it("cancels only queued or leased read tasks and never changes a write lease", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const queued = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [] });

    expect(await hub.cancelReadTask(queued.id)).toBe(true);
    expect(await hub.result(queued.id)).toMatchObject({ status: "expired" });
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toEqual([]);

    const leased = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [] });
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toMatchObject([{ id: leased.id }]);
    expect(await hub.cancelReadTask(leased.id)).toBe(true);
    expect(await hub.result(leased.id)).toMatchObject({ status: "expired" });
    await expect(hub.submit(bridgeId, leased.id, { items: [] }, undefined, bridgeToken)).rejects.toThrow(/expired/i);

    const write = await enqueueWrite(hub, { source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "approved" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toMatchObject([{ id: write.id }]);
    expect(await hub.cancelReadTask(write.id)).toBe(false);
    expect(await hub.result(write.id)).toMatchObject({ status: "leased" });
  });

  it("honors a shorter read task TTL so a late poll cannot lease it", async () => {
    let now = 1_000;
    const hub = await makeHub({ now: () => now });
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [], ttlMs: 100 });
    now += 101;

    expect(await hub.poll(bridgeId, 1, bridgeToken)).toEqual([]);
    expect(await hub.result(task.id)).toMatchObject({ status: "expired" });
  });

  it("publishes the verifier key and requires an account-bound Instagram surface before reporting readiness", async () => {
    const hub = await makeHub();
    const phoneRegistration = { mode: "phone_standalone" as const, source: "phone" as const, accountBinding: "acct:one", capabilities: ["inbox.list", "comment.like"] };
    const { bridgeId, bridgeToken, approvalPublicKey } = await hub.register(phoneRegistration);
    expect(approvalPublicKey).toContain("BEGIN PUBLIC KEY");
    expect(await hub.sourceStatus("phone", "acct:one")).toMatchObject({ availability: "offline", capabilities: [] });
    await hub.heartbeat({ bridgeId, bridgeToken, source: "phone", status: { availability: "ready", capabilities: ["inbox.list"] } });
    expect(await hub.sourceStatus("phone", "acct:one")).toMatchObject({ availability: "offline", capabilities: [] });
    await hub.heartbeat({ bridgeId, bridgeToken, source: "phone", status: { availability: "ready", accountBinding: "acct:one", accountHandle: "fixture", surface: "instagram", capabilities: ["inbox.list", "comment.like", "shell.exec"] } });
    expect(await hub.sourceStatus("phone", "acct:one")).toMatchObject({
      availability: "ready", capabilities: ["inbox.list", "comment.like"], accountBinding: "acct:one"
    });
  });

  it("leases a write only once and rejects a mismatched or expired result", async () => {
    let now = 1_000;
    const hub = await makeHub({ now: () => now });
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await enqueueWrite(hub, { source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "approved" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toHaveLength(1);
    expect(await hub.poll(bridgeId, 1, bridgeToken)).toHaveLength(0);
    await expect(hub.submit(bridgeId, task.id, { status: "ACK" }, "fedcba9876543210", bridgeToken)).rejects.toThrow();
    expect(await hub.result(task.id)).toMatchObject({ status: "outcome_unknown" });

    const expired = await hub.enqueue({ kind: "read", source: "browser", accountBinding: "acct:one", operation: "inbox.list", payload: {}, targetRefs: [], ttlMs: 1 });
    now += 2;
    await expect(hub.submit(bridgeId, expired.id, { items: [] }, undefined, bridgeToken)).rejects.toThrow();
  }, process.platform === "win32" ? 30_000 : 15_000);

  it("rejects a public unapproved write enqueue", async () => {
    const hub = await makeHub();
    await hub.register(registration);
    await expect(hub.enqueue({ kind: "write", source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "arbitrary" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef", requestId: "req-0123456789abcdef", fingerprint: "a".repeat(64) }))
      .rejects.toThrow(/internal signed-approval/);
  });

  it("allows only one poller across two hub instances to lease a mutation", async () => {
    const firstHub = await makeHub();
    const { bridgeId, bridgeToken } = await firstHub.register(registration);
    const task = await enqueueWrite(firstHub, { source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "one shot" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    const secondHub = new CompanionHub({ storagePath: join(roots.at(-1)!, "hub.json"), leaseMs: 30_000 });
    const [first, second] = await Promise.all([
      firstHub.poll(bridgeId, 1, bridgeToken),
      secondHub.poll(bridgeId, 1, bridgeToken)
    ]);
    expect([...first, ...second].filter((candidate) => candidate.id === task.id)).toHaveLength(1);
  });

  it("allows only one child process to poll a dispatched mutation", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const task = await enqueueWrite(hub, { source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "cross process" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    const root = roots.at(-1)!;
    const script = `import { CompanionHub } from './src/companion-hub.ts'; const hub = new CompanionHub({ storagePath: process.env.HUB_STATE, lockTimeoutMs: 3000 }); process.stdout.write('READY\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); const tasks = await hub.poll(process.env.HUB_BRIDGE_ID, 1, process.env.HUB_BRIDGE_TOKEN); process.stdout.write(JSON.stringify(tasks.map(task => task.id)));`;
    const childPoll = () => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: root, TMPDIR: root, TEMP: root, TMP: root, HUB_STATE: join(root, "hub.json"), HUB_BRIDGE_ID: bridgeId, HUB_BRIDGE_TOKEN: bridgeToken },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = ""; let stderr = ""; let readyResolve!: () => void; let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
      let resultResolve!: (value: string) => void; let resultReject!: (error: Error) => void;
      const result = new Promise<string>((resolveResult, rejectResult) => { resultResolve = resolveResult; resultReject = rejectResult; });
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; if (stdout.includes("READY\n")) readyResolve(); });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => { readyReject(error); resultReject(error); });
      child.once("exit", (code) => {
        if (code !== 0) { const error = new Error(`poll child exited ${code}: ${stderr}`); readyReject(error); resultReject(error); }
        else resultResolve(stdout.replace("READY\n", ""));
      });
      const timeout = setTimeout(() => { const error = new Error("poll child did not reach the startup barrier"); child.kill(); readyReject(error); resultReject(error); }, 10_000);
      void ready.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
      return { result, ready, releaseGate: () => child.stdin.end("go"), kill: () => child.kill() };
    };
    const children = [childPoll(), childPoll()];
    try {
      await Promise.all(children.map((child) => child.ready));
      children.forEach((child) => child.releaseGate());
    } catch (error) {
      children.forEach((child) => { child.releaseGate(); child.kill(); });
      await Promise.allSettled(children.map((child) => child.result));
      throw error;
    }
    const results = await Promise.all(children.map((child) => child.result));
    const delivered = results.flatMap((value) => JSON.parse(value) as string[]);
    expect(delivered.filter((id) => id === task.id)).toHaveLength(1);
  });

  it("rejects a result from another registered bridge and preserves the original lease across restart", async () => {
    const firstHub = await makeHub();
    const firstBridge = await firstHub.register(registration);
    const secondBridge = await firstHub.register(registration);
    const task = await enqueueWrite(firstHub, { source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "bound" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    expect(await firstHub.poll(firstBridge.bridgeId, 1, firstBridge.bridgeToken)).toHaveLength(1);
    const restartedHub = new CompanionHub({ storagePath: join(roots.at(-1)!, "hub.json"), leaseMs: 30_000 });
    expect(await restartedHub.poll(firstBridge.bridgeId, 1, firstBridge.bridgeToken)).toHaveLength(0);
    await expect(restartedHub.submit(secondBridge.bridgeId, task.id, { status: "ACK" }, "0123456789abcdef", secondBridge.bridgeToken)).rejects.toThrow(/assignment mismatch/);
    expect(await restartedHub.result(task.id)).toMatchObject({ status: "leased" });
  }, process.platform === "win32" ? 30_000 : 15_000);

  it("fails closed on corrupt lock state and leaves it untouched for explicit recovery", async () => {
    const hub = await makeHub();
    const { bridgeId, bridgeToken } = await hub.register(registration);
    const lockPath = `${join(roots.at(-1)!, "hub.json")}.lock`;
    await writeFile(lockPath, "ambiguous lock", { mode: 0o600 });
    await ensurePrivateFile(lockPath);
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
    await enqueueWrite(hub, { source: "browser", accountBinding: "acct:one", operation: "message.send", payload: { text: "private body" }, targetRefs: [{ accountBinding: "acct:one", nativeId: "thread-1" }], contextHash: "0123456789abcdef" });
    await hub.heartbeat({ bridgeId, bridgeToken, status: { online: true } });
    const path = join(roots.at(-1)!, "hub.json");
    await expect(assertPrivateFile(path)).resolves.toBeUndefined();
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { audit: unknown[] };
    expect(JSON.stringify(persisted.audit)).not.toContain("private body");
  });
});
