import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requestJsonHttp } from "../src/http-json.js";
import { createToolHandlers } from "../src/tools.js";
import { createOAuthCallbackService, resolveCallbackListener, oauthBrowserLaunchCommand } from "../src/callback-server.js";
import { verifyOAuthAccountIdentity, readUnifiedGrantedPermissions } from "../src/oauth-account-identity.js";
import { exchangeCodeForLongLivedToken } from "../src/oauth.js";
import { createOAuthStateStore } from "../src/oauth-state.js";
import { createRuntime } from "../src/runtime.js";
import type { MetaInstagramConfig } from "../src/config.js";
import { jsonHttpResponse } from "./helpers/json-http.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
const http = vi.mocked(requestJsonHttp);
const directories: string[] = [];
const requiredScopes = ["instagram_basic"];
function config(extra: Partial<MetaInstagramConfig> = {}): MetaInstagramConfig {
  return { authMode: "unified", configId: "24680", appId: "12345", appSecret: "sample-secret", redirectUri: "https://callback.example/oauth/callback",
    graphApiVersion: "v25.0", defaultScopes: requiredScopes, tokenStorePath: "/private/unused/token.json", publishLogPath: "/private/unused/publish.jsonl", ...extra };
}
function fixture(extra: Partial<MetaInstagramConfig> = {}, stored?: Record<string, unknown>) {
  const load = vi.fn(async () => stored as never);
  const save = vi.fn(async () => undefined);
  return { handlers: createToolHandlers({ config: config(extra), tokenStore: { load, save } }), load, save };
}
async function directory() { const value = await mkdtemp(join(tmpdir(), "portable-unified-")); directories.push(value); return value; }
beforeEach(() => { http.mockReset(); });
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });

