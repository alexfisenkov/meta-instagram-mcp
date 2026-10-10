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
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["comments.list"], accountBinding: "instagram:42", bridgeId: "bridge-1" }))
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
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42", bridgeId: "bridge-1" })),
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

  it("delivers a read through the exact bridge whose readiness passed", async () => {
    const selectedBridgeId = "bridge-selected";
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42", bridgeId: selectedBridgeId })),
      enqueue: vi.fn(async () => ({ id: "task-selected" })),
      result: vi.fn(async () => ({ status: "complete", result: observation("browser") }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });
    const context: { signal?: AbortSignal; deadlineAt?: number; companionBridgeId?: string } = {};

    expect(await provider.status("inbox.list", context)).toMatchObject({ availability: "ready", bridgeId: selectedBridgeId });
    const result = await provider.read({ operation: "inbox.list", limit: 4 }, context);

    expect(result.availability).toBe("ready");
    expect(context.companionBridgeId).toBe(selectedBridgeId);
    expect(hub.enqueue).toHaveBeenCalledWith(expect.objectContaining({ bridgeId: selectedBridgeId }));
    expect(vi.mocked(hub.sourceStatus).mock.calls.slice(1).every(([, , bridgeId]) => bridgeId === selectedBridgeId)).toBe(true);
  });

  it("does not reassign a selected bridge that becomes unavailable", async () => {
    const selectedBridgeId = "bridge-selected";
    const hub = {
      sourceStatus: vi.fn(async (_source: string, _binding?: string, bridgeId?: string) => bridgeId
        ? { source: "browser", availability: "not_connected", capabilities: [], accountBinding: "instagram:42", reason: "Selected companion expired." }
        : { source: "browser", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42", bridgeId: selectedBridgeId }),
      enqueue: vi.fn()
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42" });
    const context: { companionBridgeId?: string } = {};

    expect(await provider.status("inbox.list", context)).toMatchObject({ availability: "ready", bridgeId: selectedBridgeId });
    const result = await provider.read({ operation: "inbox.list", limit: 4 }, context);

    expect(result).toMatchObject({ availability: "offline", coverage: "unknown", errors: [{ code: "bridge_selection_unavailable" }] });
    expect(context.companionBridgeId).toBe(selectedBridgeId);
    expect(vi.mocked(hub.sourceStatus)).toHaveBeenLastCalledWith("browser", "instagram:42", selectedBridgeId, "inbox.list");
    expect(hub.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a browser inbox row ref pinned to its originating bridge after a newer heartbeat appears", async () => {
    let latestBridgeId = "bridge-mac";
    let currentOperation = "inbox.list";
    const rowRef = "browser-inbox-row:opaque-row-ref";
    const statuses: string[] = [];
    const hub = {
      sourceStatus: vi.fn(async (_source: string, accountBinding?: string, selectedBridgeId?: string) => {
        const bridgeId = selectedBridgeId ?? latestBridgeId;
        statuses.push(bridgeId);
        return { source: "browser", availability: "ready", capabilities: ["inbox.list", "conversation.read"],
          accountBinding: accountBinding ?? "instagram:42", bridgeId, accountHandle: "owner", surface: "instagram" };
      }),
      enqueue: vi.fn(async (input: { operation: string }) => { currentOperation = input.operation; return { id: `task-${input.operation}` }; }),
      result: vi.fn(async (taskId: string) => ({ status: "complete", result: currentOperation === "inbox.list"
        ? { ...observation("browser"), data: { items: [{ target: { accountBinding: "instagram:42", explicitOwnerRef: rowRef }, unread: "unknown" }] } }
        : { ...observation("browser"), nativeRef: "/direct/t/observed-route/", data: { threadNativeId: "observed-route", messages: [{ nativeId: "m-1", text: "bounded" }] } } }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });

    await provider.read({ operation: "inbox.list", limit: 2 });
    latestBridgeId = "bridge-server";
    const request = { operation: "conversation.read" as const, target: { accountBinding: "instagram:42", explicitOwnerRef: rowRef }, limit: 2 };
    const context: { companionBridgeId?: string } = {};
    await provider.prepareRead?.(request, context);
    expect(await provider.status("conversation.read", context)).toMatchObject({ availability: "ready", bridgeId: "bridge-mac" });
    const result = await provider.read(request, context);
    const repeatedRead = await provider.read(request, context);

    expect(result.availability).toBe("ready");
    expect(repeatedRead.availability).toBe("ready");
    expect(context.companionBridgeId).toBe("bridge-mac");
    expect(vi.mocked(hub.enqueue)).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "conversation.read", bridgeId: "bridge-mac",
      targetRefs: [{ accountBinding: "instagram:42", explicitOwnerRef: rowRef }] }));
    expect(statuses.slice(1).every((bridgeId) => bridgeId === "bridge-mac")).toBe(true);
  });

  it("fails closed when a browser inbox ref is unknown after provider restart", async () => {
    const hub = { sourceStatus: vi.fn(), enqueue: vi.fn() } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42" });
    const result = await provider.read({ operation: "conversation.read", target: {
      accountBinding: "instagram:42", explicitOwnerRef: "browser-inbox-row:lost-after-restart"
    }, limit: 2 });

    expect(result).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "stale_browser_inbox_ref" }] });
    expect(hub.sourceStatus).not.toHaveBeenCalled();
    expect(hub.enqueue).not.toHaveBeenCalled();
  });

  it("cancels a queued read on abort and stops polling the Hub", async () => {
    const controller = new AbortController();
    let markFirstPoll!: () => void;
    const firstPoll = new Promise<void>((resolve) => { markFirstPoll = resolve; });
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42", bridgeId: "bridge-1" })),
      enqueue: vi.fn(async () => ({ id: "task-cancel-me" })),
      result: vi.fn(async () => { markFirstPoll(); return { status: "queued" }; }),
      cancelReadTask: vi.fn(async () => true)
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 500, pollMs: 50 });
    const pending = provider.read({ operation: "inbox.list", limit: 5 }, { signal: controller.signal, deadlineAt: Date.now() + 500 });

    await firstPoll;
    controller.abort(new Error("caller read deadline expired"));
    const result = await pending;

    expect(result).toMatchObject({ availability: "offline", coverage: "unknown", errors: [{ code: "cancelled" }] });
    expect(hub.cancelReadTask).toHaveBeenCalledWith("task-cancel-me");
    expect(hub.result).toHaveBeenCalledOnce();
  });

  it("probes a registered browser and verifies the exact account before allowing automatic reads", async () => {
    const accountProbe = { ...observation("browser"), nativeRef: "/direct/inbox/", coverage: "complete" as const,
      historyCompleteness: "not_applicable" as const,
      data: { username: "owner", surface: "instagram", capabilities: ["inbox.list"] } };
    const statuses = [
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "ready", capabilities: ["account.inspect", "inbox.list"], accountBinding: "instagram:42",
        bridgeId: "bridge-1", accountHandle: "owner", surface: "instagram" }
    ];
    const hub = {
      sourceStatus: vi.fn(async () => statuses.shift() ?? { source: "browser", availability: "ready", capabilities: ["inbox.list"],
        accountBinding: "instagram:42", bridgeId: "bridge-1", accountHandle: "owner", surface: "instagram" }),
      enqueue: vi.fn(async () => ({ id: "account-inspect-task" })),
      result: vi.fn(async () => ({ status: "complete", result: accountProbe }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });
    const prepareRead = (provider as unknown as { prepareRead(request: unknown): Promise<void> }).prepareRead;
    expect(prepareRead).toBeTypeOf("function");

    await prepareRead.call(provider, { operation: "inbox.list", limit: 4 });

    expect(hub.enqueue).toHaveBeenCalledWith(expect.objectContaining({ operation: "account.inspect", accountBinding: "instagram:42" }));
    expect(hub.sourceStatus).toHaveBeenCalledTimes(3);
    expect(await provider.status("inbox.list")).toMatchObject({ availability: "ready", accountBinding: "instagram:42" });
  });

  it("keeps browser preflight bound to the selected conversation account", async () => {
    const calls: Array<string | undefined> = [];
    const ready = { source: "browser", availability: "ready", capabilities: ["conversation.read"], accountBinding: "instagram:42",
      bridgeId: "bridge-selected", accountHandle: "owner", surface: "instagram" };
    let sourceStatusCalls = 0;
    const hub = {
      sourceStatus: vi.fn(async (_source: string, accountBinding?: string) => {
        calls.push(accountBinding);
        sourceStatusCalls++;
        if (sourceStatusCalls === 1 || sourceStatusCalls === 2) return { source: "browser", availability: "offline", capabilities: [],
          accountBinding: "instagram:42", bridgeId: "bridge-selected" };
        return ready;
      }),
      enqueue: vi.fn(async (input: { accountBinding: string; operation: string }) => {
        expect(input.accountBinding).toBe("instagram:42");
        expect(input.operation).toBe("account.inspect");
        return { id: "account-inspect-selected" };
      }),
      result: vi.fn(async () => ({ status: "complete", result: { ...observation("browser"),
        data: { username: "owner", surface: "instagram", capabilities: ["conversation.read"] } } }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", waitMs: 50, pollMs: 5 });
    const prepareRead = (provider as unknown as { prepareRead(request: unknown): Promise<void> }).prepareRead;

    await prepareRead.call(provider, { operation: "conversation.read", target: { accountBinding: "instagram:42", nativeId: "thread-42" } });

    expect(calls).toEqual(["instagram:42", "instagram:42", "instagram:42"]);
    expect(hub.enqueue).toHaveBeenCalledOnce();
  });

  it("does not bootstrap when the browser is not registered", async () => {
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "not_connected", capabilities: [], reason: "No live companion." })),
      enqueue: vi.fn()
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser" });
    const prepareRead = (provider as unknown as { prepareRead(request: unknown): Promise<void> }).prepareRead;
    expect(prepareRead).toBeTypeOf("function");

    await prepareRead.call(provider, { operation: "inbox.list", limit: 4 });

    expect(hub.sourceStatus).toHaveBeenCalledOnce();
    expect(hub.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a browser probe whose verified account handle differs", async () => {
    const accountProbe = { ...observation("browser"), data: { username: "other-account", surface: "instagram", capabilities: ["inbox.list"] } };
    const statuses = [
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42",
        bridgeId: "bridge-1", accountHandle: "owner", surface: "instagram" }
    ];
    const hub = {
      sourceStatus: vi.fn(async () => statuses.shift() ?? { source: "browser", availability: "ready", capabilities: ["inbox.list"],
        accountBinding: "instagram:42", bridgeId: "bridge-1", accountHandle: "owner", surface: "instagram" }),
      enqueue: vi.fn(async () => ({ id: "account-inspect-task" })),
      result: vi.fn(async () => ({ status: "complete", result: accountProbe }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });
    const prepareRead = (provider as unknown as { prepareRead(request: unknown): Promise<void> }).prepareRead;

    await expect(prepareRead.call(provider, { operation: "inbox.list", limit: 4 })).rejects.toThrow(/did not verify/i);
  });

  it("translates an issued target-bound browser cursor into one bounded scroll page and rejects forged context", async () => {
    const target = { accountBinding: "instagram:42", nativeId: "thread-42" };
    let current = { ...observation("browser"), nativeRef: "/direct/t/thread-42/", data: { username: "fixture", messages: [], olderAvailable: true } };
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: ["conversation.read"], accountBinding: "instagram:42", bridgeId: "bridge-1" })),
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

  it.each([
    [{ operation: "inbox.list", limit: 5, cursor: "api-cursor-next" }, "inbox.list"],
    [{ operation: "comments.list", target: { accountBinding: "instagram:42", nativeId: "media-1" }, cursor: "api-cursor-next" }, "comments.list"],
    [{ operation: "comments.replies", target: { accountBinding: "instagram:42", nativeId: "comment-1" }, cursor: "api-cursor-next" }, "comments.replies"]
  ] as const)("fails closed when browser does not implement %s pagination", async (request, operation) => {
    const hub = {
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "ready", capabilities: [operation], accountBinding: "instagram:42", bridgeId: "bridge-1" })),
      enqueue: vi.fn(async () => ({ id: "unexpected-task" })),
      result: vi.fn(async () => ({ status: "complete", result: observation("browser") }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });

    const result = await provider.read(request as never);

    expect(result).toMatchObject({ availability: "unsupported", coverage: "unknown", errors: [{ code: "unsupported_cursor" }] });
    expect(hub.enqueue).not.toHaveBeenCalled();
  });

  it("keeps phone older-history cursors explicitly unsupported", async () => {
    const hub = { sourceStatus: vi.fn(async () => ({ source: "phone", availability: "ready", capabilities: ["conversation.read"], accountBinding: "instagram:42" })) } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "phone", accountBinding: "instagram:42" });
    const result = await provider.read({ operation: "conversation.read", target: { accountBinding: "instagram:42", nativeId: "thread-42" }, olderCursor: "browser-older:forged" });
    expect(result).toMatchObject({ availability: "unsupported", coverage: "unknown", errors: [{ code: "unsupported_cursor" }] });
  });
});
