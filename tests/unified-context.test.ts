import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountContextResolver } from "../src/account-context.js";
import { createApiProvider } from "../src/api-provider.js";
import { createDirectDomain } from "../src/direct.js";
import { requestJsonHttp } from "../src/http-json.js";
import type { MetaInstagramConfig } from "../src/config.js";
import { createToolHandlers } from "../src/tools.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const config: MetaInstagramConfig = {
  authMode: "unified", appId: "123", appSecret: "sample-app-secret", userId: "1780001",
  accessToken: "sample-bisu", graphApiVersion: "v25.0", tokenStorePath: "/tmp/not-used-unified.json",
  publishLogPath: "/tmp/not-used-unified-log.jsonl"
};
const scopes = ["instagram_basic", "instagram_manage_messages", "instagram_manage_comments", "instagram_manage_insights"];

function transport(options: { wrongAccount?: boolean; missingMessages?: boolean; invalidToken?: boolean } = {}) {
  vi.mocked(requestJsonHttp).mockImplementation(async (url, init) => {
    if (init?.signal?.aborted) throw new Error("aborted");
    let body: unknown;
    if (url.pathname.endsWith("/debug_token")) body = { data: {
      is_valid: !options.invalidToken, type: "SYSTEM_USER", app_id: "123", user_id: "902", expires_at: 0, data_access_expires_at: 0,
      scopes: options.missingMessages ? ["instagram_basic", "instagram_manage_comments", "instagram_manage_insights"] : scopes
    } };
    else if (url.pathname.endsWith("/me/assigned_instagram_accounts")) body = { data: [{ id: options.wrongAccount ? "1780002" : "1780001", username: "fixture_owner" }] };
    else if (url.pathname.endsWith("/me")) body = { id: "902", client_business_id: "456" };
    else if (url.pathname.endsWith("/conversations")) body = { data: [{ id: "thread-1" }] };
    else body = { data: [] };
    return { ok: true, status: 200, body, text: JSON.stringify(body), attempts: [] };
  });
}

function resolver() {
  return createAccountContextResolver({ config: { ...config }, tokenStore: { load: async () => ({
    accessToken: "sample-other-mode-secret", authMode: "facebook", userId: "99999", pageId: "88888",
    permissions: ["instagram_content_publish", "pages_manage_metadata"]
  }) } });
}

