import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { StoredWebhookEvent } from "./webhook-journal.js";

export interface WebhookJournalPort {
  append(events: readonly StoredWebhookEvent[]): Promise<{ inserted: number; duplicate: number }>;
}
export interface WebhookReceiverOptions {
  appSecret: string;
  verifyToken: string;
  expectedAccountIds: readonly string[];
  journal: WebhookJournalPort;
  maxBodyBytes?: number;
  callbackPath?: string;
  now?: () => string;
}
export interface WebhookRequest {
  method: string;
  url: string;
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: Buffer | Uint8Array;
}
export interface WebhookResponse { status: number; body: string; contentType: "text/plain; charset=utf-8" }
export interface WebhookReceiver { handle(request: WebhookRequest): Promise<WebhookResponse> }

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS = 100;

export function createWebhookReceiver(options: WebhookReceiverOptions): WebhookReceiver {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const callbackPath = options.callbackPath ?? "/webhook";
  if (!options.appSecret || !options.verifyToken || !Array.isArray(options.expectedAccountIds)
    || options.expectedAccountIds.length === 0
    || options.expectedAccountIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("Webhook receiver configuration is incomplete.");
  }
  const expectedAccountIds = new Set(options.expectedAccountIds);
  return {
    async handle(request) {
      let url: URL;
      try { url = new URL(request.url, "https://webhook.invalid"); } catch { return response(400, "Invalid request."); }
      if (url.pathname !== callbackPath) return response(404, "Not found.");
      if (request.method === "GET") return verifyChallenge(url, options.verifyToken);
      if (request.method !== "POST") return response(405, "Method not allowed.");
      const rawBody = Buffer.from(request.rawBody ?? []);
      if (rawBody.length > maxBodyBytes) return response(413, "Payload too large.");
      const signature = getHeader(request.headers, "x-hub-signature-256");
      if (!signature || !verifySignature(rawBody, signature, options.appSecret)) return response(401, "Invalid signature.");
      let payload: unknown;
      try { payload = JSON.parse(rawBody.toString("utf8")) as unknown; }
      catch { return response(400, "Invalid event payload."); }
      const parsed = parseEvents(payload, options.now?.() ?? new Date().toISOString(), expectedAccountIds);
      if (parsed && "foreignAccount" in parsed) return response(403, "Event account is not configured.");
      const events = parsed?.events;
      if (!events || events.length === 0 || events.length > MAX_EVENTS) return response(400, "Invalid event payload.");
      try {
        await options.journal.append(events);
        return response(200, "EVENT_RECEIVED");
      } catch {
        return response(503, "Event storage unavailable.");
      }
    },
  };
}

function verifyChallenge(url: URL, verifyToken: string): WebhookResponse {
  const mode = url.searchParams.get("hub.mode");
  const candidate = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || !constantEqual(candidate, verifyToken) || !/^[A-Za-z0-9._-]{1,256}$/.test(challenge)) return response(403, "Verification failed.");
  return response(200, challenge);
}

function verifySignature(body: Buffer, value: string, secret: string): boolean {
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(value);
  if (!match) return false;
  const supplied = Buffer.from(match[1]!, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(supplied, expected);
}

type EventParseResult = { events: StoredWebhookEvent[] } | { foreignAccount: true };

function parseEvents(payload: unknown, receivedAt: string, expectedAccountIds: ReadonlySet<string>): EventParseResult | undefined {
  if (!isRecord(payload) || payload.object !== "instagram" || !Array.isArray(payload.entry) || payload.entry.length > MAX_EVENTS) return undefined;
  const events: StoredWebhookEvent[] = [];
  let foreignAccount = false;
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !validId(entry.id) || (entry.time !== undefined && !validTime(entry.time))) return undefined;
    const accountId = String(entry.id);
    if (!expectedAccountIds.has(accountId)) foreignAccount = true;
    const timestamp = entry.time === undefined ? undefined : String(entry.time);
    if (entry.messaging !== undefined) {
      if (!Array.isArray(entry.messaging)) return undefined;
      for (const item of entry.messaging) {
        if (!isRecord(item)) return undefined;
        if (item.message !== undefined) {
          if (!isRecord(item.message) || (item.message.text !== undefined && typeof item.message.text !== "string")) return undefined;
          const messageId = validId(item.message.mid) ? String(item.message.mid) : undefined;
          events.push(makeEvent(messageId, item.message.is_echo === true ? "echo" : "message", accountId, receivedAt, timestamp, {
            ...(messageId ? { messageId } : {}),
            ...(idFrom(item.sender) ? { senderId: idFrom(item.sender) } : {}),
            ...(idFrom(item.recipient) ? { recipientId: idFrom(item.recipient) } : {}),
            ...(typeof item.message.text === "string" ? { text: item.message.text } : {}),
          }));
        }
        if (item.reaction !== undefined) {
          if (!isRecord(item.reaction)) return undefined;
          const messageId = validId(item.reaction.mid) ? String(item.reaction.mid) : undefined;
          events.push(makeEvent(messageId, "reaction", accountId, receivedAt, timestamp, {
            ...(messageId ? { messageId } : {}), action: safeScalar(item.reaction.action), reaction: safeScalar(item.reaction.emoji),
            ...(idFrom(item.sender) ? { senderId: idFrom(item.sender) } : {}),
          }));
        }
      }
    }
    if (entry.changes !== undefined) {
      if (!Array.isArray(entry.changes)) return undefined;
      for (const change of entry.changes) {
        if (!isRecord(change) || typeof change.field !== "string" || !isRecord(change.value)) return undefined;
        if (change.field !== "comments") continue;
        const commentId = validId(change.value.id) ? String(change.value.id) : undefined;
        if (change.value.text !== undefined && typeof change.value.text !== "string") return undefined;
        events.push(makeEvent(commentId, "comment", accountId, receivedAt, timestamp, {
          ...(commentId ? { commentId } : {}), ...(validId(change.value.media?.id) ? { mediaId: String((change.value.media as Record<string, unknown>).id) } : {}),
          ...(idFrom(change.value.from) ? { commenterId: idFrom(change.value.from) } : {}),
          ...(typeof change.value.text === "string" ? { text: change.value.text } : {}),
        }));
      }
    }
  }
  if (events.length > MAX_EVENTS) return undefined;
  return foreignAccount ? { foreignAccount: true } : { events };
}

function makeEvent(nativeId: string | undefined, type: StoredWebhookEvent["type"], accountId: string, receivedAt: string, timestamp: string | undefined, data: Record<string, unknown>): StoredWebhookEvent {
  const identity = nativeId ? `${type}:${accountId}:${nativeId}` : `${type}:${accountId}:${createHash("sha256").update(JSON.stringify(data)).digest("hex")}`;
  return { id: identity, type, source: "meta_webhook", receivedAt, accountId, ...(timestamp ? { occurredAt: timestamp } : {}), data };
}
function response(status: number, body: string): WebhookResponse { return { status, body, contentType: "text/plain; charset=utf-8" }; }
function getHeader(headers: WebhookRequest["headers"], name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
}
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
function validId(value: unknown): value is string | number { return (typeof value === "string" && value.length > 0 && value.length <= 256) || (typeof value === "number" && Number.isSafeInteger(value)); }
function validTime(value: unknown): boolean { return validId(value); }
function idFrom(value: unknown): string | undefined { return isRecord(value) && validId(value.id) ? String(value.id) : undefined; }
function safeScalar(value: unknown): string | undefined { return typeof value === "string" && value.length <= 256 ? value : undefined; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
