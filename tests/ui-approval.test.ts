import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUiApprovalAuthority, verifyUiApproval, type UiApprovalTask } from "../src/ui-approval.js";

describe("UI write approval grants", () => {
  it("signs one exact task and rejects payload, account, or expiry changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-ui-approval-"));
    try {
      const keyPath = join(directory, "approval-key.json");
      const authority = await createUiApprovalAuthority({ privateKeyPath: keyPath, projectRoot: join(directory, "project") });
      const task: UiApprovalTask = {
        id: "task-0123456789abcdef", bridgeId: "bridge-0123456789abcdef", kind: "write", source: "browser",
        operation: "message.send", accountBinding: "acct:fixture", targetRefs: [{ accountBinding: "acct:fixture", nativeId: "thread-1" }],
        payload: { text: "exact draft" }, expiresAt: "2026-10-06T12:00:30.000Z", contextHash: "a".repeat(64),
        requestId: "req-0123456789abcdef", fingerprint: "b".repeat(64)
      };
      const grant = authority.sign(task);

      expect(verifyUiApproval(task, grant, authority.publicKey, { now: Date.parse("2026-10-06T12:00:00.000Z"), bridgeId: task.bridgeId, source: "browser" })).toBe(true);
      expect(verifyUiApproval({ ...task, payload: { text: "changed" } }, grant, authority.publicKey, { now: Date.parse("2026-10-06T12:00:00.000Z"), bridgeId: task.bridgeId, source: "browser" })).toBe(false);
      expect(verifyUiApproval({ ...task, accountBinding: "acct:other" }, grant, authority.publicKey, { now: Date.parse("2026-10-06T12:00:00.000Z"), bridgeId: task.bridgeId, source: "browser" })).toBe(false);
      expect(verifyUiApproval(task, grant, authority.publicKey, { now: Date.parse(task.expiresAt), bridgeId: task.bridgeId, source: "browser" })).toBe(false);
      expect((await stat(keyPath)).mode & 0o077).toBe(0);
      expect((await readFile(keyPath, "utf8"))).not.toContain("task-0123456789abcdef");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
