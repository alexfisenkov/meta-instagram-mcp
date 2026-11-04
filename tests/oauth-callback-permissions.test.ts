import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestJsonHttp } from "../src/http-json.js";
import { createOAuthStateStore } from "../src/oauth-state.js";
import { createOAuthCallbackService } from "../src/callback-server.js";
import * as identity from "../src/oauth-account-identity.js";
import type { OAuthToken } from "../src/oauth.js";
import type { StoredInstagramToken } from "../src/token-store.js";
import { createRuntime } from "../src/runtime.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { jsonHttpResponse, metaErrorResponse } from "./helpers/json-http.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
const httpMock = vi.mocked(requestJsonHttp);
const requiredScopes = ["instagram_basic", "pages_show_list", "pages_read_engagement", "instagram_manage_insights", "instagram_manage_comments"];
const rows = requiredScopes.map((permission) => ({ permission, status: "granted" }));
const directories: string[] = [];
beforeEach(() => httpMock.mockReset());
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture(scopes: string[] | null = requiredScopes, realIdentity = false, readGrants = true, exchangePermissions: string[] | null = ["canary_unproven_response_scope"]) {
  const directory = await mkdtemp(join(tmpdir(), "oauth-permissions-")); directories.push(directory);
  const store = createOAuthStateStore({ directory });
  const old: StoredInstagramToken = { accessToken: "canary-old-token", authMode: "facebook", userId: "178400001", pageId: "123456789", permissions: [...requiredScopes, "canary_old_unproven_scope"] };
  let current: StoredInstagramToken = old;
  let backups = 0;
  const failures: unknown[] = [];
  const binding = { accountBinding: "fixture", authMode: "facebook" as const, redirectUri: "https://mcp.example/oauth/callback",
    expectedAccountId: old.userId, expectedPageId: old.pageId, ...(scopes ? { requiredScopes: scopes } : {}) };
  const service = createOAuthCallbackService({
    stateStore: store, binding, onFailure: (failure) => { failures.push(failure); },
    readCurrentToken: async () => current,
    exchangeCode: async () => ({ accessToken: "example-canary-new-token", authMode: "facebook", ...(exchangePermissions ? { permissions: exchangePermissions } : {}) }),
    verifyAccount: realIdentity
      ? (token, expected, verification) => identity.verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" }, token, expected, undefined, verification)
      : async () => ({ userId: old.userId!, pageId: old.pageId! }),
    ...(readGrants ? { readGrantedPermissions: (token: OAuthToken) => identity.readFacebookGrantedPermissions("v25.0", token) } : {}),
    backupToken: async () => { backups += 1; },
    saveToken: async (token) => { current = { ...token }; },
  });
  const state = await service.issueState();
  return { run: () => service.handleCallback({ url: `${binding.redirectUri}?code=fixture-code&state=${state}` }), current: () => current, old, backups: () => backups, failures };
}

