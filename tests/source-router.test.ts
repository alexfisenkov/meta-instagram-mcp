import { describe, expect, it, vi } from "vitest";
import { createSourceRouter, defaultSourceRouterTimeoutMs, type SourceProvider } from "../src/source-router.js";
import type { Observation } from "../src/domain-types.js";

const observation = (source: Observation<unknown>["source"], overrides: Partial<Observation<unknown>> = {}): Observation<unknown> => ({
  source, nativeRef: `${source}:inbox`, accountBinding: "acct:fixture", capturedAt: "2026-10-06T12:00:00.000Z",
  availability: "ready", coverage: "complete", historyCompleteness: "complete", data: { rows: [source] }, errors: [], ...overrides
});

const provider = (source: "api" | "browser" | "phone", result: Observation<unknown>): SourceProvider => ({
  source,
  status: async () => ({ source, availability: "ready", capabilities: ["inbox.list"] }),
  read: vi.fn(async () => result)
});

describe("SourceRouter", () => {
  it("keeps the Windows shared read budget below the MCP client's default request deadline", () => {
    expect(defaultSourceRouterTimeoutMs("win32")).toBe(50_000);
    expect(defaultSourceRouterTimeoutMs("win32")).toBeLessThan(60_000);
    expect(defaultSourceRouterTimeoutMs("darwin")).toBe(12_000);
  });

  it("uses one shared budget across preflight, read, and later providers", async () => {
    vi.useFakeTimers();
    const browser = provider("browser", observation("browser"));
    const prepareRead = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
    const status = vi.fn(async () => ({ source: "browser", availability: "ready" as const, capabilities: ["inbox.list"], accountBinding: "acct:fixture" }));
    const read = vi.fn(() => new Promise<Observation<unknown>>((resolve) => setTimeout(() => resolve(observation("browser")), 30)));
    Object.assign(browser, { prepareRead, status, read });
    const phone = provider("phone", observation("phone"));
    const phoneStatus = vi.fn(phone.status);
    Object.assign(phone, { status: phoneStatus });
    const router = createSourceRouter({ providers: [browser, phone], timeoutMs: 50 });
    try {
      const pending = router.read({ operation: "inbox.list", limit: 5 });
      await vi.advanceTimersByTimeAsync(30);
      expect(prepareRead).toHaveBeenCalledOnce();
      expect(status).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20);
      const result = await pending;
      expect(result.triedSources).toEqual(["browser"]);
      expect(result.observations).toMatchObject([{ availability: "offline", coverage: "unknown", errors: [{ code: "timeout" }] }]);
      expect(result.coverage).toBe("unknown");
      expect(phoneStatus).not.toHaveBeenCalled();
      expect(phone.read).not.toHaveBeenCalled();
      expect(result.skippedSources).toContainEqual({ source: "phone", reason: "The shared read budget expired." });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("uses API first and stops after complete coverage", async () => {
    const api = provider("api", observation("api"));
    const browser = provider("browser", observation("browser"));
    const phone = provider("phone", observation("phone"));
    const router = createSourceRouter({ providers: [phone, browser, api], timeoutMs: 100, maxProviders: 3 });

    const result = await router.read({ operation: "inbox.list", limit: 5 });

    expect(result.triedSources).toEqual(["api"]);
    expect(result.observations).toEqual([observation("api")]);
    expect(api.read).toHaveBeenCalledOnce();
    expect(browser.read).not.toHaveBeenCalled();
    expect(phone.read).not.toHaveBeenCalled();
  });

  it("falls back in source order when prior coverage is partial", async () => {
    const api = provider("api", observation("api", { coverage: "partial", historyCompleteness: "limited" }));
    const browser = provider("browser", observation("browser"));
    const phone = provider("phone", observation("phone"));
    const router = createSourceRouter({ providers: [api, browser, phone], timeoutMs: 100 });

    const result = await router.read({ operation: "inbox.list", limit: 5 });

    expect(result.triedSources).toEqual(["api", "browser"]);
    expect(result.observations.map((item) => item.source)).toEqual(["api", "browser"]);
    expect(result.coverage).toBe("complete");
    expect(result.historyCompleteness).toBe("limited");
    expect(phone.read).not.toHaveBeenCalled();
  });

  it("rejects a selected target without a native or explicit owner identity", async () => {
    const api = provider("api", observation("api"));
    const router = createSourceRouter({ providers: [api] });

    const result = await router.read({ operation: "conversation.read", target: { accountBinding: "acct:fixture" }, limit: 5 });

    expect(result.coverage).toBe("unknown");
    expect(result.triedSources).toEqual([]);
    expect(result.errors[0]?.code).toBe("needs_selection");
    expect(api.read).not.toHaveBeenCalled();
  });

  it("records unavailable sources and falls through without calling their read port", async () => {
    const api = provider("api", observation("api"));
    api.status = async () => ({ source: "api", availability: "offline", capabilities: [], reason: "token store offline" });
    const browser = provider("browser", observation("browser"));
    const router = createSourceRouter({ providers: [api, browser], timeoutMs: 100 });

    const result = await router.read({ operation: "inbox.list", limit: 5 });

    expect(result.triedSources).toEqual(["browser"]);
    expect(result.observations.map((item) => item.source)).toEqual(["browser"]);
    expect(result.skippedSources).toEqual([{ source: "api", reason: "token store offline" }]);
    expect(api.read).not.toHaveBeenCalled();
  });

  it("preflights a registered browser before an automatic read and then rechecks operation readiness", async () => {
    const api = provider("api", observation("api"));
    api.status = async () => ({ source: "api", availability: "missing_scope", capabilities: [], reason: "Direct scope missing" });
    const browser = provider("browser", observation("browser"));
    let browserReady = false;
    const prepareRead = vi.fn(async () => { browserReady = true; });
    Object.assign(browser, {
      prepareRead,
      status: async () => ({ source: "browser", availability: browserReady ? "ready" as const : "offline" as const,
        capabilities: browserReady ? ["inbox.list"] : [], reason: browserReady ? undefined : "registered, account verification pending" })
    });
    const router = createSourceRouter({ providers: [api, browser], timeoutMs: 100 });

    const result = await router.read({ operation: "inbox.list", limit: 5 });

    expect(prepareRead).toHaveBeenCalledOnce();
    expect(result.triedSources).toEqual(["browser"]);
    expect(result.observations).toEqual([observation("browser")]);
  });

  it("does not preflight or contact a browser that has no registered bridge", async () => {
    const browser = provider("browser", observation("browser"));
    const prepareRead = vi.fn();
    browser.status = async () => ({ source: "browser", availability: "not_connected", capabilities: [], reason: "No bridge id" });
    Object.assign(browser, { prepareRead });
    const router = createSourceRouter({ providers: [browser], timeoutMs: 100 });

    const result = await router.read({ operation: "inbox.list", limit: 5 });

    expect(prepareRead).toHaveBeenCalledOnce();
    expect(result.triedSources).toEqual([]);
    expect(browser.read).not.toHaveBeenCalled();
  });

  it("skips a stale-ready browser after preflight identity mismatch and falls back to another provider", async () => {
    const api = provider("api", observation("api"));
    api.status = async () => ({ source: "api", availability: "missing_scope", capabilities: [], reason: "Direct scope missing" });
    const browser = provider("browser", observation("browser"));
    const status = vi.fn(async () => ({ source: "browser", availability: "ready" as const, capabilities: ["inbox.list"], accountBinding: "acct:fixture" }));
    const read = vi.fn(async () => observation("browser"));
    Object.assign(browser, { status, read, prepareRead: async () => { throw new Error("verified account does not match browser session"); } });
    const phone = provider("phone", observation("phone"));
    const router = createSourceRouter({ providers: [api, browser, phone], timeoutMs: 100 });

    const result = await router.read({ operation: "inbox.list", limit: 5 });

    expect(browser.status).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(result.triedSources).toEqual(["phone"]);
    expect(result.observations).toEqual([observation("phone")]);
    expect(result.errors).toContainEqual(expect.objectContaining({ source: "browser", code: "preflight_failed" }));
  });

  it("does not call a provider status or read after its account preflight times out", async () => {
    const browser = provider("browser", observation("browser"));
    const prepareRead = vi.fn(() => new Promise<void>(() => {}));
    const status = vi.fn(async () => ({ source: "browser", availability: "ready" as const, capabilities: ["inbox.list"] }));
    const read = vi.fn(async () => observation("browser"));
    Object.assign(browser, { prepareRead, status, read });
    const router = createSourceRouter({ providers: [browser], timeoutMs: 10 });

    const result = await router.read({ operation: "inbox.list", limit: 5 });

    expect(status).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(result.triedSources).toEqual([]);
    expect(result.coverage).toBe("unknown");
    expect(result.errors).toContainEqual(expect.objectContaining({ source: "browser", code: "preflight_timeout" }));
  });

  it("accepts an exact Instagram URL as a selected native target", async () => {
    const api = provider("api", observation("api", { nativeRef: "/direct/t/thread-1" }));
    const router = createSourceRouter({ providers: [api], timeoutMs: 100 });

    const result = await router.read({ operation: "conversation.read", target: {
      accountBinding: "acct:fixture", instagramUrl: "https://www.instagram.com/direct/t/thread-1/"
    }, limit: 5 });

    expect(result.triedSources).toEqual(["api"]);
    expect(result.observations).toHaveLength(1);
  });
});
