import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolHandlers } from "../src/tools.js";
import { createLayeredToolHandlers } from "../src/layered-tools.js";
import { createSourceRouter } from "../src/source-router.js";
import { createMcpServer } from "../src/mcp-server.js";
import { requestJsonHttp } from "../src/http-json.js";
import type { MetaInstagramConfig } from "../src/config.js";
import { captureRuntimeStatus } from "../src/runtime-status.js";
import { ensurePrivateFile } from "../src/private-fs.js";
import { createRuntime } from "../src/runtime.js";
import { CompanionHub } from "../src/companion-hub.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
const http = vi.mocked(requestJsonHttp);
const dirs: string[] = [];
const appId = "synthetic-app";
const secret = "dummy_CANARY_APP_SECRET";
const token = "dummy_CANARY_ENV_TOKEN";
function config(extra: Partial<MetaInstagramConfig> = {}): MetaInstagramConfig {
  return { authMode: "facebook", appId, appSecret: secret, accessToken: token, graphApiVersion: "v25.0",
    tokenStorePath: "/synthetic-private/token.json", publishLogPath: "/synthetic-private/publish.jsonl", ...extra };
}
function fixture(cfg = config(), stored: Record<string, unknown> | undefined = { accessToken: "dummy_CANARY_STORED_TOKEN", expiresAt: "2030-01-01T00:00:00.000Z" }) {
  const store = { load: vi.fn(async () => stored), save: vi.fn() };
  return { handlers: createToolHandlers({ config: cfg, tokenStore: store }), store };
}
function respond(data: unknown, ok = true) {
  http.mockResolvedValue({ ok, status: ok ? 200 : 400, body: { data }, text: "dummy_CANARY_RAW_RESPONSE", attempts: [] });
}
function proof(extra: Record<string, unknown> = {}) {
  return { is_valid: true, app_id: appId, scopes: ["instagram_basic", "instagram_manage_insights"],
    expires_at: 0, data_access_expires_at: 1_893_456_000, user_id: "dummy_CANARY_USER_ID", ...extra };
}
async function privateDirectory() {
  const dir = await mkdtemp(join(tmpdir(), "status-contract-")); dirs.push(dir);
  return dir;
}
async function writeContext(dir: string, text: string) {
  const path = join(dir, "operational-context.json");
  await writeFile(path, text, { mode: 0o600 });
  await ensurePrivateFile(path);
}
afterEach(async () => { vi.useRealTimers(); vi.resetAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("safe additive auth status", () => {
  it("keeps legacy fields/types opaque and does no network for default or verify:false", async () => {
    const { handlers, store } = fixture();
    for (const args of [undefined, { verify: false }]) {
      const result = await handlers.authStatus(args);
      expect(result).toMatchObject({ config: { authMode: "facebook", hasAppId: true, hasAppSecret: true,
        tokenStorePath: "/synthetic-private/token.json" }, envToken: "[redacted]",
      storedToken: { accessToken: "[redacted]", expiresAt: "2030-01-01T00:00:00.000Z" },
      runtime: { packageVersion: expect.any(String), sourceRevision: "unknown", revisionSource: "unknown", integrity: "not_verified" },
      authorization: { verification: "not_requested", reason: "verification_not_requested", tokenValid: "unknown", appMatches: "unknown", scopes: [],
        tokenExpiry: { state: "unknown" }, dataAccessExpiry: { state: "unknown" } } });
    }
    expect(http).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });

  it("checks the selected environment credential once by bounded GET and only projects safe fields", async () => {
    respond(proof({ scopes: ["instagram_basic", "instagram_basic"], arbitrary: secret }));
    const { handlers, store } = fixture();
    const result = await handlers.authStatus({ verify: true });
    expect(result.authorization).toMatchObject({ verification: "live", source: "meta_debug_token", freshness: "fresh", reason: "verified",
      credentialSource: "environment", tokenValid: true, appMatches: true, scopes: ["instagram_basic"],
      tokenExpiry: { state: "no_expiry_reported" }, dataAccessExpiry: { state: "expires_at", expiresAt: "2030-01-01T00:00:00.000Z" } });
    expect(result.authorization.checkedAt).toEqual(expect.any(String));
    const [url, init] = http.mock.calls[0];
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v25.0/debug_token");
    expect(url.searchParams.get("input_token")).toBe(token);
    expect(url.searchParams.get("access_token")).toBe(`${appId}|${secret}`);
    expect(init).toMatchObject({ method: "GET", timeoutMs: 5000, allowRouteRetry: false, signal: expect.any(AbortSignal) });
    const safe = JSON.stringify({ runtime: result.runtime, authorization: result.authorization, operationalContext: result.operationalContext });
    for (const canary of [token, secret, appId, "dummy_CANARY_STORED_TOKEN", "dummy_CANARY_USER_ID", "dummy_CANARY_RAW_RESPONSE", "dummy_CANARY_SCOPE_SECRET", "/synthetic-private"]) expect(safe).not.toContain(canary);
    expect(http).toHaveBeenCalledTimes(1); expect(store.save).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "instagram_basic", {}, ["instagram_basic", 7], ["unknown_permission"], [token], [secret], ["a".repeat(32)]])(
    "rejects malformed, unsupported or sensitive scope proof (%j)", async (scopes) => {
      respond(proof({ scopes }));
      const { handlers } = fixture();
      const result = await handlers.authStatus({ verify: true });
      expect(result.authorization).toMatchObject({ reason: "malformed_response", tokenValid: "unknown", appMatches: "unknown", scopes: [] });
      for (const canary of [token, secret, "a".repeat(32)]) expect(JSON.stringify(result.authorization)).not.toContain(canary);
      expect((await handlers.authStatus()).authorization.verification).toBe("not_requested");
    }
  );

  it.each([{ accessToken: "instagram_basic" }, { appSecret: "email" }])("does not project dummy credential values even if they are known scope names (%j)", async (extra) => {
    respond(proof({ scopes: ["instagram_basic", "email"] }));
    expect((await fixture(config(extra)).handlers.authStatus({ verify: true })).authorization).toMatchObject({ reason: "malformed_response", scopes: [] });
  });

  it("accepts supported Facebook permission names and public identity scopes without requesting new scopes", async () => {
    respond(proof({ scopes: ["instagram_basic", "pages_show_list", "pages_read_engagement", "instagram_manage_insights", "instagram_manage_comments",
      "pages_manage_metadata", "instagram_content_publish", "instagram_manage_messages", "public_profile", "email"] }));
    expect((await fixture().handlers.authStatus({ verify: true })).authorization).toMatchObject({ reason: "verified", scopes: ["instagram_basic", "pages_show_list",
      "pages_read_engagement", "instagram_manage_insights", "instagram_manage_comments", "pages_manage_metadata", "instagram_content_publish", "instagram_manage_messages", "public_profile", "email"] });
  });

  it("reports a minimal invalid Meta response without projecting any untrusted scope strings", async () => {
    respond({ is_valid: false, scopes: [token, secret, "a".repeat(32), "instagram_basic"] });
    expect((await fixture().handlers.authStatus({ verify: true })).authorization).toMatchObject({ reason: "token_invalid", tokenValid: false, appMatches: "unknown", scopes: [] });
  });

  it.each([
    [0, undefined, { state: "no_expiry_reported" }, { state: "unknown" }],
    [1_893_456_000, 0, { state: "expires_at", expiresAt: "2030-01-01T00:00:00.000Z" }, { state: "no_expiry_reported" }],
    [null, "1893456000", { state: "unknown" }, { state: "unknown" }],
    [-1, 1.1, { state: "unknown" }, { state: "unknown" }],
    [Number.MAX_SAFE_INTEGER, {}, { state: "unknown" }, { state: "unknown" }],
  ])("projects independent expiry values (%s, %s)", async (expires_at, data_access_expires_at, tokenExpiry, dataAccessExpiry) => {
    respond(proof({ expires_at, data_access_expires_at }));
    const result = await fixture().handlers.authStatus({ verify: true });
    expect(result.authorization).toMatchObject({ tokenExpiry, dataAccessExpiry });
  });

  it.each([
    [{ is_valid: false }, "token_invalid", false, true],
    [{ is_valid: false, app_id: undefined }, "token_invalid", false, "unknown"],
    [{ app_id: "different-synthetic-app" }, "app_mismatch", true, false],
    [{ is_valid: "true" }, "malformed_response", "unknown", "unknown"],
    [{ app_id: undefined }, "malformed_response", "unknown", "unknown"],
  ])("never reports invalid or malformed proof as verified: %j", async (extra, reason, tokenValid, appMatches) => {
    respond(proof(extra));
    expect((await fixture().handlers.authStatus({ verify: true })).authorization).toMatchObject({ reason, tokenValid, appMatches });
  });

  it("keeps proof only in memory, marks cached/stale and invalidates on selected token/app/mode changes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
    respond(proof());
    const cfg = config(); const { handlers } = fixture(cfg);
    const first = await handlers.authStatus({ verify: true });
    expect((await handlers.authStatus()).authorization).toMatchObject({ verification: "cached", freshness: "cached", checkedAt: first.authorization.checkedAt });
    vi.advanceTimersByTime(300_001);
    expect((await handlers.authStatus()).authorization).toMatchObject({ verification: "cached", freshness: "stale" });
    cfg.accessToken = "dummy-different-env-token";
    expect((await handlers.authStatus()).authorization).toMatchObject({ verification: "not_requested", tokenValid: "unknown" });
    cfg.accessToken = token;
    expect((await handlers.authStatus()).authorization.verification).toBe("not_requested");
    await handlers.authStatus({ verify: true }); cfg.appId = "another-app";
    expect((await handlers.authStatus()).authorization.verification).toBe("not_requested");
    await handlers.authStatus({ verify: true }); cfg.authMode = "instagram";
    expect((await handlers.authStatus()).authorization.verification).toBe("not_requested");
    expect((await fixture(cfg).handlers.authStatus()).authorization.verification).toBe("not_requested");
  });

  it("does not transfer stored-token proof to a new environment override or changed stored credential", async () => {
    respond(proof());
    const cfg = config({ accessToken: undefined }); const { handlers, store } = fixture(cfg, { accessToken: "dummy-stored-first", authMode: "facebook" });
    expect((await handlers.authStatus({ verify: true })).authorization.credentialSource).toBe("stored");
    cfg.accessToken = token;
    expect((await handlers.authStatus()).authorization.verification).toBe("not_requested");
    cfg.accessToken = undefined; await handlers.authStatus({ verify: true });
    store.load.mockResolvedValue({ accessToken: "dummy-stored-second", authMode: "facebook" });
    expect((await handlers.authStatus()).authorization.verification).toBe("not_requested");
  });

  it.each([
    [{ accessToken: undefined }, {}, "no_token"],
    [{ authMode: "instagram" as const }, undefined, "unsupported_auth_mode"],
    [{ appSecret: undefined }, undefined, "missing_app_credentials"],
  ])("fails closed without network when verification cannot run (%j)", async (extra, stored, reason) => {
    expect((await fixture(config(extra), stored).handlers.authStatus({ verify: true })).authorization).toMatchObject({ verification: "unavailable", reason, tokenValid: "unknown" });
    expect(http).not.toHaveBeenCalled();
  });

  it("normalizes transport/upstream/store failures without returning their secret-bearing messages", async () => {
    http.mockRejectedValue(new Error(`${secret} ${token}`));
    const { handlers, store } = fixture();
    const failed = await handlers.authStatus({ verify: true });
    expect(failed.authorization).toMatchObject({ verification: "unavailable", reason: "verification_failed" });
    expect(JSON.stringify(failed.authorization)).not.toContain(secret);
    respond(proof(), false);
    expect((await handlers.authStatus({ verify: true })).authorization.reason).toBe("verification_failed");
    store.load.mockRejectedValue(new Error(secret));
    const cfg = config({ accessToken: undefined });
    const unavailable = createToolHandlers({ config: cfg, tokenStore: store });
    expect((await unavailable.authStatus({ verify: true })).authorization.reason).toBe("token_store_unavailable");
  });

  it("verifies an environment override even if the unrelated stored credential is unreadable", async () => {
    respond(proof()); const { handlers, store } = fixture();
    store.load.mockRejectedValue(new Error(secret));
    expect((await handlers.authStatus({ verify: true })).authorization).toMatchObject({ verification: "live", credentialSource: "environment", tokenValid: true });
  });

  it("treats an absent debug data object as malformed without accepting previous metadata", async () => {
    respond(null);
    expect((await fixture().handlers.authStatus({ verify: true })).authorization).toMatchObject({ reason: "malformed_response", tokenValid: "unknown", tokenExpiry: { state: "unknown" } });
  });

  it("aborts at five seconds wall-clock even when the transport never settles", async () => {
    vi.useFakeTimers();
    http.mockImplementation(() => new Promise(() => {}));
    const pending = fixture().handlers.authStatus({ verify: true });
    await vi.advanceTimersByTimeAsync(4999);
    const signal = http.mock.calls[0][1]!.signal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).authorization).toMatchObject({ reason: "verification_timeout", verification: "unavailable" });
    expect(signal.aborted).toBe(true); expect(http).toHaveBeenCalledTimes(1);
  });

  it("does not let an older same-credential response replace the outcome of a newer failed check", async () => {
    let finish!: (value: Awaited<ReturnType<typeof requestJsonHttp>>) => void;
    http.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { handlers } = fixture();
    const first = handlers.authStatus({ verify: true });
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1));
    http.mockRejectedValueOnce(new Error(secret));
    expect((await handlers.authStatus({ verify: true })).authorization.reason).toBe("verification_failed");
    finish({ ok: true, status: 200, body: { data: proof() }, text: "", attempts: [] });
    await first;
    expect((await handlers.authStatus()).authorization).toMatchObject({ verification: "not_requested", tokenValid: "unknown" });
  });

  it("accepts verify through the actual MCP schema while preserving the legacy tool catalogue", async () => {
    respond(proof()); const { handlers } = fixture();
    const server = createMcpServer(handlers); const client = new Client({ name: "status-contract", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      expect((await client.listTools()).tools).toHaveLength(18);
      const call = await client.callTool({ name: "meta_auth_status", arguments: { verify: true } });
      const content = call.content as Array<{ text: string }>;
      expect(JSON.parse(content[0].text).authorization).toMatchObject({ verification: "live", tokenValid: true });
    } finally { await client.close(); await server.close(); }
  });
});