describe("state-bound Facebook callback permission proof", () => {
  it("pins the configured authorization URL scopes in state rather than treating the request list as granted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oauth-runtime-scope-pin-")); directories.push(directory);
    const configuredScopes = [...requiredScopes];
    const tokenPath = join(directory, "token.json");
    const runtime = createRuntime({
      config: { authMode: "facebook", appId: "fixture-app", appSecret: "fixture-secret", redirectUri: "https://mcp.example/callback",
        graphApiVersion: "v25.0", defaultScopes: configuredScopes, tokenStorePath: tokenPath, publishLogPath: join(directory, "publish.jsonl") },
      providers: [], hubStoragePath: join(directory, "hub.json"), auditPath: join(directory, "audit.jsonl"), readbackPath: join(directory, "readback.json"),
    });
    configuredScopes.push("canary_later_config_mutation");
    const server = runtime.createMcpServer();
    const client = new Client({ name: "scope-pin-fixture", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "meta_begin_oauth", arguments: {} });
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as { authorizationUrl: string };
      expect(new URL(payload.authorizationUrl).searchParams.get("scope")?.split(",")).toEqual(requiredScopes);
      const stateDirectory = `${tokenPath}.oauth-state`;
      const file = (await readdir(stateDirectory)).find((entry) => entry.endsWith(".pending"))!;
      const stored = JSON.parse(await readFile(join(stateDirectory, file), "utf8"));
      expect(stored.requiredScopes).toEqual(requiredScopes);
      expect(stored.permissions).toBeUndefined();
    } finally { await client.close(); await server.close(); }
  });
  it.each(requiredScopes)("retains the old token when the new token lacks required grant %s", async (missing) => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: rows.filter((row) => row.permission !== missing) }));
    const subject = await fixture();
    await expect(subject.run()).resolves.toMatchObject({ status: "failed" });
    expect(subject.current()).toBe(subject.old);
    expect(subject.backups()).toBe(0);
    expect(subject.failures).toEqual([{ event: "oauth_callback_failed", phase: "identity", reason: "permissions_unverified" }]);
    expect(JSON.stringify(subject.failures)).not.toContain("canary");
  });

  it.each([
    ["declined", { data: rows.map((row, index) => index === 0 ? { ...row, status: "declined" } : row) }],
    ["malformed", { data: null }],
    ["unknown status", { data: [{ permission: "instagram_basic", status: "unknown" }] }],
    ["duplicate status", { data: [...rows, { permission: "instagram_basic", status: "declined" }] }],
    ["incomplete pagination", { data: rows, paging: { next: "canary-private-next" } }],
    ["malformed pagination", { data: rows, paging: "canary-private-paging" }],
    ["empty", { data: [] }],
  ])("rejects %s permission evidence before any backup/save", async (_label, body) => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse(body));
    const subject = await fixture();
    await expect(subject.run()).resolves.toMatchObject({ status: "failed" });
    expect(subject.current()).toBe(subject.old);
    expect(subject.backups()).toBe(0);
  });

  it.each(["api", "transport"])("rejects a permission %s error without falling back to old labels", async (failure) => {
    if (failure === "api") httpMock.mockResolvedValueOnce(metaErrorResponse("denied example-canary-new-token"));
    else httpMock.mockRejectedValueOnce(new Error("offline example-canary-new-token"));
    const subject = await fixture();
    await expect(subject.run()).resolves.toMatchObject({ status: "failed" });
    expect(subject.current()).toBe(subject.old);
    expect(subject.backups()).toBe(0);
  });

  it("requires the trusted grant read hook, even if the exchanged token carries permission labels", async () => {
    const subject = await fixture(requiredScopes, false, false);
    await expect(subject.run()).resolves.toMatchObject({ status: "failed" });
    expect(subject.current()).toBe(subject.old);
    expect(subject.backups()).toBe(0);
  });

  it("rejects Facebook callback state without pinned requirements before backup/save", async () => {
    const subject = await fixture(null);
    await expect(subject.run()).resolves.toMatchObject({ status: "failed" });
    expect(subject.current()).toBe(subject.old);
    expect(subject.backups()).toBe(0);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("reads actual grants even when the exchange response has no permissions field", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: rows }));
    const subject = await fixture(requiredScopes, false, true, null);
    await expect(subject.run()).resolves.toMatchObject({ status: "success" });
    expect(subject.current().permissions).toEqual(requiredScopes);
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("checks the NEW user token and persists actual grants rather than old or exchange-response labels", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: rows }));
    const subject = await fixture();
    await expect(subject.run()).resolves.toMatchObject({ status: "success" });
    expect(subject.current()).toMatchObject({ accessToken: "example-canary-new-token", permissions: requiredScopes });
    expect(subject.backups()).toBe(1);
    expect(httpMock).toHaveBeenCalledTimes(1);
    expect(httpMock.mock.calls[0][0].pathname).toBe("/v25.0/me/permissions");
    expect(httpMock.mock.calls[0][0].searchParams.get("access_token")).toBe("example-canary-new-token");
  });

  it("permits known-Page fallback only through the consumed callback state and verifies grants before commit", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] }))
      .mockResolvedValueOnce(jsonHttpResponse({ id: "123456789", access_token: "example-canary-page-token", instagram_business_account: { id: "178400001" } }))
      .mockResolvedValueOnce(jsonHttpResponse({ id: "123456789" }))
      .mockResolvedValueOnce(jsonHttpResponse({ id: "178400001", username: "fixture" }))
      .mockResolvedValueOnce(jsonHttpResponse({ data: rows }));
    const subject = await fixture(requiredScopes, true);
    await expect(subject.run()).resolves.toMatchObject({ status: "success" });
    expect(subject.current()).toMatchObject({ userId: "178400001", pageId: "123456789", permissions: requiredScopes });
    expect(httpMock).toHaveBeenCalledTimes(5);
    expect(httpMock.mock.calls[4][0].searchParams.get("access_token")).toBe("example-canary-new-token");
  });
});
