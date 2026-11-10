import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { StudentBroker } from "../src/student/broker.js";
import { StudentRegistry } from "../src/student/registry.js";
import { StudentVault } from "../src/student/vault.js";
import { GrantLifecycle } from "../src/student/grant-lifecycle.js";
import { BrokerError, type ProductConfig, type Subject } from "../src/student/types.js";
import type { ProviderAdapter } from "../src/student/provider.js";
const a: Subject = { tenantId: "masterskaya", sub: "student-a" }, b: Subject = { tenantId: "masterskaya", sub: "student-b" };
const configs: ProductConfig[] = [{ product: "instagram", key: "instagram-v1", provider: "instagram_unified", appId: "123", appSecret: "secret", configId: "456", apiVersion: "v25.0", callbackUrl: "https://broker.example/student/oauth/callback", admission: "test", testSubjects: ["student-a"] }];
const youtubeConfig: ProductConfig = { product: "youtube", key: "youtube-v1", provider: "youtube", appId: "123-client.apps.googleusercontent.com", appSecret: "google-client-secret-fixture", apiVersion: "v3", callbackUrl: "https://broker.example/youtube/oauth/callback", admission: "live", testSubjects: [] };
const resources: Array<{ dir: string; vault: StudentVault }> = [];
afterEach(async () => { for (const r of resources.splice(0)) { await r.vault.close(); await rm(r.dir, { recursive: true, force: true }); } });
async function fixture(adapter?: ProviderAdapter) {
  const dir = await mkdtemp(join(tmpdir(), "student-broker-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  let clock = 1_800_000_000_000;
  const provider: ProviderAdapter = adapter ?? { exchange: async () => ({ accessToken: "example-provider-token", assetTokens: {}, providerUserId: "bisu-1", clientBusinessId: "business-1", scopes: ["instagram_basic"], assets: [{ product: "instagram", providerId: "ig-1", label: "one", capabilities: ["account", "posts"] }, { product: "instagram", providerId: "ig-2", label: "two", capabilities: ["account"] }] }), read: async () => ({ data: { id: "ig-1" }, coverage: "partial", limitations: [] }) };
  return { vault, provider, broker: new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", () => clock), advance: () => { clock += 600_001; } };
}
async function connect(broker: StudentBroker) { const login = await broker.begin(a, "instagram"); const state = new URL(login.authorizationUrl).searchParams.get("state")!; expect(await broker.callback({ state, code: "code-a" })).toBe("https://platform.example/social?meta=connected"); return state; }
it("keeps Google PKCE state one-use and binds the YouTube channel to the initiating subject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-broker-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  let verifier = "";
  const provider: ProviderAdapter = { exchange: async (_config, _code, codeVerifier) => { verifier = codeVerifier ?? ""; return { accessToken: "google-access-fixture", refreshToken: "google-refresh-fixture", assetTokens: {}, providerUserId: "google-subject-fixture", scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], expiresAt: Math.floor(Date.now() / 1000) + 3600, assets: [{ product: "youtube", providerId: "UC-owned-fixture", label: "Owned channel", capabilities: ["account"] }] }; }, read: async () => ({ data: {}, coverage: "partial", limitations: [] }) };
  const broker = new StudentBroker(vault, new StudentRegistry([youtubeConfig]), provider, "https://platform.example");
  const login = await broker.begin(a, "youtube"), url = new URL(login.authorizationUrl), state = url.searchParams.get("state")!;
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("scope")).toBe("openid profile https://www.googleapis.com/auth/youtube.readonly");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(await broker.callback({ state, code: "authorization-code-fixture", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).toBe("https://platform.example/social?youtube=connected");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
  await expect(broker.callback({ state, code: "authorization-code-fixture", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).resolves.toBe("https://platform.example/social?youtube=error");
  const channels = (await broker.youtubeList(a)).connections;
  expect(channels).toMatchObject([{ product: "youtube", account: { id: "UC-owned-fixture", label: "Owned channel" }, status: "connected" }]);
  expect((await broker.list(b)).connections).toEqual([]);
  await expect(broker.read(a, { connectionId: channels[0].id, operation: "account" })).rejects.toThrow("connection_not_found");
  await expect(broker.disconnect(a, channels[0].id)).rejects.toThrow("connection_not_found");
  await expect(broker.read(a, { connectionId: channels[0].id, operation: "account" }, ["youtube"])).resolves.toMatchObject({ source: "google_youtube_data_api" });
});
it("does not consume YouTube state on a wrong callback route or issuer and uses a fixed YouTube error for unknown state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-callback-binding-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  let exchanges = 0;
  const provider: ProviderAdapter = { exchange: async () => { exchanges++; return { accessToken: "google-access-fixture", refreshToken: "google-refresh-fixture", assetTokens: {}, providerUserId: "google-subject-fixture", scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], assets: [{ product: "youtube", providerId: "UC-owned-fixture", label: "Owned channel", capabilities: ["account"] }] }; }, read: async () => ({ data: {}, coverage: "partial", limitations: [] }) };
  const broker = new StudentBroker(vault, new StudentRegistry([youtubeConfig]), provider, "https://platform.example");
  const start = await broker.begin(a, "youtube"), state = new URL(start.authorizationUrl).searchParams.get("state")!;
  expect(await broker.callback({ state, code: "code", issuer: "https://accounts.google.com", callbackPath: "/student/oauth/callback" })).toBe("https://platform.example/social?youtube=error");
  expect(await broker.callback({ state, code: "code", issuer: "https://accounts.google.com.evil.example", callbackPath: "/youtube/oauth/callback" })).toBe("https://platform.example/social?youtube=error");
  expect(exchanges).toBe(0);
  expect(await broker.callback({ state, code: "code", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).toBe("https://platform.example/social?youtube=connected");
  expect(exchanges).toBe(1);
  expect(await broker.callback({ state: randomBytes(32).toString("base64url"), code: "ignored", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).toBe("https://platform.example/social?youtube=error");
});
it("keeps persisted YouTube grants outside the legacy Meta vault so a Meta-only rollback still reads and sweeps safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-vault-rollback-")); const key = randomBytes(32); const metaVault = await StudentVault.open(dir, key); const youtubeVault = await StudentVault.open(join(dir, "youtube"), key);
  resources.push({ dir, vault: { close: async () => { await youtubeVault.close(); await metaVault.close(); } } as StudentVault });
  const registry = new StudentRegistry([...configs, youtubeConfig]);
  const provider: ProviderAdapter = { exchange: async () => ({ accessToken: "youtube-access-fixture", refreshToken: "youtube-refresh-fixture", assetTokens: {}, providerUserId: "google-subject-fixture", scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], expiresAt: 1_900_000_000, assets: [{ product: "youtube", providerId: "UC-rollback-fixture", label: "Rollback channel", capabilities: ["account"] }] }), read: async () => ({ data: {}, coverage: "partial", limitations: [] }), refresh: async () => { throw new Error("unexpected refresh"); } };
  const legacyMetaBroker = new StudentBroker(metaVault, registry, provider, "https://platform.example");
  const youtubeBroker = new StudentBroker(youtubeVault, registry, provider, "https://platform.example");
  const start = await youtubeBroker.begin(a, "youtube"), state = new URL(start.authorizationUrl).searchParams.get("state")!;
  await youtubeBroker.callback({ state, code: "code", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" });
  expect((await youtubeVault.snapshot()).connections).toHaveLength(1);
  expect((await legacyMetaBroker.list(a)).connections).toEqual([]);
  await new GrantLifecycle(metaVault, registry, provider, () => 1_800_000_000_000).tick();
  expect((await metaVault.snapshot()).grants).toEqual([]);
  expect((await youtubeVault.snapshot()).connections[0].status).toBe("connected");
  expect((await youtubeVault.snapshot()).grants).toHaveLength(1);
});
it("keeps channels from a second Google identity when the same LMS owner connects another account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-multi-account-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  const registry = new StudentRegistry([youtubeConfig]);
  const provider: ProviderAdapter = { exchange: async (_config, code) => { const suffix = code === "account-one" ? "one" : "two"; return { accessToken: `google-access-${suffix}`, refreshToken: `google-refresh-${suffix}`, assetTokens: {}, providerUserId: `google-subject-${suffix}`, scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], expiresAt: Math.floor(Date.now() / 1000) + 3600, assets: [{ product: "youtube", providerId: `UC-${suffix}`, label: `Channel ${suffix}`, capabilities: ["account"] }] }; }, read: async () => ({ data: {}, coverage: "partial", limitations: [] }) };
  const broker = new StudentBroker(vault, registry, provider, "https://platform.example");
  for (const code of ["account-one", "account-two"]) {
    const start = await broker.begin(a, "youtube"), state = new URL(start.authorizationUrl).searchParams.get("state")!;
    expect(await broker.callback({ state, code, issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).toContain("youtube=connected");
  }
  const connections = (await broker.youtubeList(a)).connections;
  expect(connections.map((item) => item.account.id).sort()).toEqual(["UC-one", "UC-two"]);
  expect(connections.every((item) => item.status === "connected")).toBe(true);
});
it("returns a fixed YouTube no-channel notice without creating a grant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-empty-discovery-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  const provider: ProviderAdapter = { exchange: async () => { throw new BrokerError("no_authorized_assets"); }, read: async () => ({ data: {}, coverage: "partial", limitations: [] }) };
  const broker = new StudentBroker(vault, new StudentRegistry([youtubeConfig]), provider, "https://platform.example");
  const start = await broker.begin(a, "youtube"), state = new URL(start.authorizationUrl).searchParams.get("state")!;
  expect(await broker.callback({ state, code: "no-channel", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).toBe("https://platform.example/social?youtube=no_channel");
  expect((await broker.youtubeList(a)).connections).toEqual([]);
  expect((await vault.snapshot()).grants).toEqual([]);
});
it("preserves the existing YouTube credential if Google returns no refresh token on re-consent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-refresh-preserve-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  let next = false;
  const provider: ProviderAdapter = { exchange: async () => { if (next) throw new BrokerError("youtube_refresh_token_missing"); return { accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture", assetTokens: {}, providerUserId: "google-subject-fixture", scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], expiresAt: Math.floor(Date.now() / 1000) + 3600, assets: [{ product: "youtube", providerId: "UC-owned-fixture", label: "Owned channel", capabilities: ["account"] }] }; }, read: async () => ({ data: {}, coverage: "partial", limitations: [] }) };
  const broker = new StudentBroker(vault, new StudentRegistry([youtubeConfig]), provider, "https://platform.example");
  const first = await broker.begin(a, "youtube"), firstState = new URL(first.authorizationUrl).searchParams.get("state")!;
  await broker.callback({ state: firstState, code: "first", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" });
  const before = (await broker.youtubeList(a)).connections[0]; next = true;
  const second = await broker.begin(a, "youtube"), secondState = new URL(second.authorizationUrl).searchParams.get("state")!;
  expect(await broker.callback({ state: secondState, code: "missing-refresh", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).toBe("https://platform.example/social?youtube=refresh_required");
  const after = (await broker.youtubeList(a)).connections[0], grant = (await vault.snapshot()).grants[0];
  expect(after.id).toBe(before.id);
  expect(after.status).toBe("connected");
  expect(vault.credential(grant)).toMatchObject({ accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture" });
});
it("preserves a YouTube Brand channel across one-to-two-to-one consent, blocks replay and disconnects only the selected channel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-channel-switch-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  const registry = new StudentRegistry([youtubeConfig]);
  const provider: ProviderAdapter = { exchange: async (_config, code) => { const channel = code === "channel-two" ? "UC-two" : "UC-one"; return { accessToken: `google-access-${channel}`, refreshToken: `google-refresh-${channel}`, assetTokens: {}, providerUserId: "google-subject-same", scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], expiresAt: Math.floor(Date.now() / 1000) + 3600, assets: [{ product: "youtube", providerId: channel, label: channel, capabilities: ["account"] }] }; }, read: async () => ({ data: {}, coverage: "partial", limitations: [] }) };
  const broker = new StudentBroker(vault, registry, provider, "https://platform.example");
  const connect = async (code: string) => { const start = await broker.begin(a, "youtube"), state = new URL(start.authorizationUrl).searchParams.get("state")!; await broker.callback({ state, code, issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" }); return state; };
  const firstState = await connect("channel-one");
  const first = (await broker.youtubeList(a)).connections.find((item) => item.account.id === "UC-one")!;
  await connect("channel-two");
  expect((await broker.youtubeList(a)).connections.filter((item) => item.status === "connected").map((item) => item.account.id).sort()).toEqual(["UC-one", "UC-two"]);
  await connect("channel-one-again");
  const current = (await broker.youtubeList(a)).connections;
  expect(current.filter((item) => item.status === "connected").map((item) => item.account.id).sort()).toEqual(["UC-one", "UC-two"]);
  expect(current.find((item) => item.account.id === "UC-one")?.id).toBe(first.id);
  await expect(broker.callback({ state: firstState, code: "channel-one", issuer: "https://accounts.google.com", callbackPath: "/youtube/oauth/callback" })).resolves.toBe("https://platform.example/social?youtube=error");
  const second = current.find((item) => item.account.id === "UC-two")!;
  await broker.disconnect(a, second.id, ["youtube"]);
  const afterDisconnect = (await broker.youtubeList(a)).connections;
  expect(afterDisconnect.find((item) => item.account.id === "UC-one")?.status).toBe("connected");
  expect(afterDisconnect.find((item) => item.account.id === "UC-two")?.status).toBe("disconnected");
});
it("catalog fails closed per product and limits test admission to pinned subjects", async () => {
  const { broker } = await fixture();
  expect(broker.catalog(a).products.find((p) => p.product === "instagram")?.status).toBe("ready");
  expect(broker.catalog(b).products.find((p) => p.product === "instagram")?.status).toBe("review_required");
  expect(broker.catalog(a).products.find((p) => p.product === "threads")?.status).toBe("not_configured");
  await expect(broker.begin(b, "instagram")).rejects.toThrow("review_required");
});
it("audits only recognized callback flows with stable fields", async () => {
  const { vault, provider } = await fixture(); const events: unknown[] = [];
  const broker = new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", Date.now, (event) => events.push(event));
  const success = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(success.authorizationUrl).searchParams.get("state")!, code: "secret-code" })).toContain("meta=connected");
  const cancelled = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(cancelled.authorizationUrl).searchParams.get("state")!, error: "access_denied" })).toContain("meta=cancelled");
  const failed = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(failed.authorizationUrl).searchParams.get("state")!, code: "secret-code", error: "secret-error" })).toContain("meta=error");
  expect(await broker.callback({ state: "unmatched-random-state" })).toContain("meta=error");
  expect(events).toEqual([
    { event: "student_oauth_callback", stage: "grant_persist", product: "instagram", outcome: "connected", reason: "connected", hasCode: true, hasProviderError: false },
    { event: "student_oauth_callback", stage: "callback_validation", product: "instagram", outcome: "cancelled", reason: "provider_cancelled", hasCode: false, hasProviderError: true },
    { event: "student_oauth_callback", stage: "callback_validation", product: "instagram", outcome: "error", reason: "callback_rejected", hasCode: true, hasProviderError: true },
  ]);
  expect(JSON.stringify(events)).not.toMatch(/secret-code|secret-error|unmatched-random-state|student-a|masterskaya/);
});
it("carries only numeric provider diagnostics into callback audit", async () => {
  const marker = "PRIVATE-url-code-state-token-body-message"; const { vault } = await fixture(); const events: unknown[] = [];
  let diagnostic: any = Object.assign({ stage: "asset_discovery", status: 403, metaCode: 10, metaSubcode: 123 }, { rawBody: marker, url: marker, code: marker, state: marker, token: marker, message: marker });
  let brokerCode = "provider_unavailable";
  const provider: ProviderAdapter = { exchange: async () => { throw new BrokerError(brokerCode, diagnostic as any); }, read: async () => { throw new Error(marker); } };
  const broker = new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", Date.now, (event) => events.push(event));
  const login = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(login.authorizationUrl).searchParams.get("state")!, code: marker })).toContain("meta=error");
  brokerCode = marker;
  const second = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(second.authorizationUrl).searchParams.get("state")!, code: marker })).toContain("meta=error");
  diagnostic = { stage: marker, status: 5000, metaCode: "190", metaSubcode: -1, token: marker };
  const third = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(third.authorizationUrl).searchParams.get("state")!, code: marker })).toContain("meta=error");
  expect(events).toEqual([
    { event: "student_oauth_callback", stage: "asset_discovery", product: "instagram", outcome: "error", reason: "provider_unavailable", hasCode: true, hasProviderError: false, status: 403, metaCode: 10, metaSubcode: 123 },
    { event: "student_oauth_callback", stage: "asset_discovery", product: "instagram", outcome: "error", reason: "callback_failed", hasCode: true, hasProviderError: false, status: 403, metaCode: 10, metaSubcode: 123 },
    { event: "student_oauth_callback", stage: "token_exchange", product: "instagram", outcome: "error", reason: "callback_failed", hasCode: true, hasProviderError: false },
  ]);
  expect(JSON.stringify(events)).not.toContain(marker);
});
it.each(["threads_app_binding_missing", "threads_app_token_invalid", "threads_inspection_response_invalid", "threads_inspection_not_valid", "threads_inspection_type_invalid", "threads_inspection_app_mismatch", "threads_inspection_scopes_invalid", "threads_inspection_identity_invalid", "threads_inspection_expiry_invalid", "threads_inspection_expired", "threads_account_identity_invalid", "threads_identity_mismatch", "threads_expected_identity_missing", "instagram_short_identity_missing", "instagram_short_identity_invalid", "instagram_profile_response_invalid", "instagram_profile_identity_missing", "instagram_profile_identity_invalid", "instagram_short_response_invalid", "instagram_permissions_invalid", "instagram_permissions_unexpected", "instagram_long_response_invalid", "instagram_token_type_invalid", "instagram_token_expiry_invalid"] as const)("audits fixed provider verification checkpoints without provider payloads: %s", async (reason) => {
  const { vault } = await fixture(); const events: unknown[] = []; let exchanges = 0;
  const provider: ProviderAdapter = { exchange: async () => { exchanges++; throw new BrokerError(reason); }, read: async () => { throw new Error("unused"); } };
  const broker = new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", Date.now, (event) => events.push(event));
  const login = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(login.authorizationUrl).searchParams.get("state")!, code: "PRIVATE-code" })).toContain("meta=error");
  expect(exchanges).toBe(1);
  expect(events).toEqual([{ event: "student_oauth_callback", stage: "token_exchange", product: "instagram", outcome: "error", reason, hasCode: true, hasProviderError: false }]);
  const db = await vault.snapshot(); expect(db.states).toEqual([]); expect(db.grants).toEqual([]);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE-code|student-a|authorizationUrl|access_token|credential/);
});
it.each(["token_short_exchange", "token_long_exchange", "app_token_exchange", "token_refresh"] as const)("preserves the fixed %s audit checkpoint and only numeric Meta diagnostics", async (stage) => {
  const { vault } = await fixture(); const events: unknown[] = [];
  const provider: ProviderAdapter = { exchange: async () => { throw new BrokerError("provider_unavailable", { stage, status: 400, metaCode: 452, metaSubcode: 4279019 }); }, read: async () => { throw new Error("unused"); } };
  const broker = new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", Date.now, (event) => events.push(event));
  const login = await broker.begin(a, "instagram");
  await broker.callback({ state: new URL(login.authorizationUrl).searchParams.get("state")!, code: "PRIVATE-code" });
  expect(events).toEqual([{ event: "student_oauth_callback", stage, product: "instagram", outcome: "error", reason: "provider_unavailable", hasCode: true, hasProviderError: false, status: 400, metaCode: 452, metaSubcode: 4279019 }]);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE|https:|student-a|access_token/);
});
it("keeps callback redirect safe when broker error accessors throw", async () => {
  const marker = "PRIVATE-throwing-error-getter-marker"; const { vault } = await fixture(); const events: unknown[] = [];
  const hostile = new Proxy(new BrokerError("provider_unavailable"), { get(target, key, receiver) { if (key === "code" || key === "diagnostic") throw new Error(marker); return Reflect.get(target, key, receiver); } });
  const provider: ProviderAdapter = { exchange: async () => { throw hostile; }, read: async () => { throw new Error(marker); } };
  const broker = new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", Date.now, (event) => events.push(event));
  const login = await broker.begin(a, "instagram");
  expect(await broker.callback({ state: new URL(login.authorizationUrl).searchParams.get("state")!, code: "private-code" })).toBe("https://platform.example/social?meta=error");
  expect(events).toEqual([{ event: "student_oauth_callback", stage: "token_exchange", product: "instagram", outcome: "error", reason: "callback_failed", hasCode: true, hasProviderError: false }]);
  expect(JSON.stringify(events)).not.toContain(marker);
});
it("drops malformed numeric diagnostics without affecting the callback", async () => {
  const { vault } = await fixture(); const events: unknown[] = [];
  const diagnostics = [
    { stage: "asset_discovery", status: Number.NaN, metaCode: Number.POSITIVE_INFINITY, metaSubcode: 2_147_483_648 },
    { stage: "account_identity", status: "403", metaCode: "10", metaSubcode: -1 },
  ];
  let next = 0;
  const provider: ProviderAdapter = { exchange: async () => { throw new BrokerError("provider_unavailable", diagnostics[next++] as any); }, read: async () => { throw new Error(); } };
  const broker = new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", Date.now, (event) => events.push(event));
  for (let i = 0; i < diagnostics.length; i++) {
    const login = await broker.begin(a, "instagram");
    expect(await broker.callback({ state: new URL(login.authorizationUrl).searchParams.get("state")!, code: "private-code" })).toContain("meta=error");
  }
  expect(events).toEqual([
    { event: "student_oauth_callback", stage: "asset_discovery", product: "instagram", outcome: "error", reason: "provider_unavailable", hasCode: true, hasProviderError: false },
    { event: "student_oauth_callback", stage: "account_identity", product: "instagram", outcome: "error", reason: "provider_unavailable", hasCode: true, hasProviderError: false },
  ]);
});
it("does not log unrecognized runtime products from consumed states", async () => {
  const { vault, broker } = await fixture(); const events: unknown[] = [];
  const audited = new StudentBroker(vault, new StudentRegistry(configs), { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); } }, "https://platform.example", Date.now, (event) => events.push(event));
  const login = await audited.begin(a, "instagram"); const state = new URL(login.authorizationUrl).searchParams.get("state")!;
  await vault.transaction((db) => { db.states[0].product = "private-product-marker" as any; });
  expect(await audited.callback({ state, code: "private-code" })).toContain("meta=error");
  expect(events).toEqual([]);
  expect(JSON.stringify(events)).not.toContain("private-product-marker");
});
it("one-time state binds subject/config and returns only safe connections", async () => {
  const { broker, vault } = await fixture(); const state = await connect(broker);
  const listed = await broker.list(a); expect(listed.connections).toHaveLength(2);
  expect(JSON.stringify(listed)).not.toMatch(/example-provider-token|business-1|bisu-1|credential/);
  expect((await broker.list(b)).connections).toEqual([]);
  expect(await broker.callback({ state, code: "replay" })).toBe("https://platform.example/social?meta=error");
  expect((await vault.snapshot()).grants).toHaveLength(1);
  await expect(broker.read(b, { connectionId: listed.connections[0].id, operation: "account" })).rejects.toThrow("connection_not_found");
});
it("consumes denial and expiry and prevents provider exchange", async () => {
  let calls = 0; const { broker, advance } = await fixture({ exchange: async () => { calls++; throw new Error(); }, read: async () => { throw new Error(); } });
  const begin = await broker.begin(a, "instagram"); const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
  expect(await broker.callback({ state, error: "access_denied" })).toBe("https://platform.example/social?meta=cancelled");
  expect(await broker.callback({ state, code: "retry" })).toBe("https://platform.example/social?meta=error");
  const expired = await broker.begin(a, "instagram"); advance();
  expect(await broker.callback({ state: new URL(expired.authorizationUrl).searchParams.get("state")!, code: "old" })).toBe("https://platform.example/social?meta=error");
  expect(calls).toBe(0);
});
it("disconnect isolates assets sharing a grant and blocks reads immediately", async () => {
  const { broker, vault } = await fixture(); await connect(broker); const ids = (await broker.list(a)).connections.map((c) => c.id);
  await expect(broker.disconnect(b, ids[0])).rejects.toThrow("connection_not_found");
  expect((await broker.disconnect(a, ids[0])).connection.status).toBe("disconnected");
  await expect(broker.read(a, { connectionId: ids[0], operation: "account" })).rejects.toThrow("connection_unavailable");
  expect((await vault.snapshot()).grants[0].status).toBe("active");
  await expect(broker.read(a, { connectionId: ids[1], operation: "posts" })).rejects.toThrow("operation_unavailable");
  await broker.disconnect(a, ids[1]); expect((await vault.snapshot()).grants[0].status).toBe("revoked");
});
it("rejects a callback if provider config changed during authorization", async () => {
  const { broker, vault } = await fixture(); const begin = await broker.begin(a, "instagram");
  const changed = new StudentBroker(vault, new StudentRegistry([{ ...configs[0], appId: "789" }]), { exchange: async () => { throw new Error("should not call"); }, read: async () => { throw new Error(); } }, "https://platform.example");
  expect(await changed.callback({ state: new URL(begin.authorizationUrl).searchParams.get("state")!, code: "code" })).toBe("https://platform.example/social?meta=error");
  expect((await vault.snapshot()).grants).toEqual([]);
});
it("disconnect cancels pending and in-flight OAuth so an old code cannot reconnect an asset", async () => {
  const { broker, vault } = await fixture(); await connect(broker); const connectionId = (await broker.list(a)).connections[0].id;
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
  const inflight = new StudentBroker(vault, new StudentRegistry(configs), { exchange: async () => { started(); await wait; return { accessToken: "new", assetTokens: {}, providerUserId: "user", scopes: ["instagram_basic"], assets: [{ product: "instagram", providerId: "ig-1", label: "one", capabilities: ["account"] }] }; }, read: async () => { throw new Error(); } }, "https://platform.example");
  const login = await inflight.begin(a, "instagram"); const callback = inflight.callback({ state: new URL(login.authorizationUrl).searchParams.get("state")!, code: "code" }); await entered;
  await inflight.disconnect(a, connectionId); release(); expect(await callback).toBe("https://platform.example/social?meta=error");
  expect((await broker.list(a)).connections.find((c) => c.id === connectionId)?.status).toBe("disconnected");
});
it("a provider-revoked token becomes reauth_required for every asset sharing its grant", async () => {
  const { broker, vault } = await fixture(); await connect(broker);
  const reader = new StudentBroker(vault, new StudentRegistry(configs), { exchange: async () => { throw new Error(); }, read: async () => { throw new BrokerError("reauth_required"); } }, "https://platform.example");
  await expect(reader.read(a, { connectionId: (await broker.list(a)).connections[0].id, operation: "account" })).rejects.toThrow("reauth_required");
  expect((await reader.list(a)).connections.map((c) => c.status)).toEqual(["reauth_required", "reauth_required"]);
  const grant = (await vault.snapshot()).grants[0]; expect(vault.credential(grant).accessToken).toBe("");
});
it.each([10, 200])("denies only the selected operation for Meta %s, keeps shared assets/profile reads and emits a safe read audit", async (metaCode) => {
  const { broker, vault } = await fixture(); await connect(broker);
  const before = (await broker.list(a)).connections, events: unknown[] = []; let calls = 0;
  const reader = new StudentBroker(vault, new StudentRegistry(configs), { exchange: async () => { throw new Error(); }, read: async (_config, selected, _credential, input) => {
    calls++;
    if (input.operation === "posts") throw new BrokerError("permission_unavailable", { stage: "api_request", status: 403, metaCode, metaSubcode: 123, rawBody: "PRIVATE-payload-token" } as any);
    return { data: { id: selected.providerId }, coverage: "partial", limitations: [] };
  } }, "https://platform.example", Date.now, undefined, (event) => events.push(event));
  await expect(reader.read(a, { connectionId: before[0].id, operation: "posts" })).rejects.toThrow("permission_unavailable");
  const after = (await reader.list(a)).connections;
  expect(after[0]).toMatchObject({ status: "connected", capabilities: ["account"], reason: "operation_permission_unavailable" });
  expect(after[1]).toEqual(before[1]);
  expect(vault.credential((await vault.snapshot()).grants[0]).accessToken).toBe("example-provider-token");
  await expect(reader.read(a, { connectionId: before[0].id, operation: "account" })).resolves.toMatchObject({ data: { id: "ig-1" } });
  await expect(reader.read(a, { connectionId: before[1].id, operation: "account" })).resolves.toMatchObject({ data: { id: "ig-2" } });
  const priorCalls = calls;
  await expect(reader.read(b, { connectionId: before[0].id, operation: "account" })).rejects.toThrow("connection_not_found");
  expect(calls).toBe(priorCalls);
  expect(events).toEqual([{ event: "student_connection_read_error", product: "instagram", operation: "posts", reason: "permission_unavailable", status: 403, metaCode, metaSubcode: 123 }]);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE|ig-1|ig-2|student-a|example-provider-token|https:/);
});
it("fails closed for a denied identity read without invalidating another asset in the grant", async () => {
  const { broker, vault } = await fixture(); await connect(broker); const before = (await broker.list(a)).connections;
  const reader = new StudentBroker(vault, new StudentRegistry(configs), { exchange: async () => { throw new Error(); }, read: async () => { throw new BrokerError("permission_unavailable"); } }, "https://platform.example");
  await expect(reader.read(a, { connectionId: before[0].id, operation: "account" })).rejects.toThrow("permission_unavailable");
  const after = (await reader.list(a)).connections;
  expect(after[0]).toMatchObject({ status: "reauth_required", capabilities: [], reason: "identity_verification_unavailable" });
  expect(after[1]).toEqual(before[1]);
  expect((await vault.snapshot()).grants[0].status).toBe("active");
});
it("does not let a late permission denial remove a capability from a replacement grant", async () => {
  const { broker, vault, provider } = await fixture(); await connect(broker); const first = (await broker.list(a)).connections[0];
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
  const reader = new StudentBroker(vault, new StudentRegistry(configs), { ...provider, read: async () => { entered(); await wait; throw new BrokerError("permission_unavailable"); } }, "https://platform.example");
  const pending = reader.read(a, { connectionId: first.id, operation: "posts" });
  const rejected = expect(pending).rejects.toThrow("permission_unavailable");
  await started; await connect(broker); release(); await rejected;
  expect((await broker.list(a)).connections[0]).toMatchObject({ status: "connected", capabilities: ["account", "posts"] });
});
it("logs only a fixed read failure for unknown provider errors and ignores a failing audit sink", async () => {
  const { broker, vault } = await fixture(); await connect(broker); const before = await broker.list(a), events: unknown[] = [];
  const reader = new StudentBroker(vault, new StudentRegistry(configs), { exchange: async () => { throw new Error(); }, read: async () => { throw new Error("PRIVATE-provider-url-token-content"); } }, "https://platform.example", Date.now, undefined, (event) => { events.push(event); throw new Error("PRIVATE-sink"); });
  await expect(reader.read(a, { connectionId: before.connections[0].id, operation: "posts" })).rejects.toThrow("PRIVATE-provider-url-token-content");
  expect(await reader.list(a)).toEqual(before);
  expect(events).toEqual([{ event: "student_connection_read_error", product: "instagram", operation: "posts", reason: "read_failed" }]);
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
});
it("narrowed reconsent retires missing own assets and events but preserves other subjects/products", async () => {
  const { broker, vault, provider } = await fixture(); await connect(broker); const before = (await broker.list(a)).connections;
  await vault.transaction((db) => {
    db.connections.push({ ...db.connections[0], id: "other-subject", sub: "student-b", grantId: "other-grant" }, { ...db.connections[0], id: "other-product", product: "facebook" });
    db.events.push({ connectionId: before[1].id, eventId: "retire", receivedAt: new Date().toISOString(), data: { text: "private-retired" } }, { connectionId: "other-subject", eventId: "keep", receivedAt: new Date().toISOString(), data: { text: "private-other" } });
  });
  const narrow = new StudentBroker(vault, new StudentRegistry(configs), { ...provider, exchange: async (c, code) => { const grant = await provider.exchange(c, code); return { ...grant, assets: grant.assets.slice(0, 1) }; } }, "https://platform.example"); await connect(narrow);
  const db = await vault.snapshot(); expect(db.connections.find((c) => c.id === before[1].id)?.status).toBe("disconnected"); expect(db.events.map((e) => e.eventId)).toEqual(["keep"]);
  expect(db.connections.find((c) => c.id === "other-subject")?.status).toBe("connected"); expect(db.connections.find((c) => c.id === "other-product")?.status).toBe("connected");
  expect(db.grants[0].status).toBe("active"); // Still serves the other product, so its shared grant survives.
  await expect(narrow.read(a, { connectionId: before[1].id, operation: "account" })).rejects.toThrow("connection_unavailable");
});
it("narrowed reconsent erases an old grant when it has no remaining active assets", async () => {
  const { broker, vault, provider } = await fixture(); await connect(broker);
  const narrow = new StudentBroker(vault, new StudentRegistry(configs), { ...provider, exchange: async (c, code) => { const grant = await provider.exchange(c, code); return { ...grant, assets: grant.assets.slice(0, 1) }; } }, "https://platform.example"); await connect(narrow);
  const old = (await vault.snapshot()).grants[0]; expect(old.status).toBe("revoked"); expect(vault.credential(old).accessToken).toBe("");
  expect(old.providerUserId).toBe(""); expect(old.scopes).toEqual([]); expect(old.clientBusinessId).toBeUndefined();
});
it("a superseded in-flight OAuth callback cannot reintroduce assets after newer consent", async () => {
  const { vault, provider } = await fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }), waiting = new Promise<void>((resolve) => { release = resolve; });
  const competing = new StudentBroker(vault, new StudentRegistry(configs), { ...provider, exchange: async (c, code) => { const result = await provider.exchange(c, code); if (code === "old") { entered(); await waiting; return result; } return { ...result, assets: result.assets.slice(0, 1) }; } }, "https://platform.example");
  const old = await competing.begin(a, "instagram"), pending = competing.callback({ state: new URL(old.authorizationUrl).searchParams.get("state")!, code: "old" }); await started;
  const fresh = await competing.begin(a, "instagram"); expect(await competing.callback({ state: new URL(fresh.authorizationUrl).searchParams.get("state")!, code: "new" })).toContain("meta=connected"); release(); expect(await pending).toContain("meta=error");
  expect((await competing.list(a)).connections.filter((c) => c.status === "connected").map((c) => c.account.id)).toEqual(["ig-1"]);
});
it.each([{ admission: "live" as const, testSubjects: [] }, { testSubjects: ["student-a", "student-b"] }, { webhookVerifyToken: "example-verify-key" }])("operational config changes preserve grants and policy still controls pending OAuth %j", async (change) => {
  const { broker, vault, provider } = await fixture(); await connect(broker); const pending = await broker.begin(a, "instagram");
  const changed = new StudentBroker(vault, new StudentRegistry([{ ...configs[0], ...change }]), provider, "https://platform.example");
  expect((await changed.list(a)).connections.map((c) => c.status)).toEqual(["connected", "connected"]);
  expect(await changed.callback({ state: new URL(pending.authorizationUrl).searchParams.get("state")!, code: "code" })).toContain("meta=connected");
});
it("an operational admission removal still rejects a previously valid pending state", async () => {
  const { broker, vault, provider } = await fixture(); const pending = await broker.begin(a, "instagram");
  const changed = new StudentBroker(vault, new StudentRegistry([{ ...configs[0], testSubjects: [] }]), provider, "https://platform.example");
  expect(await changed.callback({ state: new URL(pending.authorizationUrl).searchParams.get("state")!, code: "code" })).toContain("meta=error"); expect((await vault.snapshot()).grants).toHaveLength(0);
});
