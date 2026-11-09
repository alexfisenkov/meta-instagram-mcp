import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StudentBroker } from "../src/student/broker.js";
import { GrantLifecycle } from "../src/student/grant-lifecycle.js";
import { StudentRegistry, configFingerprint } from "../src/student/registry.js";
import { StudentVault } from "../src/student/vault.js";
import type { ProductConfig } from "../src/student/types.js";
const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of disposals.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "student-retention-")); disposals.push(() => rm(dir, { recursive: true, force: true })); const vault = await StudentVault.open(dir, randomBytes(32)); disposals.push(() => vault.close());
  const now = 1_800_000_000_000, subject = { tenantId: "masterskaya", sub: "student-a" };
  const config: ProductConfig = { product: "whatsapp", key: "wa", provider: "facebook_business", appId: "123", appSecret: "secret", configId: "456", apiVersion: "v27.0", callbackUrl: "https://broker.example/student/oauth/callback", admission: "live", testSubjects: [] };
  const grant = { ...subject, id: "grant", provider: "facebook_business" as const };
  await vault.transaction((db) => { db.grants.push({ ...grant, configKey: "wa", fingerprint: configFingerprint(config), providerUserId: "user", scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], status: "active", credential: vault.seal(grant, { accessToken: "token", assetTokens: {} }), createdAt: new Date(now).toISOString() }); db.connections.push({ ...subject, id: "connection", product: "whatsapp", grantId: "grant", providerId: "phone", parentId: "waba", label: "own", capabilities: ["account", "inbox"], status: "connected", updatedAt: new Date(now).toISOString() }); db.events.push({ connectionId: "connection", eventId: "expired", receivedAt: new Date(now - 30 * 86_400_000).toISOString(), data: { text: "expired-private" } }, { connectionId: "connection", eventId: "fresh", receivedAt: new Date(now - 1000).toISOString(), data: { text: "fresh-private" } }); });
  const registry = new StudentRegistry([config]), provider = { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); } };
  return { vault, now, subject, registry, provider };
}
it("never serves a 30-day-old message even when no new webhook has arrived", async () => {
  const { vault, now, subject, registry, provider } = await fixture(); const broker = new StudentBroker(vault, registry, provider, "https://platform.example", () => now);
  const result = await broker.read(subject, { connectionId: "connection", operation: "inbox" }); expect(JSON.stringify(result)).not.toContain("expired-private"); expect(JSON.stringify(result)).toContain("fresh-private");
});
it("the scheduled lifecycle sweep deletes expired message content without another webhook", async () => {
  const { vault, now, registry, provider } = await fixture(); vi.useFakeTimers();
  const lifecycle = new GrantLifecycle(vault, registry, provider, () => now); lifecycle.start(1000); await vi.advanceTimersByTimeAsync(1000); await lifecycle.stop();
  expect((await vault.snapshot()).events.map((event) => event.eventId)).toEqual(["fresh"]);
});
