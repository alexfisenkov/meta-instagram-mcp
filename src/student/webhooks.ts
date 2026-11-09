import { createHash, createHmac } from "node:crypto";
import { safeEqual } from "./auth.js";
import { BrokerError, type ProductConfig } from "./types.js";
import { StudentVault } from "./vault.js";
import { configFingerprint } from "./registry.js";
import { eventWithinRetention } from "./retention.js";
export async function receiveStudentWebhook(vault: StudentVault, config: ProductConfig, raw: Buffer, signature: string | undefined): Promise<void> {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature) || !safeEqual(signature.toLowerCase(), `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`)) throw new BrokerError("invalid_signature");
  if (raw.length > 262_144) throw new BrokerError("request_too_large");
  let payload; try { payload = JSON.parse(raw.toString("utf8")); } catch { throw new BrokerError("invalid_webhook"); }
  const expectedObject = config.product === "whatsapp" ? "whatsapp_business_account" : config.product === "instagram" ? "instagram" : "page";
  if (payload.object !== expectedObject || !Array.isArray(payload.entry) || payload.entry.length > 100) throw new BrokerError("invalid_webhook");
  const receivedAt = new Date().toISOString();
  await vault.transaction((db) => {
    for (const entry of payload.entry) {
      if (!entry || typeof entry.id !== "string") continue;
      const eligible = db.connections.filter((c) => c.status === "connected" && c.capabilities.includes("inbox") && c.product === config.product && (config.product === "whatsapp" ? c.parentId : c.providerId) === entry.id && db.grants.some((g) => g.id === c.grantId && g.status === "active" && g.configKey === config.key && g.fingerprint === configFingerprint(config) && (g.expiresAt === undefined || g.expiresAt > Date.now() / 1000) && g.sub === c.sub && g.tenantId === c.tenantId));
      for (const c of eligible) {
        const messages = config.product === "whatsapp"
          ? (Array.isArray(entry.changes) ? entry.changes : []).filter((change: any) => change?.field === "messages" && change.value?.metadata?.phone_number_id === c.providerId).flatMap((change: any) => Array.isArray(change.value.messages) ? change.value.messages : [])
          : (Array.isArray(entry.messaging) ? entry.messaging : []).map((item: any) => ({ id: item?.message?.mid, text: { body: item?.message?.text }, timestamp: item?.timestamp }));
        for (const message of messages.slice(0, 100)) {
          if (typeof message?.id !== "string" || message.id.length > 256 || typeof message.text?.body !== "string") continue;
          const eventId = createHash("sha256").update(JSON.stringify([c.id, message.id])).digest("hex");
          if (db.events.some((event) => event.connectionId === c.id && event.eventId === eventId)) continue;
          db.events.push({ connectionId: c.id, eventId, receivedAt, data: { id: message.id, text: message.text.body.slice(0, 16_384), ...(typeof message.timestamp === "string" || typeof message.timestamp === "number" ? { timestamp: String(message.timestamp).slice(0, 32) } : {}) } });
        }
      }
    }
    // Bounded encrypted retention; webhook access is always scoped by connection id on read.
    db.events = db.events.filter((event) => eventWithinRetention(event, Date.now())).slice(-10_000);
  });
}