describe("operational context whitelist and source snapshot", () => {
  it.each([
    ["https://example.com/legal/privacy", "https://example.com/legal/data-deletion"],
    ["https://example.com/legal/privacy/", "https://example.com/legal/data-deletion/"],
    ["https://example.com/product-privacy/", "https://example.com/product-data-deletion/"],
  ])("accepts only terminal legal slugs while preserving legal/product prefixes (%s)", async (privacyPolicyUrl, dataDeletionUrl) => {
    const dir = await privateDirectory();
    await writeContext(dir, JSON.stringify({ privacyPolicyUrl, dataDeletionUrl }));
    expect((await fixture(config({ tokenStorePath: join(dir, "token.json") })).handlers.authStatus()).operationalContext)
      .toMatchObject({ status: "configured", privacyPolicyUrl, dataDeletionUrl });
  });
  it("accepts public product-prefixed privacy/deletion pages", async () => {
    const dir = await privateDirectory();
    await writeContext(dir, JSON.stringify({ privacyPolicyUrl: "https://example.com/product-privacy",
      dataDeletionUrl: "https://example.com/product-data-deletion", deletionWorkflow: "manual" }));
    expect((await fixture(config({ tokenStorePath: join(dir, "token.json") })).handlers.authStatus()).operationalContext).toMatchObject({
      status: "configured", privacyPolicyUrl: "https://example.com/product-privacy", dataDeletionUrl: "https://example.com/product-data-deletion" });
  });
  it("reads only public legal URLs/manual workflow from a private adjacent file", async () => {
    const dir = await privateDirectory();
    await writeContext(dir, JSON.stringify({ privacyPolicyUrl: "https://example.com/privacy", dataDeletionUrl: "https://example.com/data-deletion",
      deletionWorkflow: "manual", contactEmail: "dummy_CANARY_EMAIL@example.com", appId: "dummy_CANARY_APP_ID", arbitrary: secret }));
    const result = await fixture(config({ tokenStorePath: join(dir, "token.json") })).handlers.authStatus();
    expect(result.operationalContext).toEqual({ status: "configured", verification: "configuration_only", privacyPolicyUrl: "https://example.com/privacy",
      dataDeletionUrl: "https://example.com/data-deletion", deletionWorkflow: "manual" });
  });

  it.each(["http://example.com/privacy", "https://user:pass@example.com/privacy", "https://example.com/privacy?token=secret", "https://example.com/privacy#secret",
    "https://example.com/privacy?", "https://example.com/privacy#", "https://@example.com/privacy",
    "https://localhost./privacy", "https://local.internal./privacy", "https://127.0.0.1./privacy", "https://example.com./privacy",
    "https://example.com/privacy/customer_123456", "https://example.com/data-deletion/customer_123456", "https://example.com/product-privacy/customer_123456",
    "https://127.0.0.1/privacy", "https://[::1]/privacy", "https://192.168.1.2/privacy", "https://local.internal/privacy", "https://localhost/privacy",
    "https://business.facebook.com/privacy", "https://example.com/accounts/privacy", "https://example.com/dashboard/privacy", "https://example.com/contact/person@example.com",
    "https://example.com/ordinary-profile", "https://example.com/privacy%2Fsecret"]) ("rejects private/account/contact URL %s", async (url) => {
    const dir = await privateDirectory();
    await writeContext(dir, JSON.stringify({ privacyPolicyUrl: url, dataDeletionUrl: url, deletionWorkflow: "automatic", raw: secret }));
    expect((await fixture(config({ tokenStorePath: join(dir, "token.json") })).handlers.authStatus()).operationalContext)
      .toEqual({ status: "unknown", verification: "configuration_only", deletionWorkflow: "unknown" });
  });

  it("keeps missing or malformed external context unknown", async () => {
    const dir = await privateDirectory(); const handlers = fixture(config({ tokenStorePath: join(dir, "token.json") })).handlers;
    expect((await handlers.authStatus()).operationalContext.status).toBe("unknown");
    await writeContext(dir, "not-json");
    expect((await handlers.authStatus()).operationalContext.status).toBe("unknown");
  });

  it("adds runtime identity without changing capabilities schema version or opening any source UI", async () => {
    const read = vi.fn(); const tools = createLayeredToolHandlers({ router: createSourceRouter({ providers: [
      { source: "browser", status: async () => ({ source: "browser", availability: "not_connected", capabilities: [] }), read }
    ] }) });
    const result = await tools.capabilities();
    expect(result).toMatchObject({ version: 1, verification: "runtime_status_only", runtime: { packageVersion: expect.any(String), integrity: "not_verified" },
      sources: expect.arrayContaining([{ source: "browser", availability: "not_connected", capabilities: [] }]), operations: expect.any(Array) });
    expect(read).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled();
  });
});

