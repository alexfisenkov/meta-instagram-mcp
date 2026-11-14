import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
import { requestJsonHttp } from "../src/http-json.js";
import { buildAuthUrl, defaultScopesForAuthMode, exchangeCodeForLongLivedToken, getScopePresets, refreshLongLivedToken } from "../src/oauth.js";
import { loadConfig } from "../src/config.js";
import { OAuthStateStore } from "../src/oauth-state.js";
import { readUnifiedGrantedPermissions, verifyOAuthAccountIdentity } from "../src/oauth-account-identity.js";
import { jsonHttpResponse } from "./helpers/json-http.js";

const http = vi.mocked(requestJsonHttp);
const config = { authMode: "unified" as const, graphApiVersion: "v27.0", appId: "123", appSecret: "app-secret" };
const token = { authMode: "unified" as const, accessToken: "bisu-secret" };
const proof = { data: { is_valid: true, app_id: "123", type: "SYSTEM_USER", user_id: "system-user", scopes: ["instagram_basic", "instagram_manage_insights"], expires_at: 0, data_access_expires_at: 0 } };
const options = { authMode: "unified" as const, appId: "123", configId: "456", redirectUri: "https://callback.example/callback", scopes: ["instagram_basic"], code: "one-use", appSecret: "app-secret", graphApiVersion: "v27.0" };
afterEach(() => { http.mockReset(); });