describe("portable Unified Login pipeline", () => {
  it("builds the selected Meta configuration and refuses missing config before network", async () => {
    const { handlers } = fixture();
    const result = handlers.buildLoginUrl();
    const url = new URL(result.url);
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("config_id")).toBe("24680");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(() => fixture({ configId: undefined }).handlers.buildLoginUrl()).toThrow(/CONFIG_ID/);
    expect(http).not.toHaveBeenCalled();
  });

  it("exposes setup blockers without credentials or network access", async () => {
    const result = await fixture({ configId: undefined, redirectUri: "http://localhost:8787/callback" }).handlers.authStatus();
    expect(result.oauthSetup).toMatchObject({ ready: false, issues: ["unified_config_id_required", "unified_https_redirect_required"] });
    expect(JSON.stringify(result.oauthSetup)).not.toContain("sample-secret");
    expect(result.config.hasConfigId).toBe(false);
    expect(http).not.toHaveBeenCalled();
  });

  it("rejects legacy code-in-chat exchange for Unified even on the first install", async () => {
    const { handlers, save } = fixture();
    await expect(handlers.exchangeCode({ code: "sample-code" })).rejects.toThrow("UNIFIED_STATEFUL_OAUTH_REQUIRED");
    expect(http).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("verifies Unified SYSTEM_USER token metadata without projecting credentials", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data: { is_valid: true, app_id: "12345", type: "SYSTEM_USER", user_id: "system-user", scopes: ["instagram_basic"], expires_at: 0, data_access_expires_at: 0 } }));
    const result = await fixture({ accessToken: "sample-unified-token" }).handlers.authStatus({ verify: true });
    expect(result.authorization).toMatchObject({ reason: "verified", tokenValid: true, appMatches: true, scopes: ["instagram_basic"] });
    expect(http.mock.calls[0][0].pathname).toBe("/v25.0/debug_token");
    expect(JSON.stringify(result.authorization)).not.toMatch(/canary|12345/);
  });

  it("does not accept a user token as Unified verification", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data: { is_valid: true, app_id: "12345", type: "USER", scopes: ["instagram_basic"], expires_at: 0 } }));
    const result = await fixture({ accessToken: "sample-unified-token" }).handlers.authStatus({ verify: true });
    expect(result.authorization).toMatchObject({ reason: "malformed_response", tokenValid: "unknown" });
  });

  it("reads the selected Instagram asset instead of BISU /me", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ id: "1784001", username: "fixture_owner" }));
    await fixture({}, { authMode: "unified", accessToken: "sample-token", userId: "1784001" }).handlers.getAccountInfo();
    expect(http.mock.calls[0][0].origin).toBe("https://graph.facebook.com");
    expect(http.mock.calls[0][0].pathname).toBe("/v25.0/1784001");
  });

  it("imports a privately configured dashboard token only after app/grant/asset proof", async () => {
    http.mockImplementation(async (url) => {
      if (url.pathname.endsWith("/debug_token")) return jsonHttpResponse({ data: { is_valid: true, app_id: "12345", type: "SYSTEM_USER", user_id: "system-user", scopes: ["instagram_basic"], expires_at: 0 } });
      if (url.pathname.endsWith("/me")) return jsonHttpResponse({ id: "system-user", client_business_id: "business-1" });
      if (url.pathname.endsWith("/assigned_instagram_accounts")) return jsonHttpResponse({ data: [{ id: "1784001", username: "fixture_owner" }] });
      if (url.pathname.endsWith("/1784001")) return jsonHttpResponse({ id: "1784001", username: "fixture_owner" });
      throw new Error("Unexpected synthetic URL");
    });
    const { handlers, save } = fixture({ accessToken: "sample-local-token" });
    const result = await handlers.resolveInstagramAccount();
    expect(result).toMatchObject({ authMode: "unified", resolutionMode: "assigned_instagram_account", saved: true });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ authMode: "unified", userId: "1784001", clientBusinessId: "business-1", permissions: ["instagram_basic"] }));
    expect(http.mock.calls.map(([url]) => url.pathname)).toEqual(["/v25.0/debug_token", "/v25.0/me", "/v25.0/me/assigned_instagram_accounts", "/v25.0/1784001"]);
    expect(JSON.stringify(result)).not.toContain("sample-local-token");
  });

  it("preserves existing credentials before any inspection when a manual token would replace them", async () => {
    const { handlers, save } = fixture({ accessToken: "sample-new-token" }, { authMode: "unified", accessToken: "sample-old-token", userId: "1784001" });
    await expect(handlers.resolveInstagramAccount()).rejects.toThrow("TOKEN_STORE_NOT_EMPTY");
    expect(http).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it("does not resolve an old stored auth mode as Unified", async () => {
    const { handlers, save } = fixture({}, { authMode: "facebook", accessToken: "sample-old-token", userId: "1784001" });
    await expect(handlers.resolveInstagramAccount()).rejects.toThrow("TOKEN_STORE_AUTH_MODE_MISMATCH");
    expect(http).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it("pins app/configuration/scopes in runtime state", async () => {
    const path = await directory();
    const cfg = config({ tokenStorePath: join(path, "token.json"), publishLogPath: join(path, "publish.jsonl") });
    const runtime = createRuntime({ config: cfg, providers: [], hubStoragePath: join(path, "hub.json"), auditPath: join(path, "audit.jsonl"), readbackPath: join(path, "readback.json") });
    const server = runtime.createMcpServer(); const client = new Client({ name: "unified-fixture", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "meta_begin_oauth", arguments: {} });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(new URL(payload.authorizationUrl).searchParams.get("config_id")).toBe("24680");
      const statePath = `${cfg.tokenStorePath}.oauth-state`;
      const pending = (await readdir(statePath)).find((name) => name.endsWith(".pending"))!;
      const record = JSON.parse(await readFile(join(statePath, pending), "utf8"));
      expect(record).toMatchObject({ authMode: "unified", appId: "12345", configId: "24680", requiredScopes });
    } finally { await client.close(); await server.close(); }
  });

  it("does not issue a nonce for an invalid Unified setup", async () => {
    const path = await directory();
    const cfg = config({ configId: undefined, tokenStorePath: join(path, "token.json"), publishLogPath: join(path, "publish.jsonl") });
    const runtime = createRuntime({ config: cfg, providers: [], hubStoragePath: join(path, "hub.json"), auditPath: join(path, "audit.jsonl"), readbackPath: join(path, "readback.json") });
    const server = runtime.createMcpServer(); const client = new Client({ name: "unified-invalid", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "meta_begin_oauth", arguments: {} });
      expect(result.isError).toBe(true);
      expect((await readdir(path)).some((name) => name.endsWith(".oauth-state"))).toBe(false);
    } finally { await client.close(); await server.close(); }
  });

  it.each([true, false])("checks granted scopes against the selected asset before replacing a token (%s)", async (correctTarget) => {
    const path = await directory(); const saveToken = vi.fn(async () => undefined); const backupToken = vi.fn(async () => undefined);
    const old = { authMode: "unified" as const, accessToken: "sample-old", userId: "1784001" };
    const requirements = ["instagram_basic", "instagram_manage_insights"];
    http.mockImplementation(async (url) => {
      if (url.pathname.endsWith("/oauth/access_token")) return jsonHttpResponse({ access_token: "sample-next" });
      if (url.pathname.endsWith("/debug_token")) return jsonHttpResponse({ data: { is_valid: true, app_id: "12345", type: "SYSTEM_USER", user_id: "system-user", scopes: requirements,
        granular_scopes: [{ scope: "instagram_manage_insights", target_ids: [correctTarget ? "1784001" : "1784999"] }], expires_at: 0 } });
      if (url.pathname.endsWith("/me")) return jsonHttpResponse({ id: "system-user", client_business_id: "business-1" });
      if (url.pathname.endsWith("/assigned_instagram_accounts")) return jsonHttpResponse({ data: [{ id: "1784001", username: "fixture_owner" }] });
      throw new Error("Unexpected synthetic route");
    });
    const cfg = config();
    const service = createOAuthCallbackService({
      stateStore: createOAuthStateStore({ directory: path }),
      binding: { accountBinding: "unified:fixture", authMode: "unified", appId: "12345", configId: "24680", redirectUri: cfg.redirectUri!, requiredScopes: requirements },
      exchangeCode: (code) => exchangeCodeForLongLivedToken({ ...cfg, appId: cfg.appId!, appSecret: cfg.appSecret!, redirectUri: cfg.redirectUri!, code }),
      verifyAccount: (token, expected, verification) => verifyOAuthAccountIdentity(cfg, token, expected, undefined, verification),
      readGrantedPermissions: (token) => readUnifiedGrantedPermissions(cfg, token),
      readCurrentToken: async () => old, saveToken, backupToken,
    });
    const state = await service.issueState();
    const result = await service.handleCallback({ url: `${cfg.redirectUri}?code=sample-code&state=${state}` });
    if (correctTarget) {
      expect(result.status).toBe("success");
      expect(saveToken).toHaveBeenCalledWith(expect.objectContaining({ authMode: "unified", userId: "1784001", clientBusinessId: "business-1", permissions: requirements }));
      expect(backupToken).toHaveBeenCalledWith(old);
    } else { expect(result.status).toBe("failed"); expect(saveToken).not.toHaveBeenCalled(); expect(backupToken).not.toHaveBeenCalled(); }
    expect(http.mock.calls.filter(([url]) => url.pathname.endsWith("/debug_token"))).toHaveLength(2);
  });

  it.each([undefined, ["instagram_basic"], ["instagram_manage_insights"]])("requires live pinned grants before saving Unified (%j)", async (granted) => {
    const path = await directory(); const saveToken = vi.fn(async () => undefined);
    const service = createOAuthCallbackService({
      stateStore: createOAuthStateStore({ directory: path }),
      binding: { accountBinding: "unified:fixture", authMode: "unified", appId: "12345", configId: "24680", redirectUri: "https://callback.example/oauth/callback", requiredScopes },
      exchangeCode: async () => ({ accessToken: "sample-new", authMode: "unified", permissions: ["sample-unproven"] }),
      verifyAccount: async () => ({ userId: "1784001" }),
      ...(granted ? { readGrantedPermissions: async () => granted } : {}), saveToken,
    });
    const state = await service.issueState();
    const result = await service.handleCallback({ url: `https://callback.example/oauth/callback?code=sample-code&state=${state}` });
    if (granted?.includes("instagram_basic")) {
      expect(result.status).toBe("success");
      expect(saveToken).toHaveBeenCalledWith(expect.objectContaining({ authMode: "unified", userId: "1784001", permissions: ["instagram_basic"] }));
    } else { expect(result.status).toBe("failed"); expect(saveToken).not.toHaveBeenCalled(); }
  });
});

