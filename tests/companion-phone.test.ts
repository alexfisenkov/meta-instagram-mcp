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

  it("does not register an unknown Instagram account", async () => {
    const device = appium();
    const client = bridge();
    const wrongProvider = provider({ observe: vi.fn(async () => ({ ...accountObservation, data: { username: "other" } })) });
    const phone = createPhoneCompanion({ appium: device, client, provider: wrongProvider, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });
    await expect(phone.start()).resolves.toMatchObject({ availability: "unsupported" });
    expect(client.register).not.toHaveBeenCalled();
    expect(device.close).toHaveBeenCalledOnce();
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
    const serverProvider = createCompanionSourceProvider({ hub, source: "phone", accountBinding: "acct:fixture", waitMs: 1_000, pollMs: 5 });
    const intent = { source: "phone" as const, accountBinding: "acct:fixture", action: "comment.like" as const,
      target: { accountBinding: "acct:fixture", nativeId: "phone-comment:123" }, payload: { kind: "comment.like" as const }, contextHash: "prepare" };
    try {
      await phone.start();
      await waitForReady(hub);
      await expect(serverProvider.refreshContext!(intent)).resolves.toMatchObject({ target: intent.target, contextHash: "d".repeat(64), availability: "ready" });
      expect(ui.refreshContext).toHaveBeenCalledWith(expect.objectContaining({ action: "comment.like", target: intent.target }));
    } finally { await phone.close(); await rm(root, { recursive: true, force: true }); }
  });
});

async function waitForReady(hub: CompanionHub): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if ((await hub.sourceStatus("phone", "acct:fixture")).availability === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("phone heartbeat did not become ready");
}