describe("portable Unified Login", () => {
  it("normalizes exact numeric granular targets and rejects unsafe numeric identifiers", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data: { ...proof.data, granular_scopes: [{ scope: "instagram_basic", target_ids: [1784001] }] } }));
    await expect(readUnifiedGrantedPermissions(config, { ...token, userId: "1784001" })).resolves.toContain("instagram_basic");
    http.mockResolvedValueOnce(jsonHttpResponse({ data: { ...proof.data, granular_scopes: [{ scope: "instagram_basic", target_ids: [Number.MAX_SAFE_INTEGER + 1] }] } }));
    await expect(readUnifiedGrantedPermissions(config, { ...token, userId: "1784001" })).rejects.toThrow("OAUTH_PERMISSIONS_UNVERIFIED");
  });
  it("does not require Page permissions or optional analytics to establish Unified Login", () => {
    expect(defaultScopesForAuthMode("unified")).toEqual(["instagram_basic"]);
    for (const preset of Object.values(getScopePresets("unified"))) {
      expect(preset.some((scope) => scope.startsWith("pages_"))).toBe(false);
    }
    expect(getScopePresets("unified").inbox).toEqual(["instagram_basic", "instagram_manage_messages"]);
    expect(getScopePresets("facebook").analytics).toContain("pages_show_list");
  });
  it.each(["0", "00", " 123", "1".repeat(65)])("rejects placeholder or malformed Unified app/config identifiers: %s", async (id) => {
    expect(() => buildAuthUrl({ ...options, configId: id })).toThrow("UNIFIED_CONFIG_ID_REQUIRED");
    expect(() => buildAuthUrl({ ...options, appId: id })).toThrow("UNIFIED_CONFIG_ID_REQUIRED");
    const store = new OAuthStateStore({ directory: join(tmpdir(), "unused-unified-state") });
    await expect(store.issue({ accountBinding: "unified:configured", authMode: "unified", appId: "123", configId: id, redirectUri: options.redirectUri })).rejects.toThrow("UNIFIED_CONFIG_ID_REQUIRED");
  });
  it("loads a distinct auth mode/configuration and rejects unknown modes", () => {
    expect(loadConfig({ META_AUTH_MODE: "unified", META_INSTAGRAM_CONFIG_ID: "456" })).toMatchObject({ authMode: "unified", configId: "456", graphApiVersion: "v27.0" });
    expect(() => loadConfig({ META_AUTH_MODE: "instgram" })).toThrow("Unsupported META_AUTH_MODE");
    expect(getScopePresets("unified").analytics).toContain("instagram_basic");
  });
  it("uses the configuration-based Facebook dialog without inline scopes", () => {
    const url = buildAuthUrl(options);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "123", config_id: "456", response_type: "code", prompt: "login", display: "popup", override_default_response_type: "true" });
    expect(url.searchParams.has("scope")).toBe(false);
    expect(() => buildAuthUrl({ ...options, configId: undefined })).toThrow("UNIFIED_CONFIG_ID_REQUIRED");
    expect(() => buildAuthUrl({ ...options, redirectUri: "http://localhost:8787/callback" })).toThrow("UNIFIED_HTTPS_REDIRECT_REQUIRED");
  });
  it("exchanges code once for BISU without a user-token long-lived exchange", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ access_token: "bisu", token_type: "bearer", user_id: "not-instagram" }));
    const result = await exchangeCodeForLongLivedToken(options);
    expect(result).toMatchObject({ accessToken: "bisu", authMode: "unified" });
    expect(result.userId).toBeUndefined();
    expect(http).toHaveBeenCalledOnce();
    const [url, init] = http.mock.calls[0]!;
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v27.0/oauth/access_token");
    expect(url.searchParams.get("redirect_uri")).toBe(options.redirectUri);
    expect(url.searchParams.has("grant_type")).toBe(false);
    expect(init?.allowRouteRetry).toBe(false);
  });
  it("requires reauthorization rather than attempting the wrong refresh flow", async () => {
    await expect(refreshLongLivedToken({ ...config, accessToken: "bisu" })).rejects.toThrow("UNIFIED_REAUTH_REQUIRED");
    expect(http).not.toHaveBeenCalled();
  });
  it("pins app and configuration in state without consuming a mismatched flow", async () => {
    const store = new OAuthStateStore({ directory: await mkdtemp(join(tmpdir(), "unified-state-")) });
    const binding = { accountBinding: "unified:configured", authMode: "unified" as const, appId: "123", configId: "456", redirectUri: options.redirectUri };
    const state = await store.issue(binding);
    await expect(store.consume(state, { ...binding, configId: "789" })).resolves.toBeUndefined();
    await expect(store.consume(state, { ...binding, appId: "789" })).resolves.toBeUndefined();
    await expect(store.consume(state, binding)).resolves.toMatchObject(binding);
    await expect(store.issue({ ...binding, redirectUri: "http://localhost:8787/callback" })).rejects.toThrow("UNIFIED_HTTPS_REDIRECT_REQUIRED");
  });
  it("uses verified grants and assigned accounts, never SYSTEM_USER id as Instagram id", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse(proof));
    const client = { get: vi.fn(async (path: string) => path === "/me" ? { id: "system-user", client_business_id: "business" } : { data: [{ id: "ig-1", username: "creator" }] }), forFacebookPage: vi.fn() };
    await expect(verifyOAuthAccountIdentity(config, { ...token, permissions: ["made_up"], userId: "system-user" }, {}, () => client as never)).resolves.toEqual({ userId: "ig-1", clientBusinessId: "business", permissions: proof.data.scopes });
    expect(client.forFacebookPage).not.toHaveBeenCalled();
    expect(client.get.mock.calls.map(([path]) => path)).toEqual(["/me", "/me/assigned_instagram_accounts"]);
  });
  it("selects only the explicitly pinned account from a complete assigned list", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse(proof));
    const client = { get: vi.fn(async (path: string) => path === "/me" ? { id: "system-user", client_business_id: "business" } : { data: [{ id: "ig-1", username: "one" }, { id: "ig-2", username: "two" }] }), forFacebookPage: vi.fn() };
    await expect(verifyOAuthAccountIdentity(config, token, { expectedAccountId: "ig-2" }, () => client as never)).resolves.toMatchObject({ userId: "ig-2" });
  });
  it.each([
    { data: [] },
    { data: [{ id: "ig-1", username: "one" }, { id: "ig-2", username: "two" }] },
    { data: [{ id: "ig-1", username: "one" }], paging: { next: "https://unsafe.example/next" } },
    { data: [{ id: "ig-1" }] },
  ])("rejects incomplete or ambiguous discovery %#", async (accounts) => {
    http.mockResolvedValueOnce(jsonHttpResponse(proof));
    const client = { get: vi.fn(async (path: string) => path === "/me" ? { id: "system-user", client_business_id: "business" } : accounts), forFacebookPage: vi.fn() };
    await expect(verifyOAuthAccountIdentity(config, token, {}, () => client as never)).rejects.toThrow(/OAUTH_IDENTITY_/);
  });
  it.each([
    { ...proof.data, type: "USER" },
    { ...proof.data, app_id: "wrong" },
    { ...proof.data, is_valid: false },
    { ...proof.data, scopes: ["instagram_manage_messages"] },
    { ...proof.data, scopes: ["instagram_basic", "token=private"] },
    { ...proof.data, expires_at: 1 },
    { ...proof.data, expires_at: "0" },
  ])("rejects unverified BISU grants %#", async (data) => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data }));
    await expect(readUnifiedGrantedPermissions(config, token)).rejects.toThrow("OAUTH_PERMISSIONS_UNVERIFIED");
  });
  it("reads scopes only through app-bound live inspection", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse(proof));
    await expect(readUnifiedGrantedPermissions(config, { ...token, permissions: ["made_up"] })).resolves.toEqual(proof.data.scopes);
    const [url, init] = http.mock.calls[0]!;
    expect(url.pathname).toBe("/v27.0/debug_token");
    expect(init?.allowRouteRetry).toBe(false);
    expect(init?.headers).toMatchObject({ authorization: "Bearer 123|app-secret" });
  });
  it("filters granular grants against the selected Instagram resource", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data: { ...proof.data, granular_scopes: [{ scope: "instagram_manage_insights", target_ids: ["ig-2"] }] } }));
    await expect(readUnifiedGrantedPermissions(config, { ...token, userId: "ig-1" })).resolves.toEqual(["instagram_basic"]);
  });
  it("rejects malformed granular grants instead of treating them as global", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data: { ...proof.data, granular_scopes: [{ scope: "instagram_basic", target_ids: "ig-1" }] } }));
    await expect(readUnifiedGrantedPermissions(config, token)).rejects.toThrow("OAUTH_PERMISSIONS_UNVERIFIED");
  });
  it("does not select an account whose basic grant belongs to a different resource", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data: { ...proof.data, granular_scopes: [{ scope: "instagram_basic", target_ids: ["ig-2"] }] } }));
    const client = { get: vi.fn(async (path: string) => path === "/me" ? { id: "system-user", client_business_id: "business" } : { data: [{ id: "ig-1", username: "one" }] }), forFacebookPage: vi.fn() };
    await expect(verifyOAuthAccountIdentity(config, token, {}, () => client as never)).rejects.toThrow("OAUTH_PERMISSIONS_UNVERIFIED");
  });
  it("forwards cancellation through inspection and account discovery", async () => {
    const controller = new AbortController();
    http.mockResolvedValueOnce(jsonHttpResponse(proof));
    const client = { get: vi.fn(async (path: string) => path === "/me" ? { id: "system-user", client_business_id: "business" } : { data: [{ id: "ig-1", username: "one" }] }), forFacebookPage: vi.fn() };
    await verifyOAuthAccountIdentity(config, token, {}, () => client as never, { signal: controller.signal });
    expect(http.mock.calls[0]![1]?.signal).toBe(controller.signal);
    expect(client.get).toHaveBeenCalledWith("/me", { fields: ["id", "client_business_id"] }, { signal: controller.signal });
    expect(client.get).toHaveBeenCalledWith("/me/assigned_instagram_accounts", { fields: ["id", "username"], limit: 100 }, { signal: controller.signal });
    http.mockClear();
    controller.abort();
    await expect(readUnifiedGrantedPermissions({ ...config, signal: controller.signal }, token)).rejects.toThrow("OAUTH_CANCELLED");
    expect(http).not.toHaveBeenCalled();
  });
  it("does not expose provider error text from an unsuccessful code exchange", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ error: { message: "PRIVATE-code-token-secret" } }, 400));
    await expect(exchangeCodeForLongLivedToken(options)).rejects.toThrow("UNIFIED_OAUTH_EXCHANGE_FAILED");
  });
});
