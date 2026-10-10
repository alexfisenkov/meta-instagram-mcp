import { PassThrough } from "node:stream";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OutboundBridgeClient } from "../src/bridge-client.js";
import { ensurePrivateFile } from "../src/private-fs.js";
import type { BridgeTask } from "../src/companion-hub.js";
import { CompanionHub } from "../src/companion-hub.js";
import { createBrowserNativeHost, type BrowserBridgeClient } from "../src/companion/browser-native-host.js";
import { NativeFrameDecoder, encodeNativeFrame } from "../src/companion/native-framing.js";
import { startHttpServer } from "../src/http-server.js";
import { approvalPayloadHash } from "../src/ui-approval.js";

const accountBinding = "owner:alex";
const readTask: BridgeTask = {
  id: "task-read", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "conversation.read",
  accountBinding, targetRefs: [{ accountBinding, nativeId: "thread-7" }], payload: { limit: 10 },
  expiresAt: new Date(Date.now() + 60_000).toISOString(), contextHash: "context-1"
};

describe("Browser Native Messaging host", () => {
  it("routes account inspection and snapshot tasks to the fixed semantic observer", async () => {
    const inspectTask = { ...readTask, id: "task-account", operation: "account.inspect", targetRefs: [], payload: {} } as unknown as BridgeTask;
    const input = new PassThrough();
    const output = new PassThrough();
    const client = bridgeClient([inspectTask]);
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    await host.start();
    input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => received.some((message) => isRecord(message) && message.kind === "task"));
    expect(received.find((message) => isRecord(message) && message.kind === "task")).toMatchObject({
      kind: "task", task: { operation: "account.inspect", targetRefs: [] }
    });
    host.close();
  });

  it("waits for account verification heartbeat before completing the bootstrap read", async () => {
    const inspectTask = { ...readTask, id: "task-account", operation: "account.inspect", targetRefs: [], payload: {} } as unknown as BridgeTask;
    const input = new PassThrough();
    const output = new PassThrough();
    let markHeartbeatStarted!: () => void;
    let releaseHeartbeat!: () => void;
    const heartbeatStarted = new Promise<void>((resolve) => { markHeartbeatStarted = resolve; });
    const heartbeatGate = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    const client = bridgeClient([inspectTask]);
    client.heartbeat = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { markHeartbeatStarted(); await heartbeatGate; });
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    await host.start();
    input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => received.some((message) => isRecord(message) && message.kind === "task"));
    input.write(encodeNativeFrame({ kind: "result", taskId: inspectTask.id, result: {
      source: "browser", nativeRef: "/direct/inbox/", accountBinding, capturedAt: new Date().toISOString(),
      availability: "ready", coverage: "complete", historyCompleteness: "not_applicable",
      data: { username: "alexfisenkov", accountBinding, loggedIn: true, surface: "instagram",
        capabilities: ["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies"] }, errors: []
    }, contextHash: inspectTask.contextHash }));

    await heartbeatStarted;
    expect(client.submit).not.toHaveBeenCalled();
    releaseHeartbeat();
    await waitFor(() => vi.mocked(client.submit).mock.calls.length === 1);
    expect(client.heartbeat).toHaveBeenCalledWith("bridge-1", expect.objectContaining({ availability: "ready", accountHandle: "alexfisenkov" }));
    host.close();
  });

  it("does not redispatch a leased read while Hub receipt submission is in flight", async () => {
    const inspectTask = { ...readTask, id: "task-account", operation: "account.inspect", targetRefs: [], payload: {} } as unknown as BridgeTask;
    const input = new PassThrough();
    const output = new PassThrough();
    const client = bridgeClient([inspectTask]);
    let submitted = false;
    let markSubmitStarted!: () => void;
    let releaseSubmit!: () => void;
    const submitStarted = new Promise<void>((resolve) => { markSubmitStarted = resolve; });
    const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
    client.poll = vi.fn(async () => submitted ? [] : [inspectTask]);
    client.submit = vi.fn(async () => { markSubmitStarted(); await submitGate; submitted = true; });
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    try {
      await host.start();
      input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
      await waitFor(() => received.some((message) => isRecord(message) && message.kind === "task"));
      input.write(encodeNativeFrame({ kind: "result", taskId: inspectTask.id, result: {
        source: "browser", nativeRef: "/direct/inbox/", accountBinding, capturedAt: new Date().toISOString(),
        availability: "ready", coverage: "complete", historyCompleteness: "not_applicable",
        data: { username: "alexfisenkov", accountBinding, loggedIn: true, surface: "instagram",
          capabilities: ["account.inspect", "inbox.list"] }, errors: []
      }, contextHash: inspectTask.contextHash }));
      await submitStarted;
      await waitFor(() => vi.mocked(client.poll).mock.calls.length >= 2);
      expect(received.filter((message) => isRecord(message) && message.kind === "task")).toHaveLength(1);
      expect(client.submit).toHaveBeenCalledOnce();
      releaseSubmit();
      await waitFor(() => submitted);
    } finally {
      releaseSubmit();
      host.close();
      input.end();
      output.end();
    }
  });

  it("allows a read to be redelivered after its receipt submission is rejected", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = bridgeClient([readTask]);
    client.poll = vi.fn(async () => vi.mocked(client.submit).mock.calls.length < 2 ? [readTask] : []);
    client.submit = vi.fn().mockRejectedValueOnce(new Error("receipt connection failed")).mockResolvedValue(undefined);
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    const result = {
      source: "browser", nativeRef: "/direct/t/thread-7/", accountBinding, capturedAt: new Date().toISOString(),
      availability: "ready", coverage: "partial", historyCompleteness: "limited",
      data: { username: "alexfisenkov", messages: [] }, errors: []
    };
    try {
      await host.start();
      input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
      await waitFor(() => received.filter((message) => isRecord(message) && message.kind === "task").length === 1);
      input.write(encodeNativeFrame({ kind: "result", taskId: readTask.id, result, contextHash: readTask.contextHash }));
      await waitFor(() => vi.mocked(client.submit).mock.calls.length === 1);
      await waitFor(() => received.filter((message) => isRecord(message) && message.kind === "task").length === 2);
      expect(client.submit).toHaveBeenCalledTimes(1);
      input.write(encodeNativeFrame({ kind: "result", taskId: readTask.id, result, contextHash: readTask.contextHash }));
      await waitFor(() => vi.mocked(client.submit).mock.calls.length === 2);
      expect(client.submit).toHaveBeenCalledTimes(2);
    } finally {
      host.close();
      input.end();
      output.end();
    }
  });

  it("registers, sends only a bound semantic task, and submits a provenance-bound result once", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = bridgeClient([readTask]);
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    await host.start();
    input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => received.some((message) => isRecord(message) && message.kind === "task"));
    expect(received[0]).toMatchObject({ kind: "ready", accountBinding, allowWrites: false });
    expect(received.find((message) => isRecord(message) && message.kind === "task")).toMatchObject({ kind: "task", task: { id: "task-read", operation: "conversation.read", source: "browser" } });

    const observation = {
      source: "browser", nativeRef: "/direct/t/thread-7/", accountBinding, capturedAt: new Date().toISOString(),
      availability: "ready", coverage: "partial", historyCompleteness: "limited",
      sideEffects: ["may_mark_seen"], data: { username: "alexfisenkov", messages: [] }, errors: []
    };
    input.write(encodeNativeFrame({ kind: "result", taskId: readTask.id, result: observation, contextHash: readTask.contextHash }));
    await waitFor(() => vi.mocked(client.submit).mock.calls.length === 1);
    expect(client.submit).toHaveBeenCalledWith("bridge-1", "task-read", observation, "context-1");
    host.close();
  });

  it("fails closed on account mismatch and leaves writes disabled by default", async () => {
    const writeTask: BridgeTask = { ...readTask, id: "request-123456789012", kind: "write", operation: "message.send", payload: { text: "hello" }, contextHash: "a".repeat(64) };
    const input = new PassThrough();
    const output = new PassThrough();
    const client = bridgeClient([writeTask]);
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    await host.start();
    input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => vi.mocked(client.submit).mock.calls.length === 1);
    expect(client.submit).toHaveBeenCalledWith("bridge-1", writeTask.id, {
      status: "FAILED", reason: "browser write gate is disabled"
    }, writeTask.contextHash);
    expect(received.some((message) => isRecord(message) && message.kind === "task")).toBe(false);
    host.close();
  });

  it("requires a trusted approval adapter before forwarding a write lease", async () => {
    const writeTask: BridgeTask = { ...readTask, id: "request-123456789012", kind: "write", operation: "message.send",
      payload: { text: "Exact approved text" }, contextHash: "a".repeat(64), expiresAt: new Date(Date.now() + 20_000).toISOString(),
      requestId: "approved-123456789012", fingerprint: "b".repeat(64) };
    const input = new PassThrough();
    const output = new PassThrough();
    const untrustedClient = bridgeClient([writeTask]);
    const untrustedInput = new PassThrough();
    const untrustedHost = createBrowserNativeHost({ client: untrustedClient, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true,
      input: untrustedInput, output: new PassThrough(), pollIntervalMs: 250, log: vi.fn() });
    await untrustedHost.start();
    untrustedInput.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => vi.mocked(untrustedClient.submit).mock.calls.length === 1);
    expect(untrustedClient.submit).toHaveBeenCalledWith("bridge-1", writeTask.id,
      { status: "FAILED", reason: "browser write task has no verified MutationSafety approval and durable attempt" }, writeTask.contextHash);
    untrustedHost.close();
    const client = bridgeClient([writeTask]);
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true,
      authorizeWriteLease: async (candidate, bridgeId) => ({ taskId: candidate.id, bridgeId, requestId: "approved-123456789012",
        fingerprint: "b".repeat(64), expectedFingerprint: "b".repeat(64), contextHash: candidate.contextHash!, expiresAt: candidate.expiresAt,
        source: "browser", accountBinding, operation: "message.send", target: candidate.targetRefs[0]!,
        payloadHash: approvalPayloadHash(candidate.payload), signature: "s".repeat(86) }),
      input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    await host.start();
    input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => received.some((message) => isRecord(message) && message.kind === "task"));
    expect(received[0]).toMatchObject({ kind: "ready", allowWrites: true });
    expect(received.find((message) => isRecord(message) && message.kind === "task")).toMatchObject({
      kind: "task", approval: { taskId: writeTask.id, requestId: "approved-123456789012", expectedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
      task: { kind: "write", operation: "message.send" }
    });
    host.close();
  });

  it("replaces mismatched account/context results with a bounded failure receipt", async () => {
    const accountTask = { ...readTask, id: "wrong-account" };
    const contextTask = { ...readTask, id: "wrong-context" };
    const input = new PassThrough();
    const output = new PassThrough();
    const client = bridgeClient([accountTask, contextTask]);
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const received = readFrames(output);
    await host.start();
    input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => received.filter((message) => isRecord(message) && message.kind === "task").length === 2);
    const result = (username: string) => ({
      source: "browser", nativeRef: "/direct/t/thread-7/", accountBinding, capturedAt: new Date().toISOString(),
      availability: "ready", coverage: "partial", historyCompleteness: "limited",
      data: { username, messages: [] }, errors: []
    });
    input.write(encodeNativeFrame({ kind: "result", taskId: accountTask.id, result: result("someone-else"), contextHash: accountTask.contextHash }));
    input.write(encodeNativeFrame({ kind: "result", taskId: contextTask.id, result: result("alexfisenkov"), contextHash: "stale-context" }));
    await waitFor(() => vi.mocked(client.submit).mock.calls.length === 2);
    for (const [bridgeId, , receipt, contextHash] of vi.mocked(client.submit).mock.calls) {
      expect(bridgeId).toBe("bridge-1");
      expect(receipt).toMatchObject({ availability: "unsupported_ui_version", coverage: "unknown" });
      expect(contextHash).toBe("context-1");
    }
    host.close();
  });

  it("rejects caller-supplied selectors, script keys, and account-mismatched bridge tasks", async () => {
    const unsafe = { ...readTask, payload: { selector: "body" } } as BridgeTask;
    const wrongAccount = { ...readTask, accountBinding: "owner:other" } as BridgeTask;
    const input = new PassThrough();
    const output = new PassThrough();
    const client = bridgeClient([unsafe, wrongAccount]);
    const logs: string[] = [];
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: (line) => logs.push(line) });
    const received = readFrames(output);
    await host.start();
    input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
    await waitFor(() => logs.length >= 2);
    expect(received.some((message) => isRecord(message) && message.kind === "task")).toBe(false);
    expect(client.submit).not.toHaveBeenCalled();
    host.close();
  });

  it("completes a real outbound register, heartbeat, poll, and result round-trip on localhost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-browser-bridge-"));
    const storagePath = join(directory, "hub.json");
    const configPath = join(directory, "bridge.json");
    const secret = "b".repeat(40);
    const port = await freePort();
    const hub = new CompanionHub({ storagePath });
    const listener = await startHttpServer({
      host: "127.0.0.1", port, bearerSecret: secret,
      allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [], maxRequestBytes: 1_048_576, hub
    });
    try {
      await writeFile(configPath, JSON.stringify({
        baseUrl: `http://127.0.0.1:${port}`, bearerToken: secret, mode: "browser_native_host", source: "browser",
        accountBinding, capabilities: ["inbox.list"]
      }), { mode: 0o600 });
      await ensurePrivateFile(configPath);
      const client = new OutboundBridgeClient({
        baseUrl: `http://127.0.0.1:${port}`, bearerToken: secret, mode: "browser_native_host", source: "browser",
        accountBinding, capabilities: ["inbox.list"], credentialsPath: configPath, allowLoopbackHttpForTests: true
      });
      const registration = await client.register();
      await client.heartbeat(registration.bridgeId);
      const task = await hub.enqueue({ kind: "read", source: "browser", accountBinding, operation: "inbox.list", payload: { limit: 3 }, targetRefs: [] });
      const polled = await client.poll(registration.bridgeId, 10);
      expect(polled).toHaveLength(1);
      expect(polled[0]).toMatchObject({ id: task.id, source: "browser", accountBinding, operation: "inbox.list" });
      const result = {
        source: "browser", nativeRef: "/direct/inbox/", accountBinding, capturedAt: new Date().toISOString(),
        availability: "ready", coverage: "partial", historyCompleteness: "limited",
        data: { username: "alexfisenkov", items: [{ nativeId: "thread-7", unread: true, unanswered: "unknown" }] }, errors: []
      };
      await client.submit(registration.bridgeId, task.id, result);
      expect(await hub.result(task.id)).toMatchObject({ status: "complete", result });
    } finally {
      await listener.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function bridgeClient(tasks: BridgeTask[]): BrowserBridgeClient {
  return {
    register: vi.fn(async () => ({ bridgeId: "bridge-1" })),
    heartbeat: vi.fn(async () => {}),
    poll: vi.fn(async () => tasks),
    submit: vi.fn(async () => {})
  };
}

function readFrames(stream: PassThrough): unknown[] {
  const decoder = new NativeFrameDecoder();
  const messages: unknown[] = [];
  stream.on("data", (chunk) => messages.push(...decoder.push(chunk)));
  return messages;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error("timed out waiting for browser host event");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
