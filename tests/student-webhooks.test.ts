import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { receiveStudentWebhook } from "../src/student/webhooks.js";
import { StudentVault } from "../src/student/vault.js";
import { configFingerprint } from "../src/student/registry.js";
import type { Connection, ProductConfig } from "../src/student/types.js";
it("verifies exact raw signature before routing a mixed-tenant WhatsApp batch to own connections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "student-webhook-")), vault = await StudentVault.open(dir, randomBytes(32));
  const config: ProductConfig = { product: "whatsapp", key: "wa", provider: "facebook_business", appId: "123", appSecret: "secret", configId: "456", apiVersion: "v27.0", callbackUrl: "https://broker.example/student/oauth/callback", admission: "live", testSubjects: [] };
  const c: Connection = { id: "conn-a", tenantId: "masterskaya", sub: "a", product: "whatsapp", providerId: "phone-a", parentId: "waba-a", label: "phone", grantId: "grant-a", capabilities: ["account", "inbox"], status: "connected", updatedAt: "now" };
  try {
    await vault.transaction((db) => { db.connections.push(c, { ...c, id: "conn-b", sub: "b", providerId: "phone-b", parentId: "waba-b", grantId: "grant-b" }); db.grants.push(...["a", "b"].map((sub) => ({ id: `grant-${sub}`, tenantId: "masterskaya", sub, configKey: "wa", fingerprint: configFingerprint(config), provider: "facebook_business" as const, providerUserId: `user-${sub}`, scopes: [], status: "active" as const, credential: vault.seal({ tenantId: "masterskaya", sub, id: `grant-${sub}`, provider: "facebook_business" }, { accessToken: "secret", assetTokens: {} }), createdAt: "now" }))); });
    const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: ["a", "b", "foreign"].map((suffix) => ({ id: `waba-${suffix}`, changes: [{ field: "messages", value: { metadata: { phone_number_id: `phone-${suffix}` }, messages: [{ id: `message-${suffix}`, from: "sender", type: "text", text: { body: `private-${suffix}` } }] } }] })) }));
    await expect(receiveStudentWebhook(vault, config, raw, "sha256=" + "0".repeat(64))).rejects.toThrow("invalid_signature"); expect((await vault.snapshot()).events).toEqual([]);
    const signature = "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
    await receiveStudentWebhook(vault, config, raw, signature); await receiveStudentWebhook(vault, config, raw, signature);
    const events = (await vault.snapshot()).events; expect(events).toHaveLength(2); expect(events.find((e) => e.connectionId === "conn-a")?.data.text).toBe("private-a"); expect(events.find((e) => e.connectionId === "conn-b")?.data.text).toBe("private-b"); expect(JSON.stringify(events)).not.toContain("private-foreign");
  } finally { await vault.close(); await rm(dir, { recursive: true, force: true }); }
});
