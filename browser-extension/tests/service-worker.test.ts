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

  it.each(["account.inspect", "inbox.list"])("creates one fixed inactive Direct tab for zero-tab %s and waits for load before ping", async (operation) => {
    const instagramTab = { id: 91, url: "https://www.instagram.com/direct/inbox/", status: "loading" };
    const fixture = workerFixture({
      onTabsQuery: async () => [],
      onCreateTab: async (properties) => {
        expect(properties).toEqual({ url: "https://www.instagram.com/direct/inbox/", active: false });
        return instagramTab;
      },
      onGetTab: async () => instagramTab,
      onSendMessage: async (_tabId, message) => message.kind === "ping"
        ? { kind: "pong", version: 1 }
        : { source: "browser", accountBinding, availability: "ready", coverage: "complete", data: { username: "alexfisenkov" }, errors: [] }
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = { id: `task-bootstrap-zero-tab-${operation}`, kind: "read", source: "browser", bridgeId: "bridge-1", operation,
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    const processing = fixture.nativeMessage({ kind: "task", task });

    await waitFor(() => fixture.updatedListenerCount === 1);
    expect(fixture.createTab).toHaveBeenCalledOnce();
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    fixture.updateTab(91, { status: "complete" });
    await processing;

    expect(fixture.createTab).toHaveBeenCalledOnce();
    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe"]);
    expect(fixture.sendMessage.mock.calls.every(([tabId]) => tabId === 91)).toBe(true);
    expect(fixture.updatedListenerCount).toBe(0);
    expect(fixture.portMessages[0]?.some((message) => message?.kind === "result" && message.taskId === task.id)).toBe(true);
  });

  it("bootstraps a zero-tab account inspection through the actual Native Host ready frame", async () => {
    const task: BridgeTask = { id: "task-native-ready-bootstrap", kind: "read", source: "browser", bridgeId: "bridge-native-bootstrap",
      operation: "account.inspect", accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    let delivered = false;
    const input = new PassThrough();
    const output = new PassThrough();
    const client = { register: vi.fn(async () => ({ bridgeId: task.bridgeId })), heartbeat: vi.fn(async () => {}),
      poll: vi.fn(async () => { if (delivered) return []; delivered = true; return [task]; }), submit: vi.fn(async () => {}) };
    const tab = { id: 97, url: "https://www.instagram.com/direct/inbox/", status: "complete" };
    const host = createBrowserNativeHost({ client, accountBinding, expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 30_000, log: vi.fn() });
    let worker: ReturnType<typeof workerFixture> | undefined;
    let forwardWorkerMessages = false;
    const decoder = new NativeFrameDecoder();
    output.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) if (worker) void worker.nativeMessage(message);
    });
    try {
      await host.start();
      worker = workerFixture({
        onPostMessage: (message) => { if (forwardWorkerMessages) input.write(encodeNativeFrame(message)); },
        onTabsQuery: async () => [], onCreateTab: async () => tab,
        onSendMessage: async (_tabId, message) => {
          if (message.kind === "ping") return { kind: "pong", version: 1 };
          return { source: "browser", nativeRef: "/direct/inbox/", accountBinding, capturedAt: new Date().toISOString(),
            availability: "ready", coverage: "complete", historyCompleteness: "not_applicable",
            data: { username: "alexfisenkov", accountBinding, loggedIn: true, surface: "instagram", capabilities: ["account.inspect", "inbox.list"] }, errors: [] };
        }
      });
      forwardWorkerMessages = true;
      for (const message of worker.startupMessages) input.write(encodeNativeFrame(message));
      await waitFor(() => vi.mocked(client.submit).mock.calls.length === 1);

      expect(worker.createTab).toHaveBeenCalledWith({ url: "https://www.instagram.com/direct/inbox/", active: false });
      expect(worker.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe"]);
      expect(worker.sendMessage).toHaveBeenLastCalledWith(97, expect.objectContaining({ kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", operation: { op: "account.inspect" } }));
      expect(client.submit).toHaveBeenCalledWith(task.bridgeId, task.id, expect.objectContaining({ availability: "ready", accountBinding }), undefined);
    } finally {
      await host.close();
      input.end();
      output.end();
    }
  });

  it("shares one in-flight tab creation across concurrent inspect reads", async () => {
    let markCreateStarted!: () => void;
    let releaseCreate!: (tab: { id: number; url: string; status: string }) => void;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    const createGate = new Promise<{ id: number; url: string; status: string }>((resolve) => { releaseCreate = resolve; });
    const tab = { id: 92, url: "https://www.instagram.com/direct/inbox/", status: "loading" };
    const fixture = workerFixture({
      onTabsQuery: async () => [],
      onCreateTab: async () => { markCreateStarted(); return createGate; },
      onGetTab: async () => tab,
      onSendMessage: async (_tabId, message) => message.kind === "ping"
        ? { kind: "pong", version: 1 }
        : { source: "browser", accountBinding, availability: "ready", coverage: "complete", data: { username: "alexfisenkov" }, errors: [] }
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = (id: string) => ({ id, kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() });
    const first = fixture.nativeMessage({ kind: "task", task: task("task-bootstrap-shared-a") });
    const second = fixture.nativeMessage({ kind: "task", task: task("task-bootstrap-shared-b") });
    await createStarted;
    expect(fixture.createTab).toHaveBeenCalledOnce();
    releaseCreate(tab);
    await waitFor(() => fixture.updatedListenerCount === 1);
    fixture.updateTab(92, { status: "complete" });
    await Promise.all([first, second]);
    expect(fixture.createTab).toHaveBeenCalledOnce();
    expect(fixture.sendMessage.mock.calls.filter(([, message]) => message.kind === "observe")).toHaveLength(2);
  });

  it.each(["before create completes", "after tab creation while loading"])("does not dispatch or redeliver after native disconnect %s", async (stage) => {
    let markCreateStarted!: () => void;
    let releaseCreate!: (tab: { id: number; url: string; status: string }) => void;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    const createGate = new Promise<{ id: number; url: string; status: string }>((resolve) => { releaseCreate = resolve; });
    const tab = { id: 93, url: "https://www.instagram.com/direct/inbox/", status: "loading" };
    const fixture = workerFixture({
      onTabsQuery: async () => [],
      onCreateTab: async () => {
        markCreateStarted();
        return stage === "before create completes" ? createGate : tab;
      },
      onGetTab: async () => tab,
      onSendMessage: async (_tabId, message) => message.kind === "ping" ? { kind: "pong", version: 1 } : { source: "browser", accountBinding, availability: "ready", data: { username: "owner" } }
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = { id: `task-bootstrap-disconnect-${stage.replaceAll(" ", "-")}`, kind: "read", source: "browser", bridgeId: "bridge-1",
      operation: "account.inspect", accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    const processing = fixture.nativeMessage({ kind: "task", task });
    await createStarted;
    if (stage === "after tab creation while loading") await waitFor(() => fixture.updatedListenerCount === 1);
    fixture.disconnect(0);
    await fixture.fireAlarm("instagram-native-reconnect");
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false }, 1);
    if (stage === "before create completes") releaseCreate(tab);
    else fixture.updateTab(93, { status: "complete" });
    await processing;

    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.portMessages.flat().some((message) => message?.kind === "result" && message.taskId === task.id)).toBe(false);
    expect(fixture.updatedListenerCount).toBe(0);
  });

  it("does not create a Direct tab for a preview or a stale conversation target", async () => {
    const fixture = workerFixture({ onTabsQuery: async () => [] });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const preview = { id: "task-bootstrap-no-preview", kind: "preview", source: "browser", bridgeId: "bridge-1", operation: "message.send",
      accountBinding, targetRefs: [{ accountBinding, nativeId: "thread-7" }], payload: { text: "not dispatched" }, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    await fixture.nativeMessage({ kind: "task", task: preview });
    const conversation = { ...preview, id: "task-bootstrap-no-conversation", kind: "read", operation: "conversation.read", payload: {} };
    await fixture.nativeMessage({ kind: "task", task: conversation });
    expect(fixture.createTab).not.toHaveBeenCalled();
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    for (const task of [preview, conversation]) {
      expect(fixture.portMessages[0]?.find((message) => message?.kind === "result" && message.taskId === task.id)?.result.errors[0]?.code)
        .toBe("browser_bootstrap_not_eligible");
    }
  });

  it("does not create a tab when Instagram tab selection is ambiguous", async () => {
    const fixture = workerFixture({ onTabsQuery: async () => [
      { id: 1, url: "https://www.instagram.com/direct/inbox/" },
      { id: 2, url: "https://www.instagram.com/direct/inbox/" }
    ] });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = { id: "task-bootstrap-ambiguous", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    await fixture.nativeMessage({ kind: "task", task });
    expect(fixture.createTab).not.toHaveBeenCalled();
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.portMessages[0]?.some((message) => message?.kind === "result" && message.taskId === task.id && message.result?.availability === "needs_selection")).toBe(true);
    expect(fixture.portMessages[0]?.find((message) => message?.kind === "result" && message.taskId === task.id)?.result.errors[0]?.code)
      .toBe("browser_tab_selection_ambiguous");
  });

  it("reports a fixed non-PII stage when tab creation is refused", async () => {
    const fixture = workerFixture({ onTabsQuery: async () => [], onCreateTab: async () => { throw new Error("private browser detail"); } });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = { id: "task-bootstrap-create-failed", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    await fixture.nativeMessage({ kind: "task", task });
    const result = fixture.portMessages[0]?.find((message) => message?.kind === "result" && message.taskId === task.id)?.result;
    expect(result).toMatchObject({ availability: "needs_selection", errors: [{ code: "browser_bootstrap_create_failed" }] });
    expect(JSON.stringify(result)).not.toContain("private browser detail");
  });

  it("reports a fixed load stage and removes the tab listener when load fails", async () => {
    const tab = { id: 98, url: "https://www.instagram.com/direct/inbox/", status: "loading" };
    const fixture = workerFixture({ onTabsQuery: async () => [], onCreateTab: async () => tab,
      onGetTab: async () => { throw new Error("private tab detail"); } });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = { id: "task-bootstrap-load-failed", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    await fixture.nativeMessage({ kind: "task", task });
    const result = fixture.portMessages[0]?.find((message) => message?.kind === "result" && message.taskId === task.id)?.result;
    expect(result).toMatchObject({ availability: "needs_selection", errors: [{ code: "browser_bootstrap_load_failed" }] });
    expect(JSON.stringify(result)).not.toContain("private tab detail");
    expect(fixture.updatedListenerCount).toBe(0);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });

  it("stops waiting for an unready login tab at the task deadline and preserves needs_selection", async () => {
    vi.useFakeTimers();
    try {
      const tab = { id: 94, url: "https://www.instagram.com/direct/inbox/", status: "loading" };
      const fixture = workerFixture({ onTabsQuery: async () => [], onCreateTab: async () => tab, onGetTab: async () => tab });
      await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
      const task = { id: "task-bootstrap-deadline", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
        accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 100).toISOString() };
      const processing = fixture.nativeMessage({ kind: "task", task });
      for (let step = 0; step < 100 && fixture.updatedListenerCount !== 1; step += 1) await Promise.resolve();
      expect(fixture.updatedListenerCount).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await processing;
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(fixture.updatedListenerCount).toBe(0);
      expect(fixture.portMessages[0]?.some((message) => message?.kind === "result" && message.taskId === task.id &&
        message.result?.errors?.[0]?.code === "task_deadline_expired")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("does not dispatch if fixed tab creation itself exceeds the read deadline", async () => {
    vi.useFakeTimers();
    let markCreateStarted!: () => void;
    let releaseCreate!: (tab: { id: number; url: string; status: string }) => void;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    const createGate = new Promise<{ id: number; url: string; status: string }>((resolve) => { releaseCreate = resolve; });
    const fixture = workerFixture({ onTabsQuery: async () => [], onCreateTab: async () => { markCreateStarted(); return createGate; } });
    try {
      await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
      const task = { id: "task-bootstrap-create-deadline", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
        accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 100).toISOString() };
      const processing = fixture.nativeMessage({ kind: "task", task });
      await createStarted;
      await vi.advanceTimersByTimeAsync(100);
      await processing;
      releaseCreate({ id: 96, url: "https://www.instagram.com/direct/inbox/", status: "loading" });
      for (let step = 0; step < 20; step += 1) await Promise.resolve();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(fixture.updatedListenerCount).toBe(0);
      expect(fixture.createTab).toHaveBeenCalledOnce();
      expect(fixture.portMessages[0]?.filter((message) => message?.kind === "result" && message.taskId === task.id)).toHaveLength(1);
      expect(fixture.portMessages[0]?.find((message) => message?.kind === "result" && message.taskId === task.id)?.result)
        .toMatchObject({ availability: "offline", errors: [{ code: "task_deadline_expired" }] });
    } finally {
      releaseCreate({ id: 96, url: "https://www.instagram.com/direct/inbox/", status: "loading" });
      vi.useRealTimers();
    }
  });

  it("does not retry bootstrap when the created tab is signed out or unsupported", async () => {
    const tab = { id: 95, url: "https://www.instagram.com/direct/inbox/", status: "complete" };
    const fixture = workerFixture({ onTabsQuery: async () => [], onCreateTab: async () => tab,
      onSendMessage: async (_tabId, message) => message.kind === "ping" ? { kind: "pong", version: 1 }
        : { source: "browser", accountBinding, availability: "needs_selection", coverage: "unknown", errors: [{ code: "owner_marker_missing", message: "not signed in" }] } });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const task = { id: "task-bootstrap-login-not-ready", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    await fixture.nativeMessage({ kind: "task", task });
    expect(fixture.createTab).toHaveBeenCalledOnce();
    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe"]);
    expect(fixture.portMessages[0]?.some((message) => message?.kind === "result" && message.taskId === task.id &&
      message.result?.availability === "needs_selection")).toBe(true);
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
    expect(fixture.sendMessage).toHaveBeenCalledTimes(6);
    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe", "ping", "observe", "ping", "execute"]);
  });

  it("injects the fixed listener once only after an exact no-receiver ping, then dispatches the operation once", async () => {
    let firstPing = true;
    const executeScript = vi.fn(async () => [{ result: undefined }]);
    const fixture = workerFixture({
      onSendMessage: async (_tabId, message) => {
        if (message.kind === "ping" && firstPing) {
          firstPing = false;
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        if (message.kind === "ping") return { kind: "pong", version: 1 };
        return { status: "ready", availability: "ready", accountBinding, data: { username: "alexfisenkov" } };
      },
      executeScript
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-inspect-after-injection", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "account.inspect",
      accountBinding, targetRefs: [], payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });

    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "ping", "observe"]);
    expect(executeScript).toHaveBeenCalledOnce();
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ["content-script.js"] });
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "result", taskId: "task-inspect-after-injection", result: expect.objectContaining({ data: { username: "alexfisenkov" } })
    }));
  });

  it("does not inject or dispatch when ping failure is not the exact no-receiver condition", async () => {
    const executeScript = vi.fn(async () => []);
    const fixture = workerFixture({
      onSendMessage: async () => { throw new Error("The message port closed before a response was received."); },
      executeScript
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-port-closed-ping", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "inbox.list",
      accountBinding, targetRefs: [], payload: { limit: 2 }, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });

    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping"]);
    expect(executeScript).not.toHaveBeenCalled();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "result", taskId: "task-port-closed-ping", result: expect.objectContaining({ availability: "unsupported_ui_version" })
    }));
  });

  it("fails closed when fixed-script injection does not produce a pong", async () => {
    let pingCount = 0;
    const executeScript = vi.fn(async () => []);
    const fixture = workerFixture({
      onSendMessage: async (_tabId, message) => {
        if (message.kind !== "ping") return { status: "ready" };
        pingCount++;
        if (pingCount === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
        return { kind: "unexpected", version: 1 };
      },
      executeScript
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-injection-no-pong", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "inbox.list",
      accountBinding, targetRefs: [], payload: { limit: 2 }, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });

    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "ping"]);
    expect(executeScript).toHaveBeenCalledOnce();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "result", taskId: "task-injection-no-pong", result: expect.objectContaining({
        availability: "unsupported_ui_version", errors: [{ code: "content_script_unavailable", message: expect.any(String) }]
      })
    }));
  });

  it.each(["tab query", "ping", "script injection"])("does not dispatch a task after its native port disconnects during %s", async (stage) => {
    let markStageStarted!: () => void;
    let releaseStage!: () => void;
    const stageStarted = new Promise<void>((resolve) => { markStageStarted = resolve; });
    const stageGate = new Promise<void>((resolve) => { releaseStage = resolve; });
    let pingCount = 0;
    const fixture = workerFixture({
      onTabsQuery: async () => {
        if (stage !== "tab query") return [{ id: 1, url: "https://www.instagram.com/direct/t/thread-7/" }];
        markStageStarted();
        await stageGate;
        return [{ id: 1, url: "https://www.instagram.com/direct/t/thread-7/" }];
      },
      onSendMessage: async (_tabId, message) => {
        if (message.kind === "ping") {
          pingCount++;
          if (stage === "ping") {
            markStageStarted();
            await stageGate;
          }
          if (stage === "script injection" && pingCount === 1) {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
          return { kind: "pong", version: 1 };
        }
        return { availability: "ready", accountBinding, data: { items: [] }, errors: [] };
      },
      executeScript: vi.fn(async () => {
        if (stage === "script injection") {
          markStageStarted();
          await stageGate;
        }
        return [];
      })
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    const processing = fixture.nativeMessage({ kind: "task", task: {
      id: `task-disconnect-${stage.replaceAll(" ", "-")}`, kind: "read", source: "browser", bridgeId: "bridge-1", operation: "inbox.list",
      accountBinding, targetRefs: [], payload: { limit: 2 }, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });

    await stageStarted;
    fixture.disconnect(0);
    await fixture.fireAlarm("instagram-native-reconnect");
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false }, 1);
    releaseStage();
    await processing;

    expect(fixture.sendMessage.mock.calls.filter(([, message]) => message.kind === "observe")).toHaveLength(0);
    if (stage === "script injection") expect(fixture.scripting.executeScript).toHaveBeenCalledOnce();
    else expect(fixture.scripting.executeScript).not.toHaveBeenCalled();
    expect(fixture.portMessages.flat().some((message) => message?.kind === "result" && message.taskId === `task-disconnect-${stage.replaceAll(" ", "-")}`)).toBe(false);
  });

  it("binds an ephemeral inbox ref to its originating bridge and selected tab", async () => {
    const rowRef = "browser-inbox-row:opaque-row-ref";
    const fixture = workerFixture({
      onTabsQuery: async () => [{ id: 9, url: "https://www.instagram.com/direct/inbox/" }],
      onSendMessage: async (_tabId, message) => {
        if (message.kind === "ping") return { kind: "pong", version: 1 };
        if (message.operation.op === "inbox.list") return { source: "browser", nativeRef: "/direct/inbox/", accountBinding,
          capturedAt: new Date().toISOString(), availability: "ready", coverage: "partial", historyCompleteness: "limited",
          data: { items: [{ target: { accountBinding, explicitOwnerRef: rowRef }, unread: "unknown", unanswered: "unknown" }] }, errors: [] };
        return { source: "browser", nativeRef: "/direct/t/observed-thread/", accountBinding,
          capturedAt: new Date().toISOString(), availability: "ready", coverage: "unknown", historyCompleteness: "limited",
          sideEffects: ["may_mark_seen"], data: { threadNativeId: "observed-thread", messages: [] }, errors: [] };
      }
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-inbox-ref-origin", kind: "read", source: "browser", bridgeId: "bridge-mac", operation: "inbox.list",
      accountBinding, targetRefs: [], payload: { limit: 2 }, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });

    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-inbox-ref-wrong-bridge", kind: "read", source: "browser", bridgeId: "bridge-server", operation: "conversation.read",
      accountBinding, targetRefs: [{ accountBinding, explicitOwnerRef: rowRef }], payload: { limit: 2 }, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });
    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe"]);
    expect(fixture.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-inbox-ref-wrong-bridge", result: expect.objectContaining({ availability: "needs_selection" })
    }));

    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-inbox-ref-no-write-id", kind: "preview", source: "browser", bridgeId: "bridge-mac", operation: "message.send",
      accountBinding, targetRefs: [{ accountBinding, explicitOwnerRef: rowRef }], payload: { text: "must not dispatch" }, contextHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });
    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe"]);
    expect(fixture.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-inbox-ref-no-write-id", result: expect.objectContaining({ availability: "unsupported" })
    }));

    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-inbox-ref-selected-bridge", kind: "read", source: "browser", bridgeId: "bridge-mac", operation: "conversation.read",
      accountBinding, targetRefs: [{ accountBinding, explicitOwnerRef: rowRef }], payload: { limit: 2 }, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });
    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe", "ping", "observe"]);
    expect(fixture.sendMessage.mock.calls[3]).toMatchObject([9, { operation: { op: "thread.read", target: { accountBinding, explicitOwnerRef: rowRef } } }]);
  });

  it("requires a fresh inbox ref after service-worker restart clears tab bindings", async () => {
    const fixture = workerFixture();
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-ref-after-worker-restart", kind: "read", source: "browser", bridgeId: "bridge-mac", operation: "conversation.read",
      accountBinding, targetRefs: [{ accountBinding, explicitOwnerRef: "browser-inbox-row:ref-from-before-restart" }], payload: { limit: 2 },
      expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });

    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-ref-after-worker-restart", result: expect.objectContaining({ availability: "needs_selection" })
    }));
  });

  it("does not reinject or replay an operation after its actual dispatch fails", async () => {
    const executeScript = vi.fn(async () => []);
    const fixture = workerFixture({
      onSendMessage: async (_tabId, message) => {
        if (message.kind === "ping") return { kind: "pong", version: 1 };
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
      executeScript
    });
    await fixture.nativeMessage({ kind: "ready", version: 1, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false });
    await fixture.nativeMessage({ kind: "task", task: {
      id: "task-operation-lost", kind: "read", source: "browser", bridgeId: "bridge-1", operation: "inbox.list",
      accountBinding, targetRefs: [], payload: { limit: 2 }, expiresAt: new Date(Date.now() + 20_000).toISOString()
    } });

    expect(fixture.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "observe"]);
    expect(executeScript).not.toHaveBeenCalled();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "result", taskId: "task-operation-lost", result: expect.objectContaining({ availability: "unsupported_ui_version" })
    }));
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
    expect(worker.sendMessage).toHaveBeenCalledTimes(2);
    expect(worker.sendMessage.mock.calls.map(([, message]) => message.kind)).toEqual(["ping", "execute"]);
    expect(worker.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ kind: "execute", allowWrites: true }));
    expect(client.submit).toHaveBeenCalledWith(task.bridgeId, task.id,
      { status: "OUTCOME_UNKNOWN", requestId: task.requestId, contextHash: task.contextHash }, task.contextHash);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(worker.sendMessage).toHaveBeenCalledTimes(2);
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

