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
