import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GrantLifecycle } from "../src/student/grant-lifecycle.js";
import { StudentRegistry, configFingerprint } from "../src/student/registry.js";
import { StudentVault } from "../src/student/vault.js";
import type { ProductConfig } from "../src/student/types.js";
const config: ProductConfig = { product: "threads", key: "threads", provider: "threads", appId: "123", appSecret: "secret", apiVersion: "v1.0", callbackUrl: "https://broker.example/student/oauth/callback", admission: "live", testSubjects: [] };
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); for (const f of clean.splice(0).reverse()) await f(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "student-life-")); clean.push(() => rm(dir, { recursive: true, force: true })); const vault = await StudentVault.open(dir, randomBytes(32)); clean.push(() => vault.close());
  const now = 1_800_000_000_000; const binding = { tenantId: "masterskaya", sub: "a", id: "grant", provider: "threads" as const };
  await vault.transaction((db) => { db.grants.push({ ...binding, providerUserId: "user", configKey: "threads", fingerprint: configFingerprint(config), scopes: ["threads_basic"], expiresAt: now / 1000 + 86_400, status: "active", createdAt: new Date(now - 2 * 86_400_000).toISOString(), credential: vault.seal(binding, { accessToken: "old", assetTokens: {} }) }); db.connections.push({ id: "connection", tenantId: "masterskaya", sub: "a", grantId: "grant", product: "threads", providerId: "user", label: "user", capabilities: ["account"], status: "connected", updatedAt: "now" }); });
  return { vault, now, registry: new StudentRegistry([config]) };
}
it("refreshes an eligible Threads grant and persists the new encrypted credential/expiry", async () => {
  const { vault, registry, now } = await setup();
  const lifecycle = new GrantLifecycle(vault, registry, { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); }, refresh: async (_c, credential) => { expect(credential.accessToken).toBe("old"); return { accessToken: "rotated", assetTokens: {}, expiresAt: now / 1000 + 5_184_000 }; } }, () => now);
  await lifecycle.tick(); const grant = (await vault.snapshot()).grants[0]; expect(vault.credential(grant).accessToken).toBe("rotated"); expect(grant.expiresAt).toBe(now / 1000 + 5_184_000); expect(grant.refreshedAt).toBe(now);
});
it("a refresh finishing after disconnect cannot resurrect credentials", async () => {
  const { vault, registry, now } = await setup(); let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; }), waiting = new Promise<void>((resolve) => { release = resolve; });
  const lifecycle = new GrantLifecycle(vault, registry, { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); }, refresh: async () => { started(); await waiting; return { accessToken: "rotated", assetTokens: {}, expiresAt: now / 1000 + 5_184_000 }; } }, () => now);
  const running = lifecycle.tick(); await entered;
  await vault.transaction((db) => { db.grants[0].status = "revoked"; db.connections[0].status = "disconnected"; db.grants[0].credential = vault.seal(db.grants[0], { accessToken: "", assetTokens: {} }); }); release(); await running;
  const grant = (await vault.snapshot()).grants[0]; expect(grant.status).toBe("revoked"); expect(vault.credential(grant).accessToken).toBe("");
});
it("expires unsupported grants to reauth_required and erases credentials", async () => {
  const { vault, registry, now } = await setup(); await vault.transaction((db) => { db.grants[0].expiresAt = now / 1000 - 1; });
  await new GrantLifecycle(vault, registry, { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); } }, () => now).tick();
  const db = await vault.snapshot(); expect(db.grants[0].status).toBe("reauth_required"); expect(db.connections[0].status).toBe("reauth_required"); expect(vault.credential(db.grants[0]).accessToken).toBe("");
});
it("starts a controlled timer and stops it without another refresh", async () => {
  const { vault, registry, now } = await setup(); vi.useFakeTimers(); let calls = 0;
  const lifecycle = new GrantLifecycle(vault, registry, { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); }, refresh: async () => { calls++; return { accessToken: "new", assetTokens: {}, expiresAt: now / 1000 + 5_184_000 }; } }, () => now);
  lifecycle.start(1000); await vi.advanceTimersByTimeAsync(1000); await lifecycle.stop(); const previous = calls; await vi.advanceTimersByTimeAsync(5000); expect(calls).toBe(previous); expect(calls).toBe(1);
});
