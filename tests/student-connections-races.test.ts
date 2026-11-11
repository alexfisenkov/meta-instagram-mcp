import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StudentVault } from "../src/student/vault.js";
import { ConnectionsStore } from "../src/student/connections-store.js";
import { ConnectionsRuntime } from "../src/student/connections-runtime.js";
import { ConnectionsProviders } from "../src/student/connections-providers.js";
import { ConnectionsHttp } from "../src/student/connections-http.js";
import { connectionFingerprint, baseConnectionScopes } from "../src/student/connections-config.js";
import type { ConnectionConfig } from "../src/student/connections-types.js";
const subject = { tenantId: "masterskaya", sub: "fictitious-race" }, cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(options: { expired?: boolean; single?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "connections-race-")), vault = await StudentVault.open(directory, Buffer.alloc(32, 22)), store = new ConnectionsStore(vault);
  const config: ConnectionConfig = { product: "google_business_profile", clientId: "synthetic-client", clientSecret: "synthetic-private", callbackUrl: "https://broker.example.test/social/accounts/oauth/google_business_profile/callback", admission: "live", testSubjects: [], scopes: [...baseConnectionScopes.google_business_profile], billingApproved: false };
  const grantId = randomUUID(), a = randomUUID(), b = randomUUID(), entered = deferred(), release = deferred();
  const state = { resources: options.single ? ["20"] : ["20", "21"], discoveryError: 0, gateUsed: false, refreshes: 0 };
  const requests: { path: string; authorization: string | undefined }[] = [];
  const providers = new ConnectionsProviders(new ConnectionsHttp(async (input, init) => {
    const u = new URL(String(input)), authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    requests.push({ path: u.pathname, authorization });
    if (u.hostname === "oauth2.googleapis.com") { state.refreshes++; return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "bearer", expires_in: 3600, scope: config.scopes.join(" ") }); }
    if (u.hostname === "openidconnect.googleapis.com") return Response.json({ sub: "verified-google-actor" });
    if (u.pathname === "/v1/accounts") return Response.json({ accounts: [{ name: "accounts/10" }] });
    if (u.pathname === "/v1/accounts/10/locations") {
      if (!state.gateUsed) { state.gateUsed = true; entered.resolve(); await release.promise; }
      if (state.discoveryError) return Response.json({ error: "synthetic-refusal" }, { status: state.discoveryError });
      return Response.json({ locations: state.resources.map(id => ({ name: `locations/${id}`, title: `Fictitious ${id}` })) });
    }
    if (/^\/v1\/locations\/(20|21)$/.test(u.pathname)) return Response.json({ name: u.pathname.slice(4), title: "Fictitious location" });
    throw new Error("unexpected synthetic endpoint");
  }));
  const runtime = new ConnectionsRuntime(store, [config], providers, "https://platform.example.test");
  cleanups.push(async () => { release.resolve(); await runtime.stop(); await vault.close(); await rm(directory, { recursive: true, force: true }); });
  await store.transaction(d => {
    d.grants.push({ ...subject, id: grantId, product: config.product, actorId: "verified-google-actor", accessToken: "initial-access", refreshToken: "initial-refresh", scopes: config.scopes, expiresAt: options.expired ? 0 : Date.now() + 3600000, fingerprint: connectionFingerprint(config), status: "active", validatedAt: 1 });
    for (const [id, native] of [[a, "20"], ...(options.single ? [] : [[b, "21"]])]) d.resources.push({ ...subject, id, grantId, product: config.product, providerId: `locations/${native}`, parentId: "accounts/10", kind: "location", label: "Fictitious", capabilities: ["account", "posts", "metrics"], status: "connected" });
  });
  const settle = (promise: Promise<unknown>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error instanceof Error ? error.message : "unknown" }));
  return { store, runtime, config, grantId, a, b, entered: entered.promise, release: release.resolve, state, requests, settle };
}
it("does not invalidate the shared grant or sibling when the requested location disconnects during read discovery", async () => {
  const x = await fixture(), flight = x.settle(x.runtime.read(subject, { connectionId: x.a, operation: "account" }));
  await x.entered; await x.runtime.disconnect(subject, x.a); x.release();
  expect(await flight).toEqual({ ok: false, error: "reauth_required" });
  const data = await x.store.snapshot(); expect(data.grants[0].status).toBe("active");
  expect(data.resources.find(r => r.id === x.a)?.status).toBe("disconnected"); expect(data.resources.find(r => r.id === x.b)?.status).toBe("connected");
  expect((await x.runtime.read(subject, { connectionId: x.b, operation: "account" })).account).toMatchObject({ id: "locations/21" });
});
it("keeps a verified refresh rotation for the connected sibling when its requested location disconnects in flight", async () => {
  const x = await fixture(), flight = x.settle(x.runtime.refresh(subject, x.a));
  await x.entered; await x.runtime.disconnect(subject, x.a); x.release();
  expect(await flight).toEqual({ ok: false, error: "reauth_required" });
  const data = await x.store.snapshot(); expect(data.grants[0]).toMatchObject({ status: "active", accessToken: "rotated-access", refreshToken: "rotated-refresh" });
  expect(data.resources.find(r => r.id === x.a)).toMatchObject({ status: "disconnected", capabilities: [] });
  expect((await x.runtime.read(subject, { connectionId: x.b, operation: "account" })).account).toMatchObject({ id: "locations/21" });
  expect(x.state.refreshes).toBe(1); expect(x.requests.at(-1)?.authorization).toBe("Bearer rotated-access");
});
it("persists verified same-actor rotation before reporting loss of the requested location while a sibling is still owned", async () => {
  const x = await fixture({ expired: true }), flight = x.settle(x.runtime.read(subject, { connectionId: x.a, operation: "account" }));
  await x.entered; x.state.resources = ["21"]; x.release();
  expect(await flight).toEqual({ ok: false, error: "resource_access_lost" });
  const data = await x.store.snapshot(); expect(data.grants[0]).toMatchObject({ status: "active", accessToken: "rotated-access", refreshToken: "rotated-refresh" });
  expect(data.resources.find(r => r.id === x.a)).toMatchObject({ status: "reauth_required", reason: "resource_access_lost" });
  expect(data.resources.find(r => r.id === x.b)?.status).toBe("connected");
  expect((await x.runtime.read(subject, { connectionId: x.b, operation: "account" })).account).toMatchObject({ id: "locations/21" });
  expect(x.state.refreshes).toBe(1); expect(x.requests.at(-1)?.authorization).toBe("Bearer rotated-access");
});
it("does not restore credentials after the last resource disconnects during a verified refresh", async () => {
  const x = await fixture({ single: true }), flight = x.settle(x.runtime.refresh(subject, x.a));
  await x.entered; await x.runtime.disconnect(subject, x.a); x.release();
  expect(await flight).toEqual({ ok: false, error: "reauth_required" });
  const data = await x.store.snapshot(); expect(data.grants[0]).toMatchObject({ status: "disconnected", accessToken: "", refreshToken: undefined }); expect(data.resources[0]).toMatchObject({ status: "disconnected", capabilities: [] });
});
it("does not overwrite a newer same-actor token grant committed while refresh discovery is in flight", async () => {
  const x = await fixture(), flight = x.settle(x.runtime.refresh(subject, x.a));
  await x.entered;
  await x.store.transaction(d => { d.grants[0].accessToken = "newer-access"; d.grants[0].refreshToken = "newer-refresh"; d.grants[0].validatedAt = 999; });
  const before = await x.store.snapshot(); x.release();
  expect(await flight).toEqual({ ok: false, error: "reauth_required" }); expect(await x.store.snapshot()).toEqual(before);
});
it("rejects a configuration change during read discovery without overwriting the newer grant metadata", async () => {
  const x = await fixture(), flight = x.settle(x.runtime.read(subject, { connectionId: x.a, operation: "account" }));
  await x.entered; x.config.clientSecret = "synthetic-reconfigured-private";
  await x.store.transaction(d => { d.grants[0].fingerprint = connectionFingerprint(x.config); d.grants[0].validatedAt = 999; });
  const before = await x.store.snapshot(); x.release();
  expect(await flight).toEqual({ ok: false, error: "reauth_required" }); expect(await x.store.snapshot()).toEqual(before);
});
it("does not invalidate a newer configured grant when the prior in-flight provider request reports an auth failure", async () => {
  const x = await fixture(), flight = x.settle(x.runtime.read(subject, { connectionId: x.a, operation: "account" }));
  await x.entered; x.config.clientSecret = "synthetic-reconfigured-private";
  await x.store.transaction(d => { d.grants[0].fingerprint = connectionFingerprint(x.config); d.grants[0].validatedAt = 999; });
  const before = await x.store.snapshot(); x.state.discoveryError = 401; x.release();
  expect(await flight).toEqual({ ok: false, error: "reauth_required" }); expect(await x.store.snapshot()).toEqual(before);
});
it("clears unusable refreshed credentials when provider discovery confirms no owned connected resource survives", async () => {
  const x = await fixture({ expired: true }), flight = x.settle(x.runtime.read(subject, { connectionId: x.a, operation: "account" }));
  await x.entered; x.state.resources = []; x.release();
  expect(await flight).toEqual({ ok: false, error: "resource_access_lost" });
  const data = await x.store.snapshot();
  expect(data.grants[0]).toMatchObject({ status: "reauth_required", accessToken: "", refreshToken: undefined });
  expect(data.resources.every(r => r.status === "reauth_required" && r.reason === "resource_access_lost" && r.capabilities.length === 0)).toBe(true);
});