describe("runtime marker provenance", () => {
  const revision = "a".repeat(40);
  async function root() {
    const dir = await privateDirectory();
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.2.8" }));
    return dir;
  }
  it("captures validated installer metadata once without exposing paths or arbitrary marker keys", async () => {
    const dir = await root();
    await writeFile(join(dir, ".meta-instagram-mcp-install.json"), JSON.stringify({ version: "0.2.8", revision, installedAt: "2026-11-05T00:00:00.000Z", private: secret }));
    const captured = captureRuntimeStatus(dir);
    expect(captured).toMatchObject({ packageVersion: "0.2.8", sourceRevision: revision, revisionSource: "installer_stamp", integrity: "not_verified" });
    await writeFile(join(dir, ".meta-instagram-mcp-install.json"), "not-json");
    expect(captured.sourceRevision).toBe(revision);
    expect(captureRuntimeStatus(dir).sourceRevision).toBe("unknown");
    expect(JSON.stringify(captured)).not.toContain(dir); expect(JSON.stringify(captured)).not.toContain(secret);
  });
  it.each([
    { version: "0.2.7", revision, installedAt: "2026-11-05T00:00:00.000Z" },
    { version: "0.2.8", revision: "bad-revision", installedAt: "2026-11-05T00:00:00.000Z" },
    { version: "0.2.8", revision, installedAt: "2026-11-05" },
    { version: "0.2.8", revision, installedAt: null },
    { version: "0.2.8", revision, installedAt: "2026-02-30T00:00:00.0000000Z" },
  ])("fails unknown on invalid or incompatible installer stamps %j", async (stamp) => {
    const dir = await root();
    await writeFile(join(dir, ".meta-instagram-mcp-install.json"), JSON.stringify(stamp));
    await writeFile(join(dir, ".VERSION"), revision);
    expect(captureRuntimeStatus(dir)).toMatchObject({ packageVersion: "0.2.8", sourceRevision: "unknown", revisionSource: "unknown" });
  });
  it("accepts the native PowerShell installer's seven-digit timestamp", async () => {
    const dir = await root();
    await writeFile(join(dir, ".meta-instagram-mcp-install.json"), JSON.stringify({ version: "0.2.8", revision, installedAt: "2026-11-05T00:00:00.1234567Z" }));
    expect(captureRuntimeStatus(dir)).toMatchObject({ sourceRevision: revision, revisionSource: "installer_stamp" });
  });
  it("accepts the server full revision marker and rejects malformed/conflicting provenance", async () => {
    const dir = await root();
    await writeFile(join(dir, ".VERSION"), `${revision.toUpperCase()}\n`);
    expect(captureRuntimeStatus(dir)).toMatchObject({ packageVersion: "0.2.8", sourceRevision: revision, revisionSource: "server_version" });
    await writeFile(join(dir, ".VERSION"), "v0.2.8");
    expect(captureRuntimeStatus(dir).sourceRevision).toBe("unknown");
    await writeFile(join(dir, ".VERSION"), "b".repeat(40));
    await writeFile(join(dir, ".meta-instagram-mcp-install.json"), JSON.stringify({ version: "0.2.8", revision, installedAt: "2026-11-05T00:00:00.000Z" }));
    expect(captureRuntimeStatus(dir).sourceRevision).toBe("unknown");
  });

  it("shares one startup snapshot between auth and capability tools in the composed runtime", async () => {
    const dir = await privateDirectory();
    const runtime = createRuntime({ config: config({ tokenStorePath: join(dir, "token.json") }), providers: [],
      hub: new CompanionHub({ storagePath: join(dir, "hub.json") }) });
    const server = runtime.createMcpServer(); const client = new Client({ name: "shared-status", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      const data = async (name: string) => {
        const result = await client.callTool({ name, arguments: {} });
        return JSON.parse((result.content as Array<{ text: string }>)[0].text);
      };
      const auth = await data("meta_auth_status"); const capabilities = await data("meta_capabilities");
      expect(auth.runtime).toEqual(capabilities.runtime);
      expect(capabilities.version).toBe(1);
      expect(http).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });
});
