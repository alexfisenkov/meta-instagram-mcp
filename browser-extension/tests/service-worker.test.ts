import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintIntent } from "../../src/action-safety.js";
import { createBrowserNativeHost } from "../../src/companion/browser-native-host.js";
import type { BridgeTask } from "../../src/companion-hub.js";
import { NativeFrameDecoder, encodeNativeFrame } from "../../src/companion/native-framing.js";
import { createUiApprovalAuthority, verifyUiApproval } from "../../src/ui-approval.js";

const source = await readFile(resolve(process.cwd(), "browser-extension/service-worker.js"), "utf8");
const manifest = JSON.parse(await readFile(resolve(process.cwd(), "browser-extension/manifest.json"), "utf8")) as { permissions: string[] };
const accountBinding = "owner:alex";
const approvalDirs: string[] = [];

afterEach(async () => {
  await Promise.all(approvalDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Instagram extension service worker protocol", () => {
  it("reconnects a disconnected native host through one bounded MV3 alarm", async () => {
    expect(manifest.permissions).toContain("alarms");
    const fixture = workerFixture();
    expect(fixture.connectNative).toHaveBeenCalledOnce();

    fixture.disconnect(0);

    expect(fixture.alarms.create).toHaveBeenCalledWith("instagram-native-reconnect", { delayInMinutes: 0.5 });
    fixture.disconnect(0);
    expect(fixture.alarms.create).toHaveBeenCalledTimes(1);
    expect(fixture.connectNative).toHaveBeenCalledOnce();

    await fixture.fireAlarm("instagram-native-reconnect");
    expect(fixture.connectNative).toHaveBeenCalledTimes(2);
    await fixture.fireAlarm("instagram-native-reconnect");
    expect(fixture.connectNative).toHaveBeenCalledTimes(2);

    fixture.disconnect(1);
    expect(fixture.alarms.create).toHaveBeenLastCalledWith("instagram-native-reconnect", { delayInMinutes: 1 });
  });

  it("routes account inspection and one approved write lease to fixed content operations", async () => {
    const fixture = workerFixture();
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-account-123456789", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });
    expect(fixture.sendMessage).toHaveBeenLastCalledWith(1, expect.objectContaining({
      kind: "observe", operation: { op: "account.inspect" }, accountBinding, expectedAccountHandle: "alexfisenkov"
    }));
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-snapshot-123456789", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.snapshot",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });
    expect(fixture.sendMessage).toHaveBeenLastCalledWith(1, expect.objectContaining({
      kind: "observe", operation: { op: "account.snapshot" }, accountBinding
    }));

    const task = await approvedTask();
    const approval = await signedBrowserApproval(task);
    await fixture.nativeMessage({ kind: "task", task, approval });
    expect(fixture.sendMessage).toHaveBeenLastCalledWith(1, expect.objectContaining({
      kind: "execute", allowWrites: true,
      operation: expect.objectContaining({ op: "message.send", target: { accountBinding, nativeId: "thread-7" }, payload: { text: "Exact text" }, contextHash: task.contextHash, approval })
    }));
    expect(fixture.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not start browser UI work for an expired read task", async () => {
    const fixture = workerFixture();
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-expired-read", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "conversation.read",
      accountBinding, targetRefs: [{ accountBinding, nativeId: "thread-7" }], payload: { limit: 20 },
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    } });

    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "result", taskId: "task-expired-read", result: expect.objectContaining({ availability: "offline", errors: [expect.objectContaining({ code: "task_deadline_expired" })] })
    }));
  });

  it("rechecks read expiry after asynchronous tab selection", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 100).toISOString();
    const fixture = workerFixture({ onTabsQuery: async () => {
      await vi.advanceTimersByTimeAsync(200);
      return [{ id: 1, url: "https://www.instagram.com/direct/t/thread-7/" }];
    } });
    try {
      await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true });
      await fixture.nativeMessage({ kind: "task", task: {
        id: "task-expiring-read", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "conversation.read",
        accountBinding, targetRefs: [{ accountBinding, nativeId: "thread-7" }], payload: { limit: 20 }, expiresAt
      } });

      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        kind: "result", taskId: "task-expiring-read", result: expect.objectContaining({ availability: "offline", errors: [expect.objectContaining({ code: "task_deadline_expired" })] })
      }));
    } finally { vi.useRealTimers(); }
  });

  it("does not dispatch when write gating is off or a signed approved task is stale", async () => {
    const fixture = workerFixture();
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = await approvedTask();
    await fixture.nativeMessage({ kind: "task", task, approval: await signedBrowserApproval(task) });
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "result", taskId: task.id }));

    const staleFixture = workerFixture();
    await staleFixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true });
    const staleTask = await approvedTask(new Date(Date.now() - 1_000).toISOString());
    await staleFixture.nativeMessage({ kind: "task", task: staleTask, approval: await signedBrowserApproval(staleTask) });
    expect(staleFixture.sendMessage).not.toHaveBeenCalled();
    expect(staleFixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "result", taskId: staleTask.id }));
  });

  it("round-trips one leased browser mutation through the native host and service worker without retry", async () => {
    const task = await approvedTask();
    const authority = await approvalAuthority();
    const signed = authority.sign(task);
    const input = new PassThrough();
    const output = new PassThrough();
    const client = { register: vi.fn(async () => ({ bridgeId: task.bridgeId })), heartbeat: vi.fn(async () => {}),
      poll: vi.fn(async () => [task]), submit: vi.fn(async () => {}) };
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true,
      authorizeWriteLease: async (candidate, bridgeId) => {
        if (!verifyUiApproval(candidate, signed, authority.publicKey, { bridgeId, source: "browser" })) return undefined;
        return flattenApproval(signed);
      },
      input, output, pollIntervalMs: 250, log: vi.fn() });
    const worker = workerFixture({ response: { status: "OUTCOME_UNKNOWN", requestId: task.requestId, contextHash: task.contextHash },
      onPostMessage: (message) => input.write(encodeNativeFrame(message)) });
    const decoder = new NativeFrameDecoder();
    output.on("data", (chunk) => { for (const message of decoder.push(chunk)) void worker.nativeMessage(message); });
    await host.start();
    for (const message of worker.startupMessages) input.write(encodeNativeFrame(message));
    await waitFor(() => client.submit.mock.calls.length === 1);
    expect(worker.sendMessage).toHaveBeenCalledTimes(1);
    expect(worker.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ kind: "execute", allowWrites: true }));
    expect(client.submit).toHaveBeenCalledWith(task.bridgeId, task.id,
      { status: "OUTCOME_UNKNOWN", requestId: task.requestId, contextHash: task.contextHash }, task.contextHash);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(worker.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.submit).toHaveBeenCalledTimes(1);
    host.close();
  });

  it("does not forward a forged browser write grant", async () => {
    const task = await approvedTask();
    const authority = await approvalAuthority();
    const valid = authority.sign(task);
    const forgedBytes = Buffer.from(valid.signature, "base64url");
    forgedBytes[0] = forgedBytes[0]! ^ 1;
    const forged = { ...valid, signature: forgedBytes.toString("base64url") };
    expect(verifyUiApproval(task, forged, authority.publicKey, { bridgeId: task.bridgeId, source: "browser" })).toBe(false);
    expect(verifyUiApproval({ ...task, payload: { text: "Different text" } }, valid, authority.publicKey,
      { bridgeId: task.bridgeId, source: "browser" })).toBe(false);
    const client = { register: vi.fn(async () => ({ bridgeId: task.bridgeId })), heartbeat: vi.fn(async () => {}),
      poll: vi.fn(async () => [task]), submit: vi.fn(async () => {}) };
    const input = new PassThrough();
    const output = new PassThrough();
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true,
      authorizeWriteLease: async (candidate, bridgeId) => {
        if (!verifyUiApproval(candidate, forged, authority.publicKey, { bridgeId, source: "browser" })) return undefined;
        return flattenApproval(forged);
      }, input, output, pollIntervalMs: 250, log: vi.fn() });
    const worker = workerFixture({ onPostMessage: (message) => input.write(encodeNativeFrame(message)) });
    const decoder = new NativeFrameDecoder();
    output.on("data", (chunk) => { for (const message of decoder.push(chunk)) void worker.nativeMessage(message); });
    await host.start();
    for (const message of worker.startupMessages) input.write(encodeNativeFrame(message));
    await waitFor(() => client.submit.mock.calls.length === 1);
    expect(worker.sendMessage).not.toHaveBeenCalled();
    expect(client.submit).toHaveBeenCalledWith(task.bridgeId, task.id,
      { status: "FAILED", reason: "browser write task has no verified MutationSafety approval and durable attempt" }, task.contextHash);
    host.close();
  });
});

