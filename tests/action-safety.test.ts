import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintIntent, MutationSafety, type MutationExecutor } from "../src/action-safety.js";
import type { MutationIntent, MutationResult } from "../src/domain-types.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: { writeEnabled?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "meta-safety-"));
  tempDirs.push(dir);
  const intent: MutationIntent = {
    source: "api", accountBinding: "account-α", action: "message.send",
    payload: { kind: "message.send", text: "Привет 👋" },
    target: { accountBinding: "account-α", nativeId: "thread-1" }, contextHash: "ctx-current"
  };
  const execute = vi.fn<MutationExecutor["execute"]>(async () => ({ status: "ACK", receiptId: "receipt-1" }));
  const executor: MutationExecutor = {
    source: "api",
    refreshContext: vi.fn(async () => ({ target: intent.target, contextHash: intent.contextHash })),
    execute
  };
  const safety = new MutationSafety({ executors: [executor], auditPath: join(dir, "audit.jsonl"), ...options });
  return { dir, intent, executor, execute, safety };
}

describe("MutationSafety", () => {
  it("previews by default without writing an audit entry or calling the executor", async () => {
    const { dir, intent, execute, safety } = await fixture();
    const preview = await safety.handle(intent);
    expect(preview).toMatchObject({ source: "api", action: "message.send", requiresConfirmation: true });
    expect(preview).toMatchObject({ fingerprint: expect.any(String), requestId: expect.any(String) });
    expect(execute).not.toHaveBeenCalled();
    await expect(import("node:fs/promises").then(({ readFile }) => readFile(join(dir, "audit.jsonl"), "utf8"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires write environment and all approval fields before dispatch", async () => {
    const { intent, execute, safety } = await fixture();
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(result).toMatchObject({ status: "FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes once after matching a fresh preview and journals no payload text", async () => {
    const { dir, intent, execute, safety } = await fixture({ writeEnabled: true });
    let journalAtExecute = "";
    vi.mocked(execute).mockImplementation(async () => {
      journalAtExecute = await readFile(join(dir, "audit.jsonl"), "utf8");
      return { status: "ACK", receiptId: "receipt-1" };
    });
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    const journal = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(result).toMatchObject({ status: "ACK" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(intent, preview.requestId, "ctx-current", { durableAttempt: true, requestId: preview.requestId, fingerprint: preview.fingerprint });
    expect(journalAtExecute).toContain('"status":"ATTEMPT"');
    expect(journal).toContain('"status":"ATTEMPT"');
    expect(journal).toContain('"status":"ACK"');
    expect(journal).not.toContain("Привет");
    expect(journal).not.toContain("thread-1");
    expect(journal).not.toContain("ctx-current");
  });

  it("rejects a changed source context before writing or dispatching", async () => {
    const { dir, intent, executor, execute, safety } = await fixture({ writeEnabled: true });
    vi.mocked(executor.refreshContext).mockResolvedValue({ target: intent.target, contextHash: "ctx-changed" });
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(result).toMatchObject({ status: "FAILED" });
    expect(execute).not.toHaveBeenCalled();
    await expect(import("node:fs/promises").then(({ readFile }) => readFile(join(dir, "audit.jsonl"), "utf8"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deduplicates concurrent calls using the same approved request", async () => {
    const { intent, execute, safety } = await fixture({ writeEnabled: true });
    const preview = await safety.handle(intent);
    const approval = { dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId } as const;
    const results = await Promise.all([safety.handle(intent, approval), safety.handle(intent, approval)]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(["ACK", "ACK"]);
  });

  it("treats timeout, disconnect, and 5xx as unknown and never retries after restart", async () => {
    const cases = [
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
      Object.assign(new Error("server error"), { status: 503 }),
      new Error("unclassified failure after dispatch")
    ];
    for (const error of cases) {
      const { dir, intent, execute, safety } = await fixture({ writeEnabled: true });
      vi.mocked(execute).mockRejectedValueOnce(error);
      const preview = await safety.handle(intent);
      const approval = { dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId } as const;
      const first = await safety.handle(intent, approval);
      const restarted = new MutationSafety({
        executors: [{ source: "api", refreshContext: async () => ({ target: intent.target, contextHash: intent.contextHash }), execute }],
        auditPath: join(dir, "audit.jsonl"), writeEnabled: true
      });
      const second = await restarted.handle(intent, approval);
      expect(first.status).toBe("OUTCOME_UNKNOWN");
      expect(second.status).toBe("OUTCOME_UNKNOWN");
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed on a corrupt journal and leaves the executor untouched", async () => {
    const { dir, intent, execute, safety } = await fixture({ writeEnabled: true });
    await writeFile(join(dir, "audit.jsonl"), "{partial\n", { mode: 0o600 });
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(result).toMatchObject({ status: "FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires a separate delete confirmation", async () => {
    const { dir, intent, execute, safety } = await fixture({ writeEnabled: true });
    const deletion: MutationIntent = {
      ...intent, action: "comment.delete", payload: { kind: "comment.delete" }
    };
    const preview = await safety.handle(deletion);
    const result = await safety.handle(deletion, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(result).toMatchObject({ status: "FAILED" });
    expect(execute).not.toHaveBeenCalled();
    expect(await stat(join(dir, "audit.jsonl")).catch(() => undefined)).toBeUndefined();
  });

  it("rejects fingerprint tampering, request-id conflicts, and a pre-existing lock", async () => {
    const { dir, intent, execute, safety } = await fixture({ writeEnabled: true });
    const preview = await safety.handle(intent);
    const wrongFingerprint = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: "0".repeat(64), requestId: preview.requestId
    });
    expect(wrongFingerprint).toMatchObject({ status: "FAILED" });
    const original = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(original.status).toBe("ACK");
    const otherIntent: MutationIntent = { ...intent, payload: { kind: "message.send", text: "другой текст" } };
    const restarted = new MutationSafety({
      executors: [executorFor(otherIntent, execute)], auditPath: join(dir, "audit.jsonl"), writeEnabled: true
    });
    const conflict = await restarted.handle(otherIntent, {
      dryRun: false, confirm: true, expectedFingerprint: fingerprintIntent(otherIntent), requestId: preview.requestId
    });
    expect(conflict).toMatchObject({ status: "FAILED" });

    const callsBeforeLock = execute.mock.calls.length;
    await writeFile(join(dir, "audit.jsonl.lock"), "locked", { mode: 0o600 });
    const blocked = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(blocked).toMatchObject({ status: "FAILED" });
    expect(await readFile(join(dir, "audit.jsonl.lock"), "utf8")).toBe("locked");
    expect(execute).toHaveBeenCalledTimes(callsBeforeLock);
  });

  it("keeps UI execution behind the same fixed-source safety port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meta-safety-ui-"));
    tempDirs.push(dir);
    const intent: MutationIntent = {
      source: "phone", accountBinding: "account-α", action: "comment.like",
      payload: { kind: "comment.like" }, target: { accountBinding: "account-α", nativeId: "comment-1" }, contextHash: "phone-context"
    };
    const execute = vi.fn<MutationExecutor["execute"]>(async () => ({ status: "OBSERVED" }));
    const safety = new MutationSafety({
      executors: [{ source: "phone", refreshContext: async () => ({ target: intent.target, contextHash: intent.contextHash }), execute }],
      auditPath: join(dir, "audit.jsonl"), writeEnabled: true
    });
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(result).toMatchObject({ status: "OBSERVED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the audit destination cannot be created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meta-safety-file-"));
    tempDirs.push(dir);
    const parentFile = join(dir, "not-a-directory");
    await writeFile(parentFile, "file");
    const { intent, execute } = await fixture({ writeEnabled: true });
    const safety = new MutationSafety({
      executors: [{ source: "api", refreshContext: async () => ({ target: intent.target, contextHash: intent.contextHash }), execute }],
      auditPath: join(parentFile, "audit.jsonl"), writeEnabled: true
    });
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(result).toMatchObject({ status: "FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses key-order-independent fingerprints and private audit permissions", async () => {
    const { dir, intent, safety } = await fixture({ writeEnabled: true });
    const reordered = { ...intent, target: { nativeId: "thread-1", accountBinding: "account-α" } };
    const first = await safety.handle(intent);
    const second = await safety.handle(reordered);
    expect(second.fingerprint).toBe(first.fingerprint);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: first.fingerprint, requestId: first.requestId
    });
    expect(result.status).toBe("ACK");
    if (process.platform !== "win32") expect((await stat(join(dir, "audit.jsonl"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "audit.jsonl"), "utf8")).not.toContain("account-α");
  });
});

function executorFor(intent: MutationIntent, execute: MutationExecutor["execute"]): MutationExecutor {
  return {
    source: intent.source,
    refreshContext: async () => ({ target: intent.target, contextHash: intent.contextHash }),
    execute
  };
}
