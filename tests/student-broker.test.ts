import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { StudentBroker } from "../src/student/broker.js";
import { StudentRegistry } from "../src/student/registry.js";
import { StudentVault } from "../src/student/vault.js";
import { BrokerError, type ProductConfig, type Subject } from "../src/student/types.js";
import type { ProviderAdapter } from "../src/student/provider.js";
const a: Subject = { tenantId: "masterskaya", sub: "student-a" }, b: Subject = { tenantId: "masterskaya", sub: "student-b" };
const configs: ProductConfig[] = [{ product: "instagram", key: "instagram-v1", provider: "instagram_unified", appId: "123", appSecret: "secret", configId: "456", apiVersion: "v25.0", callbackUrl: "https://broker.example/student/oauth/callback", admission: "test", testSubjects: ["student-a"] }];
const resources: Array<{ dir: string; vault: StudentVault }> = [];
afterEach(async () => { for (const r of resources.splice(0)) { await r.vault.close(); await rm(r.dir, { recursive: true, force: true }); } });
async function fixture(adapter?: ProviderAdapter) {
  const dir = await mkdtemp(join(tmpdir(), "student-broker-")); const vault = await StudentVault.open(dir, randomBytes(32)); resources.push({ dir, vault });
  let clock = 1_800_000_000_000;
  const provider: ProviderAdapter = adapter ?? { exchange: async () => ({ accessToken: "example-provider-token", assetTokens: {}, providerUserId: "bisu-1", clientBusinessId: "business-1", scopes: ["instagram_basic"], assets: [{ product: "instagram", providerId: "ig-1", label: "one", capabilities: ["account", "posts"] }, { product: "instagram", providerId: "ig-2", label: "two", capabilities: ["account"] }] }), read: async () => ({ data: { id: "ig-1" }, coverage: "partial", limitations: [] }) };
  return { vault, provider, broker: new StudentBroker(vault, new StudentRegistry(configs), provider, "https://platform.example", () => clock), advance: () => { clock += 600_001; } };
}
async function connect(broker: StudentBroker) { const login = await broker.begin(a, "instagram"); const state = new URL(login.authorizationUrl).searchParams.get("state")!; expect(await broker.callback({ state, code: "code-a" })).toBe("https://platform.example/social?meta=connected"); return state; }
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