function workerFixture(options: { response?: unknown; onPostMessage?: (message: unknown) => void; onTabsQuery?: () => Promise<Array<{ id: number; url: string }>> } = {}) {
  const listeners: Array<Array<(message: unknown) => unknown>> = [];
  const disconnectListeners: Array<Array<() => void>> = [];
  const alarmListeners: Array<(alarm: { name: string }) => unknown> = [];
  const sendMessage = vi.fn(async () => options.response ?? ({ status: "OUTCOME_UNKNOWN", requestId: "request-123456789012", contextHash: "a".repeat(64) }));
  const postMessage = vi.fn((message: unknown) => options.onPostMessage?.(message));
  const connectNative = vi.fn(() => {
    const portIndex = listeners.length;
    listeners.push([]);
    disconnectListeners.push([]);
    return {
      onMessage: { addListener: (listener: (message: unknown) => unknown) => listeners[portIndex]!.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners[portIndex]!.push(listener) }, postMessage
    };
  });
  const alarms = { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: { addListener: (listener: (alarm: { name: string }) => unknown) => alarmListeners.push(listener) } };
  const chrome = {
    runtime: {
      onStartup: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() },
      connectNative
    },
    alarms,
    tabs: {
      query: vi.fn(async () => options.onTabsQuery ? options.onTabsQuery() : [{ id: 1, url: "https://www.instagram.com/direct/t/thread-7/" }]), sendMessage
    }
  };
  vm.runInNewContext(source, { chrome, URL, Date, Object, Set, Array, Promise, RegExp, String, Number, Boolean });
  return {
    sendMessage, postMessage, connectNative, alarms,
    startupMessages: postMessage.mock.calls.map(([message]) => message),
    nativeMessage: async (message: unknown, portIndex = 0) => { await listeners[portIndex]?.[0]?.(message); },
    disconnect: (portIndex: number) => { for (const listener of disconnectListeners[portIndex] ?? []) listener(); },
    fireAlarm: async (name: string) => { for (const listener of alarmListeners) await listener({ name }); }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!predicate() && Date.now() < end) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  if (!predicate()) throw new Error("timed out waiting for native browser round-trip");
}

