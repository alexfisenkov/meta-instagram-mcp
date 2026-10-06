import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationSafety, type MutationExecutor } from "../src/action-safety.js";
import { FileActionReadbackStore, type ActionReadbackRecord } from "../src/action-readback.js";
import { createMutationToolHandlers } from "../src/mutation-tools.js";
import type { Observation } from "../src/domain-types.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function ownReply(id: string): Observation<unknown> {
  return { source: "api", nativeRef: "conversation:thread-1", accountBinding: "instagram:42", capturedAt: "2026-10-06T12:00:02.000Z",
    availability: "ready", coverage: "complete", historyCompleteness: "limited", errors: [], data: { complete: true, messages: [
      { id, text: "approved words", direction: "outbound", createdAt: "2026-10-06T12:00:02.000Z", from: { id: "ig-42" } },
      { id: "in-1", text: "question", direction: "inbound", createdAt: "2026-10-06T11:59:00.000Z", from: { id: "peer" } }
    ] } };
}

describe("confirmed action read-back", () => {
  it("converts an API ACK only after exact same-source read proof and keeps the receipt private", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-readback-")); dirs.push(dir);
    const storePath = join(dir, "readback.json");
    const executor: MutationExecutor = {
      source: "api", refreshContext: async (intent) => ({ target: intent.target, contextHash: "fresh-context" }),
      execute: vi.fn(async () => ({ status: "ACK" as const, receiptId: "sent-1" })),
      readback: async () => ({ observation: ownReply("sent-1"), ownerSenderIds: ["ig-42"] })
    };
    const tools = createMutationToolHandlers({ executors: [executor], readbackStore: new FileActionReadbackStore(storePath),
      safety: new MutationSafety({ executors: [executor], auditPath: join(dir, "audit.jsonl"), sourceWriteEnabled: { api: true } }),
      now: () => new Date("2026-10-06T12:00:01.000Z") });
    const preview = await tools.prepare({ source: "api", accountBinding: "instagram:42", action: "message.send",
      target: { accountBinding: "instagram:42", nativeId: "thread-1" }, text: "approved words" });
    if (!("requiresConfirmation" in preview)) throw new Error("expected preview");
    const result = await tools.execute({ requestId: preview.requestId, expectedFingerprint: preview.fingerprint, confirm: true });

    expect(result).toMatchObject({ status: "OBSERVED", dispatchStatus: "ACK", receiptId: "sent-1", responseState: "answered" });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(await readFile(storePath, "utf8")).not.toContain("approved words");
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  });

  it("persists unknown receipts, reconciles after restart, and never replays the write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-reconcile-restart-")); dirs.push(dir);
    const storePath = join(dir, "readback.json");
    let shouldAppear = false;
    const execute = vi.fn(async () => ({ status: "ACK" as const, receiptId: "sent-late" }));
    const readback = vi.fn(async (_record: ActionReadbackRecord) => ({
      observation: shouldAppear ? ownReply("sent-late") : { ...ownReply("old"), data: { complete: true, messages: [] } }, ownerSenderIds: ["ig-42"]
    }));
    const makeTools = () => {
      const executor: MutationExecutor = { source: "api", refreshContext: async (intent) => ({ target: intent.target, contextHash: "fresh-context" }), execute, readback };
      return createMutationToolHandlers({ executors: [executor], readbackStore: new FileActionReadbackStore(storePath),
        safety: new MutationSafety({ executors: [executor], auditPath: join(dir, "audit.jsonl"), sourceWriteEnabled: { api: true } }) });
    };
    const first = makeTools();
    const preview = await first.prepare({ source: "api", accountBinding: "instagram:42", action: "message.send",
      target: { accountBinding: "instagram:42", nativeId: "thread-1" }, text: "approved words" });
    if (!("requiresConfirmation" in preview)) throw new Error("expected preview");
    expect(await first.execute({ requestId: preview.requestId, expectedFingerprint: preview.fingerprint, confirm: true })).toMatchObject({ status: "OUTCOME_UNKNOWN" });
    expect(execute).toHaveBeenCalledTimes(1);
    shouldAppear = true;

    const restarted = makeTools();
    const reconciled = await restarted.reconcile({ requestId: preview.requestId });

    expect(reconciled).toMatchObject({ status: "OBSERVED", dispatchStatus: "ACK", receiptId: "sent-late", responseState: "answered" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readback).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(storePath, "utf8")).records[0]).toMatchObject({ status: "observed", responseState: "answered" });
  });

  it("refuses a forged request id without a stored native target or action receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-reconcile-forged-")); dirs.push(dir);
    const executor: MutationExecutor = { source: "api", refreshContext: async (intent) => ({ target: intent.target, contextHash: intent.contextHash }), execute: async () => ({ status: "ACK" }) };
    const tools = createMutationToolHandlers({ executors: [executor], readbackStore: new FileActionReadbackStore(join(dir, "readback.json")),
      safety: new MutationSafety({ executors: [executor], auditPath: join(dir, "audit.jsonl"), sourceWriteEnabled: { api: true } }) });

    expect(await tools.reconcile({ requestId: "forged-request-123456" })).toMatchObject({ status: "FAILED" });
  });

  it("does not trust an executor OBSERVED receipt without the mutation layer's exact read proof", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-unverified-observed-")); dirs.push(dir);
    const executor: MutationExecutor = { source: "api", refreshContext: async (intent) => ({ target: intent.target, contextHash: "fresh-context" }),
      execute: async () => ({ status: "OBSERVED", receiptId: "claimed-only" }) };
    const tools = createMutationToolHandlers({ executors: [executor], readbackStore: new FileActionReadbackStore(join(dir, "readback.json")),
      safety: new MutationSafety({ executors: [executor], auditPath: join(dir, "audit.jsonl"), sourceWriteEnabled: { api: true } }) });
    const preview = await tools.prepare({ source: "api", accountBinding: "instagram:42", action: "message.send",
      target: { accountBinding: "instagram:42", nativeId: "thread-1" }, text: "approved words" });
    if (!("requiresConfirmation" in preview)) throw new Error("expected preview");

    expect(await tools.execute({ requestId: preview.requestId, expectedFingerprint: preview.fingerprint, confirm: true }))
      .toMatchObject({ status: "OUTCOME_UNKNOWN", dispatchStatus: "OUTCOME_UNKNOWN" });
  });
});