describe("Unified account routing", () => {
  it("continues from Dashboard token discovery to basic reads with only a token-bound saved identity", async () => {
    let saved: import("../src/token-store.js").StoredInstagramToken | undefined;
    const env = { ...config, userId: undefined };
    transport();
    vi.mocked(requestJsonHttp).mockImplementation(async (url) => {
      const body = url.pathname.endsWith("/debug_token") ? { data: { is_valid: true, type: "SYSTEM_USER", app_id: "123", user_id: "902", scopes, expires_at: 0 } }
        : url.pathname.endsWith("/me/assigned_instagram_accounts") ? { data: [{ id: "1780001", username: "fixture_owner" }] }
        : url.pathname.endsWith("/me") ? { id: "902", client_business_id: "456" }
        : url.pathname.endsWith("/1780001") ? { id: "1780001", username: "fixture_owner" } : { data: [] };
      return { ok: true, status: 200, body, text: JSON.stringify(body), attempts: [] };
    });
    const handlers = createToolHandlers({ config: env, tokenStore: { load: async () => saved, save: async (next) => { saved = next; } } });
    await handlers.resolveInstagramAccount();
    await expect(handlers.getAccountInfo()).resolves.toMatchObject({ id: "1780001" });
    await handlers.listMedia({ limit: 1 });
    expect(vi.mocked(requestJsonHttp).mock.calls.some(([url]) => url.pathname.endsWith("/1780001/media"))).toBe(true);
    env.accessToken = "different-sample-bisu";
    await expect(handlers.getAccountInfo()).rejects.toThrow(/Missing Instagram user id/);
  });

  it("refuses a saved token from another login family when Unified is explicitly configured", async () => {
    const wrong = { accessToken: "legacy", authMode: "facebook" as const, userId: "1780001" };
    const selected = { ...config, accessToken: undefined };
    const resolve = createAccountContextResolver({ config: selected, tokenStore: { load: async () => wrong } });
    const handlers = createToolHandlers({ config: selected, tokenStore: { load: async () => wrong, save: vi.fn() } });
    await expect(resolve()).rejects.toThrow("TOKEN_STORE_AUTH_MODE_MISMATCH");
    await expect(handlers.getAccountInfo()).rejects.toThrow("TOKEN_STORE_AUTH_MODE_MISMATCH");
    expect(requestJsonHttp).not.toHaveBeenCalled();
  });
  it("verifies the environment BISU and discovers the pinned Instagram asset without a Page", async () => {
    transport();
    const ctx = await resolver()();
    expect(ctx).toMatchObject({ authMode: "unified", instagramUserId: "1780001", accountBinding: "instagram:1780001", confirmedScopes: scopes, scopeStatus: "confirmed" });
    expect(ctx.pageClient).toBeUndefined();
    expect(ctx.facebookPageId).toBeUndefined();
    const urls = vi.mocked(requestJsonHttp).mock.calls.map(([url]) => url);
    expect(urls.every((url) => url.hostname === "graph.facebook.com")).toBe(true);
    expect(urls.some((url) => url.pathname.endsWith("/debug_token"))).toBe(true);
    expect(urls.some((url) => url.pathname.endsWith("/me/assigned_instagram_accounts"))).toBe(true);
    expect(urls.some((url) => url.pathname.endsWith("/me/accounts"))).toBe(false);
    expect(JSON.stringify(ctx)).not.toContain("sample-bisu");
  });

  it("does not inherit stored permissions or identity for a selected environment credential", async () => {
    transport({ missingMessages: true });
    const provider = createApiProvider({ resolveContext: resolver() });
    const status = await provider.status("inbox.list");
    expect(status.availability).toBe("missing_scope");
    expect(status.scopes.confirmed).not.toContain("instagram_manage_messages");
    expect(status.scopes.confirmed).not.toContain("instagram_content_publish");
  });

  it("rejects an environment credential assigned to a different account before domain reads", async () => {
    transport({ wrongAccount: true });
    await expect(resolver()()).rejects.toThrow(/OAUTH_IDENTITY/);
    expect(vi.mocked(requestJsonHttp).mock.calls.some(([url]) => url.pathname.endsWith("/conversations"))).toBe(false);
  });

  it("routes Unified Direct to the Instagram asset on Facebook Graph without Page tasks", async () => {
    transport();
    const domain = createDirectDomain(resolver());
    const result = await domain.listConversations({ limit: 3 });
    expect(result.availability).toBe("ready");
    expect(vi.mocked(requestJsonHttp).mock.calls.some(([url]) => url.hostname === "graph.facebook.com" && url.pathname.endsWith("/1780001/conversations"))).toBe(true);
  });

  it("reports comments and insights readiness using Unified grants", async () => {
    transport();
    const provider = createApiProvider({ resolveContext: resolver() });
    expect((await provider.status("comments.list")).availability).toBe("ready");
    expect((await provider.status("insights.read")).availability).toBe("ready");
    const result = await provider.read({ operation: "comments.list", target: { accountBinding: "instagram:1780001", nativeId: "media-1" } });
    expect(result.availability).toBe("ready");
  });

  it("passes cancellation into Unified verification and does not continue after abort", async () => {
    transport();
    const controller = new AbortController();
    controller.abort();
    await expect(resolver()({ signal: controller.signal })).rejects.toThrow();
    expect(vi.mocked(requestJsonHttp).mock.calls.some(([url]) => url.pathname.endsWith("/me/assigned_instagram_accounts"))).toBe(false);
  });
});