describe("local callback listener", () => {
  it("keeps direct legacy loopback callbacks compatible", () => {
    expect(resolveCallbackListener({ authMode: "instagram", redirectUri: "http://localhost:8787/callback" }, {})).toEqual({ host: "localhost", port: 8787 });
  });
  it("requires an explicit loopback listener behind an HTTPS callback", () => {
    expect(() => resolveCallbackListener({ authMode: "unified", redirectUri: "https://callback.example/oauth/callback" }, {})).toThrow("HTTPS_CALLBACK_LISTENER_REQUIRED");
    expect(resolveCallbackListener({ authMode: "unified", redirectUri: "https://callback.example/oauth/callback" }, { META_OAUTH_CALLBACK_LISTEN_PORT: "8787" })).toEqual({ host: "127.0.0.1", port: 8787 });
  });
  it.each(["0", "65536", "8787junk", "-1"])("rejects invalid listener port %s", (port) => {
    expect(() => resolveCallbackListener({ authMode: "unified", redirectUri: "https://callback.example/callback" }, { META_OAUTH_CALLBACK_LISTEN_PORT: port })).toThrow("OAUTH_CALLBACK_LISTEN_PORT_INVALID");
  });
});

describe("external OAuth browser launch", () => {
  it("opens the Windows default browser without a PowerShell command string", () => {
    const url = "https://www.facebook.com/dialog/oauth?client_id=12345&state=fixture-nonce";
    expect(oauthBrowserLaunchCommand(url, "win32")).toEqual({ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
  });
  it("passes the official URL as one literal argument on macOS and Linux", () => {
    const url = "https://www.instagram.com/oauth/authorize?client_id=12345&state=fixture-nonce";
    expect(oauthBrowserLaunchCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(oauthBrowserLaunchCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });
});
