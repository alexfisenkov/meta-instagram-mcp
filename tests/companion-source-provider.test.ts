import { describe, expect, it, vi } from "vitest";
import { createCompanionSourceProvider } from "../src/companion-source-provider.js";
import type { CompanionHub } from "../src/companion-hub.js";
import { createSourceRouter, type SourceProvider } from "../src/source-router.js";

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

  it("discovers an older ready same-account browser after the newest account inspection fails, then pins inbox", async () => {
    let macVerified = false;
    let nextTask = 0;
    const assignments: Array<{ operation: string; bridgeId: string }> = [];
    const receipts = new Map<string, unknown>();
    const serverUnavailable = {
      source: "browser", nativeRef: "browser:unavailable", accountBinding: "instagram:42", capturedAt: "2026-10-10T00:00:00.000Z",
      availability: "needs_selection", coverage: "unknown", historyCompleteness: "unknown",
      errors: [{ code: "needs_selection", message: "The server browser account is not verified." }]
    };
    const inspectReady = {
      source: "browser", nativeRef: "/direct/inbox/", accountBinding: "instagram:42", capturedAt: "2026-10-10T00:00:01.000Z",
      availability: "ready", coverage: "complete", historyCompleteness: "not_applicable",
      data: { username: "owner", loggedIn: true, surface: "instagram", capabilities: ["account.inspect", "inbox.list"] }, errors: []
    };
    const inboxReady = {
      source: "browser", nativeRef: "/direct/inbox/", accountBinding: "instagram:42", capturedAt: "2026-10-10T00:00:02.000Z",
      availability: "ready", coverage: "partial", historyCompleteness: "limited",
      data: { username: "owner", items: [{ target: { accountBinding: "instagram:42", nativeId: "thread-mac" } }] }, errors: []
    };
    const hub = {
      readinessCandidates: vi.fn(async (_source: string, binding: string, operation: string) => [
        { bridgeId: "bridge-server", source: "browser", accountBinding: binding, declaredCapabilities: ["account.inspect", "inbox.list"], lastSeenAt: 200 },
        { bridgeId: "bridge-mac", source: "browser", accountBinding: binding, declaredCapabilities: ["account.inspect", "inbox.list"], lastSeenAt: 100 }
      ].filter((candidate) => candidate.declaredCapabilities.includes(operation))),
      sourceStatus: vi.fn(async (_source: string, binding = "instagram:42", selectedBridgeId?: string, operation?: string) => {
        const bridgeId = selectedBridgeId ?? (macVerified && operation === "inbox.list" ? "bridge-mac" : "bridge-server");
        if (bridgeId === "bridge-mac" && macVerified) return { source: "browser", availability: "ready", capabilities: ["account.inspect", "inbox.list"], accountBinding: binding, bridgeId, accountHandle: "owner", surface: "instagram" };
        return { source: "browser", availability: bridgeId === "bridge-server" ? "needs_selection" : "offline", capabilities: [], accountBinding: binding, bridgeId };
      }),
      enqueue: vi.fn(async (input: { operation: string; bridgeId: string }) => {
        const id = `task-${++nextTask}`;
        assignments.push({ operation: input.operation, bridgeId: input.bridgeId });
        const result = input.operation === "account.inspect"
          ? input.bridgeId === "bridge-server" ? serverUnavailable : inspectReady
          : inboxReady;
        if (input.bridgeId === "bridge-mac" && input.operation === "account.inspect") macVerified = true;
        receipts.set(id, { status: "complete", result });
        return { id };
      }),
      result: vi.fn(async (id: string) => receipts.get(id))
    } as unknown as CompanionHub;
    const apiProvider = {
      source: "api",
      status: async () => ({ source: "api", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42" }),
      read: async () => ({ source: "api", nativeRef: "api:unavailable", accountBinding: "instagram:42", capturedAt: "2026-10-10T00:00:00.000Z",
        availability: "missing_scope", coverage: "unknown", historyCompleteness: "unknown", errors: [{ code: "missing_scope", message: "Direct scope is unavailable." }] })
    } as unknown as SourceProvider;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });
    const router = createSourceRouter({ providers: [apiProvider, provider], timeoutMs: 3_000 });

    const routed = await router.read({ operation: "inbox.list", limit: 5 });

    expect(routed.triedSources).toEqual(["api", "browser"]);
    expect(routed.observations).toHaveLength(2);
    expect(routed.observations[0]).toMatchObject({ source: "api", availability: "missing_scope", coverage: "unknown" });
    expect(routed.observations[1]).toMatchObject({ availability: "ready", data: { items: [{ target: { nativeId: "thread-mac" } }] } });
    expect(assignments).toEqual([
      { operation: "account.inspect", bridgeId: "bridge-server" },
      { operation: "account.inspect", bridgeId: "bridge-mac" },
      { operation: "inbox.list", bridgeId: "bridge-mac" }
    ]);
    expect(hub.readinessCandidates).toHaveBeenCalledWith("browser", "instagram:42", "inbox.list");
  });

  it("returns the first successful pure account.inspect probe without reading that bridge twice", async () => {
    let macVerified = false;
    const assignments: string[] = [];
    const receipts = new Map<string, unknown>();
    const hub = {
      readinessCandidates: vi.fn(async () => [
        { bridgeId: "bridge-server", source: "browser", accountBinding: "instagram:42", declaredCapabilities: ["account.inspect"] },
        { bridgeId: "bridge-mac", source: "browser", accountBinding: "instagram:42", declaredCapabilities: ["account.inspect"] }
      ]),
      sourceStatus: vi.fn(async (_source: string, binding: string, bridgeId?: string) => bridgeId === "bridge-mac" && macVerified
        ? { source: "browser", availability: "ready", capabilities: ["account.inspect"], accountBinding: binding, bridgeId,
          accountHandle: "owner", surface: "instagram" }
        : { source: "browser", availability: "needs_selection", capabilities: [], accountBinding: binding, bridgeId: bridgeId ?? "bridge-server" }),
      enqueue: vi.fn(async (input: { bridgeId: string }) => {
        const id = `inspect-${assignments.length + 1}`;
        assignments.push(input.bridgeId);
        const result = input.bridgeId === "bridge-server"
          ? { ...observation("browser"), availability: "needs_selection", coverage: "unknown", historyCompleteness: "unknown", data: undefined }
          : { ...observation("browser"), nativeRef: "/direct/inbox/", coverage: "complete", historyCompleteness: "not_applicable",
            data: { username: "owner", accountBinding: "instagram:42", surface: "instagram", capabilities: ["account.inspect"] } };
        if (input.bridgeId === "bridge-mac") macVerified = true;
        receipts.set(id, { status: "complete", result });
        return { id };
      }),
      result: vi.fn(async (id: string) => receipts.get(id))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });

    const result = await provider.read({ operation: "account.inspect", accountBinding: "instagram:42" });

    expect(result).toMatchObject({ availability: "ready", accountBinding: "instagram:42", data: { username: "owner" } });
    expect(assignments).toEqual(["bridge-server", "bridge-mac"]);
    expect(hub.enqueue).toHaveBeenCalledTimes(2);
  });

  it("does not discover another bridge for an explicit account selection or mismatched binding", async () => {
    const readinessCandidates = vi.fn(async () => [
      { bridgeId: "bridge-server", source: "browser", accountBinding: "instagram:42", declaredCapabilities: ["account.inspect"] },
      { bridgeId: "bridge-mac", source: "browser", accountBinding: "instagram:42", declaredCapabilities: ["account.inspect"] }
    ]);
    const hub = {
      readinessCandidates,
      sourceStatus: vi.fn(async (_source: string, binding: string, bridgeId?: string) => ({ source: "browser", availability: "needs_selection",
        capabilities: [], accountBinding: binding, bridgeId: bridgeId ?? "bridge-server" })),
      enqueue: vi.fn(async () => ({ id: "pinned-inspect" })),
      result: vi.fn(async () => ({ status: "complete", result: { ...observation("browser"), availability: "needs_selection", coverage: "unknown",
        historyCompleteness: "unknown", data: undefined, errors: [{ code: "needs_selection", message: "owner verification failed" }] } }))
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 50, pollMs: 5 });

    const wrongBinding = await provider.read({ operation: "account.inspect", accountBinding: "instagram:other" });
    const pinned = await provider.read({ operation: "account.inspect", accountBinding: "instagram:42" },
      { companionBridgeId: "bridge-server", companionBridgeSelection: "pinned" });

    expect(wrongBinding).toMatchObject({ availability: "needs_selection", errors: [{ code: "account_binding_mismatch" }] });
    expect(pinned).toMatchObject({ availability: "needs_selection", errors: [{ code: "needs_selection" }] });
    expect(readinessCandidates).not.toHaveBeenCalled();
    expect(hub.enqueue).toHaveBeenCalledOnce();
    expect(hub.enqueue).toHaveBeenCalledWith(expect.objectContaining({ bridgeId: "bridge-server" }));
  });

  it("cancels the active readiness probe and does not start the next candidate after caller abort", async () => {
    const controller = new AbortController();
    let markFirstPoll!: () => void;
    const firstPoll = new Promise<void>((resolve) => { markFirstPoll = resolve; });
    const hub = {
      readinessCandidates: vi.fn(async () => [
        { bridgeId: "bridge-server", source: "browser", accountBinding: "instagram:42", declaredCapabilities: ["account.inspect", "inbox.list"] },
        { bridgeId: "bridge-mac", source: "browser", accountBinding: "instagram:42", declaredCapabilities: ["account.inspect", "inbox.list"] }
      ]),
      sourceStatus: vi.fn(async (_source: string, binding: string, bridgeId?: string) => ({ source: "browser", availability: "offline",
        capabilities: [], accountBinding: binding, bridgeId: bridgeId ?? "bridge-server" })),
      enqueue: vi.fn(async (input: { bridgeId: string }) => ({ id: `probe-${input.bridgeId}` })),
      result: vi.fn(async () => { markFirstPoll(); return { status: "queued" }; }),
      cancelReadTask: vi.fn(async () => true)
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42", waitMs: 500, pollMs: 50 });
    const pending = provider.prepareRead?.({ operation: "inbox.list", limit: 5 },
      { signal: controller.signal, deadlineAt: Date.now() + 1_000 });

    await firstPoll;
    controller.abort(new Error("caller read deadline expired"));
    await expect(pending).rejects.toThrow(/caller read deadline expired/);

    expect(hub.enqueue).toHaveBeenCalledOnce();
    expect(hub.enqueue).toHaveBeenCalledWith(expect.objectContaining({ bridgeId: "bridge-server", operation: "account.inspect" }));
    expect(hub.cancelReadTask).toHaveBeenCalledWith("probe-bridge-server");
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
      data: { username: "owner", accountBinding: "instagram:42", surface: "instagram", capabilities: ["account.inspect", "inbox.list"] } };
    const statuses = [
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "ready", capabilities: ["account.inspect", "inbox.list"], accountBinding: "instagram:42",
        bridgeId: "bridge-1", accountHandle: "owner", surface: "instagram" }
    ];
    const hub = {
      readinessCandidates: vi.fn(async (_source: string, accountBinding: string, operation: string) => [{ bridgeId: "bridge-1", source: "browser",
        accountBinding, declaredCapabilities: ["account.inspect", "inbox.list"] }].filter((candidate) => candidate.declaredCapabilities.includes(operation))),
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
    const ready = { source: "browser", availability: "ready", capabilities: ["account.inspect", "conversation.read"], accountBinding: "instagram:42",
      bridgeId: "bridge-selected", accountHandle: "owner", surface: "instagram" };
    let sourceStatusCalls = 0;
    const hub = {
      readinessCandidates: vi.fn(async (_source: string, accountBinding: string, operation: string) => [{ bridgeId: "bridge-selected", source: "browser",
        accountBinding, declaredCapabilities: ["account.inspect", "conversation.read"] }].filter((candidate) => candidate.declaredCapabilities.includes(operation))),
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
        data: { username: "owner", accountBinding: "instagram:42", surface: "instagram", capabilities: ["account.inspect", "conversation.read"] } } }))
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

  it("does not inspect browser candidates for unsupported cursor or insights operations", async () => {
    const readinessCandidates = vi.fn(async () => [{ bridgeId: "bridge-1", source: "browser", accountBinding: "instagram:42",
      declaredCapabilities: ["account.inspect", "inbox.list", "insights.read"] }]);
    const hub = {
      readinessCandidates,
      sourceStatus: vi.fn(async () => ({ source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" })),
      enqueue: vi.fn()
    } as unknown as CompanionHub;
    const provider = createCompanionSourceProvider({ hub, source: "browser", accountBinding: "instagram:42" });

    await provider.prepareRead?.({ operation: "inbox.list", limit: 5, cursor: "cursor-page-2" });
    await provider.prepareRead?.({ operation: "insights.read", period: "day" });
    const cursorRead = await provider.read({ operation: "inbox.list", limit: 5, cursor: "cursor-page-2" });

    expect(cursorRead).toMatchObject({ availability: "unsupported", coverage: "unknown", errors: [{ code: "unsupported_cursor" }] });
    expect(readinessCandidates).not.toHaveBeenCalled();
    expect(hub.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a browser probe whose verified account handle differs", async () => {
    const accountProbe = { ...observation("browser"), data: { username: "other-account", accountBinding: "instagram:42", surface: "instagram", capabilities: ["account.inspect", "inbox.list"] } };
    const statuses = [
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "offline", capabilities: [], accountBinding: "instagram:42", bridgeId: "bridge-1" },
      { source: "browser", availability: "ready", capabilities: ["inbox.list"], accountBinding: "instagram:42",
        bridgeId: "bridge-1", accountHandle: "owner", surface: "instagram" }
    ];
    const hub = {
      readinessCandidates: vi.fn(async (_source: string, accountBinding: string, operation: string) => [{ bridgeId: "bridge-1", source: "browser",
        accountBinding, declaredCapabilities: ["account.inspect", "inbox.list"] }].filter((candidate) => candidate.declaredCapabilities.includes(operation))),
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
