import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyActionReadback, type ActionReadbackRecord } from "../src/action-readback.js";
import type { Observation } from "../src/domain-types.js";

const record: ActionReadbackRecord = {
  version: 1, requestId: "request-123456789012", fingerprint: "a".repeat(64), source: "api",
  accountBinding: "instagram:42", action: "message.send", target: { accountBinding: "instagram:42", nativeId: "thread-1" },
  payloadHash: createHash("sha256").update("Exact reply").digest("hex"), attemptedAt: "2026-10-06T12:00:00.000Z", status: "pending"
};
const obs = (data: unknown, changes: Partial<Observation<unknown>> = {}): Observation<unknown> => ({
  source: "api", nativeRef: "conversation:thread-1", accountBinding: "instagram:42", capturedAt: "2026-10-06T12:00:01.000Z",
  availability: "ready", coverage: "complete", historyCompleteness: "limited", data, errors: [], ...changes
});

describe("action read-back proof", () => {
  it("verifies an exact own reply and separates queue response state", () => {
    const result = verifyActionReadback(record, { observation: obs({ complete: true, messages: [
      { id: "sent-1", text: "Exact reply", direction: "outbound", createdAt: "2026-10-06T12:00:01.000Z", from: { id: "ig-42" } },
      { id: "in-1", text: "Question", direction: "inbound", createdAt: "2026-10-06T11:59:00.000Z", from: { id: "peer" } }
    ] }), ownerSenderIds: ["ig-42"] });

    expect(result).toMatchObject({ status: "OBSERVED", receiptId: "sent-1", responseState: "answered" });
  });

  it("returns unknown when the exact reply is absent, stale, duplicated, or the source read failed", () => {
    const late = obs({ complete: true, messages: [{ id: "old", text: "Exact reply", direction: "outbound", createdAt: "2026-10-06T11:59:00.000Z", from: { id: "ig-42" } }] });
    const duplicate = obs({ complete: true, messages: [
      { id: "sent-1", text: "Exact reply", direction: "outbound", createdAt: "2026-10-06T12:00:01.000Z", from: { id: "ig-42" } },
      { id: "sent-2", text: "Exact reply", direction: "outbound", createdAt: "2026-10-06T12:00:02.000Z", from: { id: "ig-42" } }
    ] });
    const failed = obs(undefined, { availability: "offline", coverage: "unknown", errors: [{ code: "offline", message: "unavailable" }] });

    expect(verifyActionReadback(record, { observation: late, ownerSenderIds: ["ig-42"] }).status).toBe("OUTCOME_UNKNOWN");
    expect(verifyActionReadback(record, { observation: duplicate, ownerSenderIds: ["ig-42"] }).status).toBe("OUTCOME_UNKNOWN");
    expect(verifyActionReadback(record, { observation: failed }).status).toBe("OUTCOME_UNKNOWN");
  });

  it("does not mark an older reply as current when a newer inbound message exists", () => {
    const result = verifyActionReadback(record, { observation: obs({ complete: true, messages: [
      { id: "in-2", text: "One more thing", direction: "inbound", createdAt: "2026-10-06T12:00:03.000Z", from: { id: "peer" } },
      { id: "sent-1", text: "Exact reply", direction: "outbound", createdAt: "2026-10-06T12:00:01.000Z", from: { id: "ig-42" } }
    ] }), ownerSenderIds: ["ig-42"] });

    expect(result).toMatchObject({ status: "OBSERVED", receiptId: "sent-1", responseState: "unknown" });
  });

  it("does not convert reactions into a text response", () => {
    const reaction = { ...record, action: "message.react" as const, payloadHash: undefined };
    expect(verifyActionReadback(reaction, { observation: obs({ messages: [] }) }).status).toBe("OUTCOME_UNKNOWN");
  });

  it("accepts a browser receipt id only from the exact bound thread while keeping queue response state unknown", () => {
    const browserRecord = { ...record, source: "browser" as const, receiptId: "sent-1" };
    const observation: Observation<unknown> = { ...obs({ threadNativeId: "thread-1", messages: [
      { nativeId: "sent-1", text: "Exact reply", direction: "outbound", timestamp: "unknown" }
    ] }, { source: "browser", nativeRef: "/direct/t/thread-1/", coverage: "unknown" }) };

    expect(verifyActionReadback(browserRecord, { observation })).toMatchObject({ status: "OBSERVED", receiptId: "sent-1", responseState: "unknown" });
    expect(verifyActionReadback({ ...browserRecord, target: { accountBinding: "instagram:42", nativeId: "thread-2" } }, { observation }).status).toBe("OUTCOME_UNKNOWN");
  });

  it("verifies the raw Meta comments.listReplies shape using only verified owner IDs", () => {
    const commentRecord: ActionReadbackRecord = {
      ...record, action: "comment.reply", target: { accountBinding: "instagram:42", nativeId: "comment-1" },
      receiptId: "reply-1", payloadHash: createHash("sha256").update("Exact reply").digest("hex")
    };
    const apiReplies = (items: unknown[]) => obs({ items }, { nativeRef: "comment-replies:comment-1" });
    const currentReply = { id: "reply-1", text: "Exact reply", timestamp: "2026-10-06T12:00:01.000Z", from: { id: "ig-42" } };

    expect(verifyActionReadback(commentRecord, { observation: apiReplies([currentReply]), ownerSenderIds: ["ig-42"] }))
      .toMatchObject({ status: "OBSERVED", receiptId: "reply-1", observedAt: currentReply.timestamp, responseState: "unknown" });
    const rejectedCases: Array<[string, unknown[], string[] | undefined]> = [
      ["foreign sender", [{ ...currentReply, from: { id: "peer" } }], ["ig-42"]],
      ["missing verified owner set", [currentReply], undefined],
      ["mismatched text", [{ ...currentReply, text: "Different reply" }], ["ig-42"]],
      ["missing native id", [{ ...currentReply, id: undefined }], ["ig-42"]],
      ["stale timestamp", [{ ...currentReply, timestamp: "2026-10-06T11:59:59.000Z" }], ["ig-42"]]
    ];
    for (const [label, items, ownerSenderIds] of rejectedCases) {
      expect(verifyActionReadback(commentRecord, { observation: apiReplies(items), ownerSenderIds }).status, label).toBe("OUTCOME_UNKNOWN");
    }
  });
});