async function approvedTask(expiresAt = new Date(Date.now() + 20_000).toISOString()): Promise<BridgeTask> {
  const bridgeId = "bridge-0123456789";
  const intent = {
    source: "browser" as const, bridgeId, accountBinding, action: "message.send" as const,
    payload: { kind: "message.send", text: "Exact text" },
    target: { accountBinding, nativeId: "thread-7" }, contextHash: "a".repeat(64)
  };
  return {
    id: "task-123456789012", kind: "write", source: "browser", bridgeId, operation: "message.send",
    accountBinding, targetRefs: [{ ...intent.target }], payload: { text: "Exact text" },
    contextHash: intent.contextHash, requestId: "request-123456789012", fingerprint: fingerprintIntent(intent), expiresAt
  };
}

async function approvalAuthority() {
  const directory = await mkdtemp(join(tmpdir(), "instagram-browser-approval-"));
  approvalDirs.push(directory);
  return createUiApprovalAuthority({
    privateKeyPath: join(directory, "approval-key.json"), projectRoot: join(directory, "project")
  });
}

async function signedBrowserApproval(task: BridgeTask) {
  const authority = await approvalAuthority();
  const signed = authority.sign(task);
  expect(verifyUiApproval(task, signed, authority.publicKey, { bridgeId: task.bridgeId, source: "browser" }))
    .toBe(Date.parse(task.expiresAt) > Date.now());
  return flattenApproval(signed);
}

function flattenApproval(signed: ReturnType<Awaited<ReturnType<typeof approvalAuthority>>["sign"]>) {
  const { claims } = signed;
  return {
    taskId: claims.taskId, bridgeId: claims.bridgeId, requestId: claims.requestId,
    fingerprint: claims.fingerprint, expectedFingerprint: claims.fingerprint, contextHash: claims.contextHash,
    expiresAt: claims.expiresAt, source: claims.source, accountBinding: claims.accountBinding,
    operation: claims.operation, target: claims.target, payloadHash: claims.payloadHash, signature: signed.signature
  };
}