function workerFixture(options: {
  response?: unknown;
  onPostMessage?: (message: unknown) => void;
  onTabsQuery?: () => Promise<Array<{ id: number; url: string }>>;
  onCreateTab?: (properties: { url: string; active: boolean }) => Promise<{ id: number; url: string; status: string }>;
  onGetTab?: (tabId: number) => Promise<{ id: number; url: string; status: string } | undefined>;
  onSendMessage?: (tabId: number, message: any) => Promise<unknown>;
  executeScript?: ReturnType<typeof vi.fn>;
} = {}) {
  const listeners: Array<Array<(message: unknown) => unknown>> = [];
  const disconnectListeners: Array<Array<() => void>> = [];
  const portMessages: unknown[][] = [];
  const alarmListeners: Array<(alarm: { name: string }) => unknown> = [];
  const sendMessage = vi.fn(async (tabId: number, message: any) => {
    if (options.onSendMessage) return options.onSendMessage(tabId, message);
    if (message.kind === "ping") return { kind: "pong", version: 1 };
    return options.response ?? ({ status: "OUTCOME_UNKNOWN", requestId: "request-123456789012", contextHash: "a".repeat(64) });
  });
  const postMessage = vi.fn((message: unknown) => options.onPostMessage?.(message));
  const connectNative = vi.fn(() => {
    const portIndex = listeners.length;
    listeners.push([]);
    disconnectListeners.push([]);
    portMessages.push([]);
    const portPostMessage = vi.fn((message: unknown) => {
      portMessages[portIndex]!.push(message);
      postMessage(message);
    });
    return {
      onMessage: { addListener: (listener: (message: unknown) => unknown) => listeners[portIndex]!.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners[portIndex]!.push(listener) }, postMessage: portPostMessage
    };
  });
  const alarms = { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: { addListener: (listener: (alarm: { name: string }) => unknown) => alarmListeners.push(listener) } };
  const scripting = { executeScript: options.executeScript ?? vi.fn(async () => []) };
  const updatedListeners = new Set<(tabId: number, changeInfo: Record<string, unknown>, tab: { id: number; url: string; status: string }) => void>();
  const tabsById = new Map<number, { id: number; url: string; status: string }>();
  const createTab = vi.fn(async (properties: { url: string; active: boolean }) => {
    const tab = options.onCreateTab ? await options.onCreateTab(properties) : { id: 999, url: properties.url, status: "complete" };
    tabsById.set(tab.id, tab);
    return tab;
  });
  const getTab = vi.fn(async (tabId: number) => options.onGetTab ? options.onGetTab(tabId) : tabsById.get(tabId));
  const chrome = {
    runtime: {
      onStartup: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() },
      connectNative
    },
    alarms,
    tabs: {
      query: vi.fn(async () => options.onTabsQuery ? options.onTabsQuery() : [{ id: 1, url: "https://www.instagram.com/direct/t/thread-7/", status: "complete" }]),
      create: createTab, get: getTab, onUpdated: { addListener: (listener: (tabId: number, changeInfo: Record<string, unknown>, tab: { id: number; url: string; status: string }) => void) => updatedListeners.add(listener),
        removeListener: (listener: (tabId: number, changeInfo: Record<string, unknown>, tab: { id: number; url: string; status: string }) => void) => updatedListeners.delete(listener) },
      sendMessage
    },
    scripting
  };
  vm.runInNewContext(source, { chrome, URL, Date, Object, Set, Map, Array, Promise, RegExp, String, Number, Boolean, setTimeout, clearTimeout });
  return {
    sendMessage, postMessage, connectNative, alarms, scripting, portMessages, createTab,
    get updatedListenerCount() { return updatedListeners.size; },
    updateTab(tabId: number, changeInfo: Partial<{ url: string; status: string }>) {
      const previous = tabsById.get(tabId) ?? { id: tabId, url: "https://www.instagram.com/direct/inbox/", status: "loading" };
      const updated = { ...previous, ...changeInfo };
      tabsById.set(tabId, updated);
      for (const listener of [...updatedListeners]) listener(tabId, changeInfo, updated);
    },
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
