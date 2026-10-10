import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeTask } from "../src/companion-hub.js";
import { createPhoneCompanion, type PhoneBridgeClient, type PhoneAppiumLifecycle } from "../src/companion/phone.js";
import type { PhoneUiProvider } from "../src/providers/phone-ui.js";
import { createUiApprovalAuthority } from "../src/ui-approval.js";
import { CompanionHub } from "../src/companion-hub.js";
import { createCompanionSourceProvider } from "../src/companion-source-provider.js";

const accountObservation = { source: "phone" as const, nativeRef: "phone:profile", accountBinding: "acct:fixture", capturedAt: "2026-10-06T12:00:00Z", availability: "ready" as const, coverage: "partial" as const, historyCompleteness: "not_applicable" as const, data: { username: "fixture" }, errors: [] };
const appium = (availability: "ready" | "not_connected" = "ready") => {
  let created = false;
  return {
    readiness: vi.fn(async () => ({ availability: availability === "ready" && created ? "ready" as const : availability === "ready" ? "not_connected" as const : availability,
      capabilities: [], transportReady: availability === "ready", selectedDeviceIdentity: created ? "verified" as const : "unverified" as const })),
    createSession: vi.fn(async () => { created = true; return {}; }), close: vi.fn(async () => {})
  };
};
const bridge = (): PhoneBridgeClient & { submissions: Array<{ taskId: string; result: unknown }> } => {
  const submissions: Array<{ taskId: string; result: unknown }> = [];
  return {
    submissions,
    register: vi.fn(async () => ({ bridgeId: "bridge-fixture-0001" })),
    heartbeat: vi.fn(async () => {}),
    poll: vi.fn(async () => []),
    submit: vi.fn(async (_bridgeId, taskId, result) => { submissions.push({ taskId, result }); })
  };
};
const provider = (overrides: Partial<PhoneUiProvider> = {}): PhoneUiProvider => ({
  readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: ["inbox.list"] })),
  observe: vi.fn(async () => accountObservation),
  refreshContext: vi.fn(async (intent) => ({ target: intent.target, contextHash: intent.contextHash, availability: "ready" as const })),
  execute: vi.fn(async () => ({ status: "OUTCOME_UNKNOWN" as const, reason: "uncertain" })),
  ...overrides
});
const task = (kind: "write" | "preview" = "write"): BridgeTask => ({
  id: "task-fixture-00000001", kind, source: "phone", bridgeId: "bridge-fixture-0001", operation: "comment.like",
  accountBinding: "acct:fixture", targetRefs: [{ accountBinding: "acct:fixture", nativeId: "phone-comment:123" }],
  payload: {}, expiresAt: new Date(Date.now() + 20_000).toISOString(), contextHash: "a".repeat(64),
  requestId: "req-phone-0123456789", fingerprint: "b".repeat(64)
});

