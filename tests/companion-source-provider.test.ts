import { describe, expect, it, vi } from "vitest";
import { createCompanionSourceProvider } from "../src/companion-source-provider.js";
import type { CompanionHub } from "../src/companion-hub.js";

function observation(source: "browser" | "phone", accountBinding = "instagram:42") {
  return {
    source, nativeRef: `${source}:inbox`, accountBinding, capturedAt: "2026-10-06T00:00:00.000Z",
    availability: "ready" as const, coverage: "partial" as const, historyCompleteness: "limited" as const,
    data: { items: [{ id: "m-1", unread: true, unanswered: "unknown" }] }, errors: []
  };
}

describe("companion source provider", () => {
  it("uses live per-operation readiness instead of registration capabilities", async () => {
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["comments.list"], accountBinding: "instagram:42" }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42" });

    expect(await provider.status("inbox.list")).toMatchObject({
      source: "browser", availability: "unsupported", capabilities: ["comments.list"], accountBinding: "instagram:42"
    });
    expect(await provider.status("comments.list")).toMatchObject({ source: "browser", availability: "ready" });
  });

  it("preserves the companion observation provenance and unknown triage state", async () => {
    const result = observation("browser");
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42" })),
      enqueue: vi.fn(async () => ({ id: "task-1" })),
      result: vi.fn(async () => ({ status: "complete", result }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", waitMs: 50, pollMs: 5 });

    const actual = await provider.read({ operation: "inbox.list", limit: 4 });

    expect(actual).toEqual(result);
    expect(hub.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "read", source: "browser", operation: "inbox.list", payload: { limit: 4 }, targetRefs: []
    }));
  });

  it("translates an issued target-bound browser cursor into one bounded scroll page and rejects forged context", async () => {
    const target = { accountBinding: "instagram:42", nativeId: "thread-42" };
    let current = { ...observation("browser"), nativeRef: "/direct/t/thread-42/", data: { username: "fixture", messages: [], olderAvailable: true } };
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["conversation.read"], accountBinding: "instagram:42" })),
      enqueue: vi.fn(async () => ({ id: "task-older" })),
      result: vi.fn(async () => ({ status: "complete", result: current }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });

    const first = await provider.read({ operation: "conversation.read", target, limit: 12 });
    expect(first.pagination).toMatchObject({ hasOlder: true, pageBudget: 1 });
    const cursor = first.pagination?.olderCursor;
    expect(cursor).toMatch(/^browser-older:/);
    current = { ...current, data: { username: "fixture", messages: [], olderAvailable: true } };
    const older = await provider.read({ operation: "conversation.read", target, limit: 12, olderCursor: cursor });

    expect(older.pagination).toMatchObject({ hasOlder: true, pageBudget: 2 });
    expect(hub.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "conversation.read", payload: { limit: 12, pages: 1 }, targetRefs: [target] }));
    const before = vi.mocked(hub.enqueue).mock.calls.length;
    const forged = await provider.read({ operation: "conversation.read", target: { ...target, nativeId: "thread-other" }, limit: 12, olderCursor: cursor });
    expect(forged.errors[0]?.code).toBe("invalid_older_cursor");
    expect(vi.mocked(hub.enqueue)).toHaveBeenCalledTimes(before);
  });

  it("keeps phone older-history cursors explicitly unsupported", async () => {
    const hub = { sourceStatus: vi.fn(async () => ({ source: "phone", availability: "ready", capabilities: ["conversation.read"], accountBinding: "instagram:42" })) } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "phone", accountBinding: "instagram:42" });
    const result = await provider.read({ operation: "conversation.read", target: { accountBinding: "instagram:42", nativeId: "thread-42" }, olderCursor: "browser-older:forged" });
    expect(result).toMatchObject({ availability: "unsupported", coverage: "unknown", errors: [{ code: "unsupported_cursor" }] });
  });
});
