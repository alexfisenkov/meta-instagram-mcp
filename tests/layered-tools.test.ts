import { describe, expect, it, vi } from "vitest";
import { createLayeredToolHandlers } from "../src/layered-tools.js";
import { createSourceRouter, type SourceProvider } from "../src/source-router.js";
import type { Observation } from "../src/domain-types.js";

const observation = (source: Observation<unknown>["source"], data: unknown, coverage: Observation<unknown>["coverage"] = "partial"): Observation<unknown> => ({
  source, nativeRef: `${source}:inbox`, accountBinding: "instagram:42", capturedAt: "2026-10-06T12:00:00.000Z",
  availability: "ready", coverage, historyCompleteness: "limited", data, errors: []
});
const provider = (source: "api" | "browser" | "phone", value: Observation<unknown>): SourceProvider => ({
  source, status: async () => ({ source, availability: "ready", capabilities: ["inbox.list"] }), read: async () => value
});

describe("layered tools", () => {
  it("normalizes the phone inbox shape without claiming visible rows cover the full inbox", async () => {
    const phone = provider("phone", observation("phone", { threads: [
      { target: { accountBinding: "instagram:42", nativeId: "phone-thread:abc" }, peer: "@peer", unread: "unknown", unanswered: "unknown" }
    ] }));
    const queue = await createLayeredToolHandlers({ router: createSourceRouter({ providers: [phone] }) })
      .triageInbox({ source: "auto", limit: 20 });

    expect(queue.items).toMatchObject([{ threadRef: { accountBinding: "instagram:42", nativeId: "phone-thread:abc" }, unread: "unknown", unanswered: "unknown", state: "unknown" }]);
    expect(queue.coverage).toBe("partial");
    expect(queue.truncated).toBe(true);
    expect(queue.limitations).not.toHaveLength(0);
  });

  it("keeps unread separate from unanswered and never calls partial unknown context answered", async () => {
    const api = observation("api", { items: [
      { id: "thread-1", unread: true, unanswered: "unknown" },
      { id: "thread-2", unread: false, latestMessage: { id: "m-2", direction: "outbound", createdAt: "2026-10-05T12:00:00.000Z" } }
    ] });
    const offlineBrowser: SourceProvider = { source: "browser", status: async () => ({ source: "browser", availability: "offline", capabilities: [] }), read: async () => observation("browser", { items: [] }, "complete") };
    const router = createSourceRouter({ providers: [provider("api", api), offlineBrowser], timeoutMs: 100 });
    const tools = createLayeredToolHandlers({ router });

    const queue = await tools.triageInbox({ source: "auto", limit: 10 });

    expect(queue.items.map((item) => [item.unread, item.unanswered, item.state])).toEqual([
      [true, "unknown", "unknown"], [false, "unknown", "unknown"]
    ]);
    expect(queue.coverage).toBe("partial");
  });

  it("surfaces a persisted verified reply on the same queue target without fabricating current unanswered state", async () => {
    const api = provider("api", observation("api", { items: [{ id: "thread-1", unread: true, unanswered: "unknown" }] }));
    const tools = createLayeredToolHandlers({ router: createSourceRouter({ providers: [api] }), actionReadbacks: {
      async latestFor(source, target) {
        expect([source, target.nativeId]).toEqual(["api", "thread-1"]);
        return { version: 1, requestId: "request-123456789012", fingerprint: "a".repeat(64), source: "api", accountBinding: "instagram:42",
          action: "message.send", target, payloadHash: "b".repeat(64), attemptedAt: "2026-10-06T12:00:00.000Z", observedAt: "2026-10-06T12:00:01.000Z",
          status: "observed", responseState: "answered", receiptId: "sent-1" };
      }
    } });

    const queue = await tools.triageInbox({ source: "auto", limit: 10 });

    expect(queue.items[0]).toMatchObject({ unanswered: "unknown", state: "unknown",
      lastAction: { action: "message.send", status: "observed", responseState: "answered" } });
  });

  it("only sends selected observations to host analysis and overrides stats with deterministic counts", async () => {
    const selected = observation("api", { items: [{ id: "thread-1", unread: true, unanswered: true }] });
    const unselected = observation("browser", { items: [{ id: "thread-2" }] }, "complete");
    const router = createSourceRouter({ providers: [provider("api", selected), provider("browser", unselected)], timeoutMs: 100 });
    const analyze = vi.fn(async () => ({
      summary: "review", themes: ["question"], actionsDraft: [], limitations: [],
      sourceRefs: [{ source: "api" as const, nativeRef: "api:inbox", coverage: "partial" as const }],
      stats: { counts: {}, ages: {}, inboundOutbound: {}, ownerReplies: {}, commentLikesHidden: {}, sourceCoverage: {} }
    }));
    const tools = createLayeredToolHandlers({ router, hostAnalysis: { analyze } });

    const output = await tools.analyzeInbox({ selectedObservations: [selected], promptVersion: "v1" });

    expect(analyze).toHaveBeenCalledWith({ selectedObservations: [selected], promptVersion: "v1" });
    expect(output.stats.counts).toMatchObject({ observations: 1, threads: 1, unread: 1, unanswered: 1 });
    expect(output.sourceRefs).toEqual([{ source: "api", nativeRef: "api:inbox", coverage: "partial" }]);
  });

  it("triages Direct plus only explicitly selected media comments through the existing source operations", async () => {
    const calls: unknown[] = [];
    const api: SourceProvider = {
      source: "api",
      status: async (operation) => ({ source: "api", availability: "ready", capabilities: [operation ?? "all"] }),
      read: async (request) => {
        calls.push(request);
        return request.operation === "inbox.list"
          ? observation("api", { items: [{ conversationId: "thread-1", unread: true, unanswered: true,
            latestMessage: { id: "message-1", direction: "inbound", createdAt: "2026-10-06T11:00:00Z" } }] }, "complete")
          : { ...observation("api", { items: [{ id: "comment-1", unanswered: false, unread: "unknown" }] }, "complete"), nativeRef: "comments:media-1" };
      }
    };
    const tools = createLayeredToolHandlers({ router: createSourceRouter({ providers: [api] }) });

    const queue = await tools.triageInbox({ source: "auto", limit: 20,
      commentTargets: [{ accountBinding: "instagram:42", nativeId: "media-1" }] });

    expect(calls).toEqual([
      { operation: "inbox.list", limit: 20, triage: true },
      { operation: "comments.list", target: { accountBinding: "instagram:42", nativeId: "media-1" }, limit: 20, triage: true }
    ]);
    expect(queue.items).toMatchObject([
      { threadRef: { nativeId: "thread-1" }, source: "api", unread: true, unanswered: true, state: "needs_review" },
      { commentRef: { nativeId: "comment-1" }, source: "api", unread: "unknown", unanswered: false, state: "answered" }
    ]);
    expect(queue.channelCounts).toEqual({ direct: 1, comments: 1, unknownAnswerStatus: 0 });
    expect(queue.channelCoverage).toEqual({ direct: "complete", comments: "complete" });
  });

  it("normalizes browser comments and counts comment/reply observations in analysis with provenance", async () => {
    const browser = observation("browser", { comments: [{ id: "comment-b", unread: false, unanswered: "unknown", like_count: 2, hidden: false }] }, "partial");
    browser.nativeRef = "comments:media-b";
    const phone = observation("phone", { replies: [{ id: "reply-p", direction: "outbound", createdAt: "2026-10-06T09:00:00Z" }] }, "complete");
    phone.nativeRef = "comment-replies:comment-p";
    const tools = createLayeredToolHandlers({ router: createSourceRouter({ providers: [provider("browser", browser)] }) });

    const queue = await tools.triageInbox({ source: "auto", limit: 10, commentTargets: [{ accountBinding: "instagram:42", nativeId: "media-b" }] });
    const output = await tools.analyzeInbox({ selectedObservations: [browser, phone], promptVersion: "v1" });

    expect(queue.items).toMatchObject([{ commentRef: { nativeId: "comment-b" }, source: "browser", unanswered: "unknown", unread: false }]);
    expect(output.stats.counts).toMatchObject({ comments: 1, replies: 1, unknownAnswerStatus: 1 });
    expect(output.stats.inboundOutbound).toEqual({ inbound: "unknown", outbound: "unknown" });
    expect(output.stats.ownerReplies).toMatchObject({ outboundMessages: "unknown", commentReplies: 1 });
    expect(output.stats.commentLikesHidden).toEqual({ likes: 2, hidden: 0 });
    expect(output.sourceRefs).toEqual([
      { source: "browser", nativeRef: "comments:media-b", coverage: "partial" },
      { source: "phone", nativeRef: "comment-replies:comment-p", coverage: "complete" }
    ]);
  });

  it("deduplicates only the same native target on the same account and preserves per-source provenance", async () => {
    const api = observation("api", { items: [{ id: "thread-same", unanswered: true, unread: "unknown" }] });
    const browser = observation("browser", { threads: [{ id: "thread-same", unanswered: true, unread: false }] }, "complete");
    const tools = createLayeredToolHandlers({ router: createSourceRouter({ providers: [provider("api", api), provider("browser", browser)] }) });

    const queue = await tools.triageInbox({ source: "auto", limit: 10 });

    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ source: "api", unanswered: true, unread: false,
      sourceRefs: [{ source: "api", nativeRef: "api:inbox" }, { source: "browser", nativeRef: "browser:inbox" }] });
  });

  it("rejects unbounded or cross-account comment targets before reading any source", async () => {
    const read = vi.fn();
    const api: SourceProvider = { source: "api", status: async () => ({ source: "api", availability: "ready", capabilities: [] }), read };
    const tools = createLayeredToolHandlers({ router: createSourceRouter({ providers: [api] }) });

    await expect(tools.triageInbox({ source: "auto", limit: 10, commentTargets: Array.from({ length: 21 }, (_, index) => ({ accountBinding: "instagram:42", nativeId: `media-${index}` })) }))
      .rejects.toThrow(/At most 20/);
    await expect(tools.triageInbox({ source: "auto", limit: 10, commentTargets: [
      { accountBinding: "instagram:42", nativeId: "media-1" }, { accountBinding: "instagram:other", nativeId: "media-2" }
    ] })).rejects.toThrow(/one selected Instagram account/);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects host drafts that point outside the selected observation's native records", async () => {
    const selected = observation("browser", { items: [{ id: "thread-selected" }] });
    const router = createSourceRouter({ providers: [provider("browser", selected)], timeoutMs: 100 });
    const tools = createLayeredToolHandlers({ router, hostAnalysis: { async analyze() { return {
      summary: "draft", themes: [], actionsDraft: [{ source: "browser", target: { accountBinding: "instagram:42", nativeId: "thread-other" }, exactReply: "Hello" }],
      limitations: [], sourceRefs: [{ source: "browser", nativeRef: "browser:inbox", coverage: "partial" }],
      stats: { counts: {}, ages: {}, inboundOutbound: {}, ownerReplies: {}, commentLikesHidden: {}, sourceCoverage: {} }
    }; } } });

    await expect(tools.analyzeInbox({ selectedObservations: [selected], promptVersion: "v1" })).rejects.toThrow(/not bound/);
  });
});