describe("standalone phone companion", () => {
  it("does not create or register an Appium session while the configured device is disconnected", async () => {
    const device = appium("not_connected");
    const client = bridge();
    const phone = createPhoneCompanion({ appium: device, client, provider: provider(), accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });
    await expect(phone.start()).resolves.toMatchObject({ availability: "not_connected" });
    expect(device.createSession).not.toHaveBeenCalled();
    expect(client.register).not.toHaveBeenCalled();
    await phone.close();
  });

  it("drains an already-started one-shot phone write before idempotent close resolves", async () => {
    const keyRoot = await mkdtemp(join(tmpdir(), "phone-close-approval-"));
    const authority = await createUiApprovalAuthority({ privateKeyPath: join(keyRoot, "key.json"), projectRoot: process.cwd() });
    const device = appium();
    const client = bridge();
    client.register = vi.fn(async () => ({ bridgeId: "bridge-fixture-0001", approvalPublicKey: authority.publicKey }));
    let markExecuteStarted!: () => void;
    let releaseExecute!: (result: { status: "OUTCOME_UNKNOWN"; reason: string }) => void;
    const executeStarted = new Promise<void>((resolve) => { markExecuteStarted = resolve; });
    const executeGate = new Promise<{ status: "OUTCOME_UNKNOWN"; reason: string }>((resolve) => { releaseExecute = resolve; });
    const ui = provider({ execute: vi.fn(async () => { markExecuteStarted(); return executeGate; }) });
    const phone = createPhoneCompanion({ appium: device, client, provider: ui, trustedApprovalPublicKey: authority.publicKey,
      accountBinding: "acct:fixture", expectedAccountHandle: "fixture", pollIntervalMs: 30_000 });
    try {
      await phone.start();
      const unsignedTask = { ...task(), writeApproval: undefined };
      const approvedTask = { ...unsignedTask, writeApproval: authority.sign(unsignedTask) };
      const handling = phone.handleTask(approvedTask);
      await executeStarted;
      const closing = phone.close();
      expect(phone.close()).toBe(closing);
      expect(client.submit).not.toHaveBeenCalled();
      releaseExecute({ status: "OUTCOME_UNKNOWN", reason: "synthetic uncertain completion" });
      await Promise.all([handling, closing]);
      expect(client.submit).toHaveBeenCalledOnce();
      expect(client.submissions[0]?.result).toMatchObject({ status: "OUTCOME_UNKNOWN", reason: "synthetic uncertain completion" });
      expect(device.close).toHaveBeenCalledOnce();
      const pollCount = vi.mocked(client.poll).mock.calls.length;
      await phone.close();
      expect(vi.mocked(client.poll)).toHaveBeenCalledTimes(pollCount);
    } finally {
      releaseExecute({ status: "OUTCOME_UNKNOWN", reason: "synthetic uncertain completion" });
      await phone.close();
      await rm(keyRoot, { recursive: true, force: true });
    }
  });

  it("waits for an active read receipt and rejects later task work after close resolves", async () => {
    const client = bridge();
    let markReadStarted!: () => void;
    let releaseRead!: (result: typeof accountObservation) => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const readGate = new Promise<typeof accountObservation>((resolve) => { releaseRead = resolve; });
    const observe = vi.fn().mockResolvedValueOnce(accountObservation).mockImplementation(async () => { markReadStarted(); return readGate; });
    const ui = provider({ observe });
    const phone = createPhoneCompanion({ appium: appium(), client, provider: ui, accountBinding: "acct:fixture",
      expectedAccountHandle: "fixture", pollIntervalMs: 30_000 });
    try {
      await phone.start();
      vi.mocked(ui.observe).mockClear();
      const readTask: BridgeTask = { ...task("write"), id: "task-read-after-close", kind: "read", operation: "account.snapshot",
        targetRefs: [], payload: {} };
      const handling = phone.handleTask(readTask);
      await readStarted;
      const closing = phone.close();
      releaseRead(accountObservation);
      await Promise.all([handling, closing]);
      expect(client.submit).toHaveBeenCalledOnce();
      expect(client.submissions[0]).toMatchObject({ taskId: readTask.id, result: accountObservation });
      await phone.handleTask({ ...readTask, id: "task-after-close" });
      expect(ui.observe).toHaveBeenCalledOnce();
      expect(client.submit).toHaveBeenCalledOnce();
    } finally {
      releaseRead(accountObservation);
      await phone.close();
    }
  });

  it("does not register an unknown Instagram account", async () => {
    const device = appium();
    const client = bridge();
    const wrongProvider = provider({ observe: vi.fn(async () => ({ ...accountObservation, data: { username: "other" } })) });
    const phone = createPhoneCompanion({ appium: device, client, provider: wrongProvider, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });
    await expect(phone.start()).resolves.toMatchObject({ availability: "unsupported" });
    expect(client.register).not.toHaveBeenCalled();
    expect(device.close).toHaveBeenCalledOnce();
  });

  it("routes account inspect and snapshot reads without a target", async () => {
    const client = bridge();
    const observe = vi.fn(async () => accountObservation);
    const ui = provider({
      readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: ["account.inspect", "account.snapshot"] })),
      observe,
    });
    const phone = createPhoneCompanion({ appium: appium(), client, provider: ui, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });
    try {
      await phone.start();
      observe.mockClear();
      for (const [index, operation] of (["account.inspect", "account.snapshot"] as const).entries()) {
        await phone.handleTask({
          ...task("write"),
          id: `task-account-${index}`,
          kind: "read",
          operation,
          targetRefs: [],
          payload: {},
        });
      }
      expect(observe).toHaveBeenNthCalledWith(1, { op: "account.inspect" });
      expect(observe).toHaveBeenNthCalledWith(2, { op: "account.snapshot" });
      expect(client.submissions).toHaveLength(2);
      expect(client.submissions.map((submission) => submission.result)).toEqual([accountObservation, accountObservation]);
    } finally { await phone.close(); }
  });

  it("does not start a phone UI read after its Hub task expired", async () => {
    const client = bridge();
    const ui = provider();
    const phone = createPhoneCompanion({ appium: appium(), client, provider: ui, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });
    try {
      await phone.start();
      vi.mocked(ui.observe).mockClear();
      await phone.handleTask({
        ...task("preview"), id: "task-expired-phone-read", kind: "read", operation: "inbox.list", targetRefs: [], payload: { limit: 5 },
        expiresAt: new Date(Date.now() - 1_000).toISOString()
      });

      expect(ui.observe).not.toHaveBeenCalled();
      expect(client.submissions).toMatchObject([{ taskId: "task-expired-phone-read", result: { status: "FAILED" } }]);
    } finally { await phone.close(); }
  });

  it("rejects stale writes and submits an uncertain one-shot action only once", async () => {
    const device = appium();
    const client = bridge();
    const ui = provider();
    const phone = createPhoneCompanion({ appium: device, client, provider: ui, accountBinding: "acct:fixture", expectedAccountHandle: "fixture", pollIntervalMs: 30_000 });
    try {
      await phone.start();
      const stale = { ...task(), contextHash: "c".repeat(64) };
      await phone.handleTask(stale);
      expect(ui.execute).not.toHaveBeenCalled();
      expect(client.submissions[0]?.result).toMatchObject({ status: "FAILED" });

      const duplicateClient = bridge();
      const duplicateUi = provider();
      const keyRoot = await mkdtemp(join(tmpdir(), "phone-approval-"));
      const authority = await createUiApprovalAuthority({ privateKeyPath: join(keyRoot, "key.json"), projectRoot: process.cwd() });
      const write = { ...task(), writeApproval: undefined };
      const grant = authority.sign(write);
      const approvedWrite = { ...write, writeApproval: grant };
      const duplicatePhone = createPhoneCompanion({ appium: appium(), client: { ...duplicateClient, register: vi.fn(async () => ({ bridgeId: write.bridgeId, approvalPublicKey: authority.publicKey })) }, provider: duplicateUi, trustedApprovalPublicKey: authority.publicKey, accountBinding: "acct:fixture", expectedAccountHandle: "fixture", pollIntervalMs: 30_000 });
      try {
        await duplicatePhone.start();
        await duplicatePhone.handleTask(approvedWrite);
        await duplicatePhone.handleTask(approvedWrite);
        expect(duplicateUi.execute).toHaveBeenCalledOnce();
        expect(duplicateClient.submissions).toHaveLength(1);
        expect(duplicateClient.submissions[0]?.result).toMatchObject({ status: "OUTCOME_UNKNOWN" });
      } finally { await duplicatePhone.close(); await rm(keyRoot, { recursive: true, force: true }); }
    } finally { await phone.close(); }
  });

  it("refreshes selected comment context through the server Hub and phone broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "phone-context-refresh-"));
    const hub = new CompanionHub({ storagePath: join(root, "hub.json") });
    let bridgeToken = "";
    const ui = provider({ readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: ["context.refresh", "comments.list"] })),
      refreshContext: vi.fn(async (intent) => ({ target: intent.target, contextHash: "d".repeat(64), availability: "ready" as const })) });
    const client: PhoneBridgeClient = {
      async register(capabilities) {
        const registered = await hub.register({ mode: "phone_standalone", source: "phone", accountBinding: "acct:fixture", capabilities: [...(capabilities ?? [])] });
        bridgeToken = registered.bridgeToken;
        return { bridgeId: registered.bridgeId };
      },
      async heartbeat(id, status) { await hub.heartbeat({ bridgeId: id, bridgeToken, source: "phone", status }); },
      poll: async (id, max) => hub.poll(id, max, bridgeToken),
      submit: async (id, taskId, result, contextHash) => hub.submit(id, taskId, result, contextHash, bridgeToken)
    };
    const phone = createPhoneCompanion({ appium: appium(), client, provider: ui, accountBinding: "acct:fixture", expectedAccountHandle: "fixture", pollIntervalMs: 250 });
    const serverProvider = createCompanionSourceProvider({ hub, source: "phone", accountBinding: "acct:fixture", waitMs: process.platform === "win32" ? 30_000 : 1_000, pollMs: 25 });
    const intent = { source: "phone" as const, accountBinding: "acct:fixture", action: "comment.like" as const,
      target: { accountBinding: "acct:fixture", nativeId: "phone-comment:123" }, payload: { kind: "comment.like" as const }, contextHash: "prepare" };
    try {
      await phone.start();
      await waitForReady(hub);
      await expect(serverProvider.refreshContext!(intent)).resolves.toMatchObject({ target: intent.target, contextHash: "d".repeat(64), availability: "ready" });
      expect(ui.refreshContext).toHaveBeenCalledWith(expect.objectContaining({ action: "comment.like", target: intent.target }));
    } finally { await phone.close(); await rm(root, { recursive: true, force: true }); }
  }, process.platform === "win32" ? 45_000 : 15_000);
});

async function waitForReady(hub: CompanionHub): Promise<void> {
  const deadline = Date.now() + (process.platform === "win32" ? 30_000 : 1_000);
  while (Date.now() < deadline) {
    if ((await hub.sourceStatus("phone", "acct:fixture")).availability === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("phone heartbeat did not become ready");
}
