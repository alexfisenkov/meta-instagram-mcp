import { createHash } from "node:crypto";
import type { ApiAccountContext, AccountContextResolver } from "./account-context.js";
import type { MutationIntent, Observation, TargetRef } from "./domain-types.js";
import type { MetaClient } from "./meta-client.js";

export interface DirectQuery { limit?: number; cursor?: string; olderCursor?: string }
export interface DirectDomain {
  listConversations(q?: DirectQuery): Promise<Observation<unknown>>;
  readConversation(target: TargetRef, q?: DirectQuery): Promise<Observation<unknown>>;
  listUnanswered(q?: DirectQuery): Promise<Observation<unknown>>;
  prepareSend(target: TargetRef, text: string): Promise<MutationIntent>;
  prepareReaction(target: TargetRef, reaction: string): Promise<MutationIntent>;
}

const OWNER_SCOPES: Record<ApiAccountContext["authMode"], string[]> = {
  facebook: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"], instagram: ["instagram_business_manage_messages"]
};
const DEFAULT_FIELDS = "id,from,to,message,created_time";
const MAX_UNANSWERED_CONVERSATIONS = 20;

export async function readConversationWithContext(ctx: ApiAccountContext, target: TargetRef, q: DirectQuery = {}): Promise<Observation<unknown>> {
  ensureScopes(ctx, OWNER_SCOPES[ctx.authMode]);
  assertMessagingTask(ctx);
  ensureAccountTarget(target, ctx);
  const client = messagingClient(ctx);
  const limit = boundedMessageLimit(q.limit);
  const result = await client.get(`/${encodeURIComponent(requireId(target.nativeId, "conversation"))}/messages`, {
    fields: DEFAULT_FIELDS, limit, after: q.olderCursor ?? q.cursor
  });
  const page = graphPage(result);
  const normalized = normalizeMessagePage(page.items, ctx);
  return observation(ctx, `conversation:${target.nativeId}`, normalized, {
    coverage: page.hasNext || page.items.length >= limit ? "partial" : normalized.complete ? "complete" : "unknown",
    historyCompleteness: "limited",
    limits: { maxMessagesPerConversation: 20, requestsInactiveDays: 30 },
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    errors: normalized.complete ? [] : [{ code: "direction_or_time_unknown", message: "Some message direction or timestamp is unknown." }]
  });
}

export async function listConversationsWithContext(ctx: ApiAccountContext, q: DirectQuery = {}): Promise<Observation<unknown>> {
  ensureScopes(ctx, OWNER_SCOPES[ctx.authMode]);
  assertMessagingTask(ctx);
  const client = messagingClient(ctx);
  const limit = boundedLimit(q.limit, 20);
  const path = ctx.authMode === "facebook"
    ? `/${encodeURIComponent(requireId(ctx.facebookPageId, "Facebook Page"))}/conversations`
    : `/${encodeURIComponent(ctx.instagramUserId)}/conversations`;
  const result = await client.get(path, {
    platform: "instagram", fields: "id,updated_time,participants", limit, after: q.cursor
  });
  const page = graphPage(result);
  return observation(ctx, "conversations", {
    items: page.items.map((item) => ({
      id: stringValue(item.id), updatedAt: stringValue(item.updated_time),
      participants: item.participants, unread: "unknown" as const,
      unanswered: "unknown" as const
    })),
    nextCursor: page.nextCursor,
    orderedBy: "api_recently_active"
  }, {
    coverage: page.hasNext || page.items.length >= limit ? "partial" : "unknown", historyCompleteness: "limited",
    limits: { maxMessagesPerConversation: 20, requestsInactiveDays: 30 },
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), errors: []
  });
}

export function createDirectDomain(resolveContext: AccountContextResolver, now: () => Date = () => new Date()): DirectDomain {
  async function context() { return resolveContext(); }
  async function readConversation(target: TargetRef, q: DirectQuery = {}): Promise<Observation<unknown>> {
    return readConversationWithContext(await context(), target, q);
  }

  return {
    async listConversations(q = {}) {
      return listConversationsWithContext(await context(), q);
    },
    readConversation,
    async listUnanswered(q = {}) {
      const ctx = await context();
      const limit = Math.min(MAX_UNANSWERED_CONVERSATIONS, boundedLimit(q.limit, MAX_UNANSWERED_CONVERSATIONS));
      const list = await listConversationsWithContext(ctx, { ...q, limit });
      const data = isRecord(list.data) && Array.isArray(list.data.items) ? list.data.items : [];
      const items = [];
      for (const raw of data.slice(0, limit)) {
        if (!isRecord(raw) || typeof raw.id !== "string") continue;
        const target: TargetRef = { accountBinding: ctx.accountBinding, nativeId: raw.id };
        const conversation = await readConversationWithContext(ctx, target, { limit: 20 });
        const parsed = isRecord(conversation.data) ? conversation.data : {};
        const latest = Array.isArray(parsed.messages) ? parsed.messages[0] : undefined;
        const unanswered = isRecord(latest) && latest.direction === "inbound" && parsed.complete === true
          ? true
          : isRecord(latest) && latest.direction === "outbound" && parsed.complete === true ? false : "unknown";
        items.push({ conversationId: raw.id, unread: "unknown", unanswered, latestMessage: latest });
      }
      return { ...list, data: { items, nextCursor: isRecord(list.data) ? list.data.nextCursor : undefined } };
    },
    async prepareSend(target, text) {
      const ctx = await context();
      ensureScopes(ctx, OWNER_SCOPES[ctx.authMode]);
      ensureAccountTarget(target, ctx);
      const snapshot = await readConversationWithContext(ctx, target, { limit: 20 });
      const data = isRecord(snapshot.data) ? snapshot.data : {};
      if (data.complete !== true) throw new Error("Direction, timestamp, or message ordering is unknown; reply was not prepared.");
      if (Buffer.byteLength(text, "utf8") > 1000) throw new Error("Direct message text exceeds Meta's 1000-byte API limit.");
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const latestInbound = messages.find((message) => isRecord(message) && message.direction === "inbound");
      if (!isRecord(latestInbound) || typeof latestInbound.createdAt !== "string") {
        throw new Error("A known inbound message and timestamp are required before preparing a reply.");
      }
      const age = now().getTime() - Date.parse(latestInbound.createdAt);
      if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) {
        throw new Error("The standard 24-hour messaging window is not open.");
      }
      const recipientId = stringValue(isRecord(latestInbound.from) ? latestInbound.from.id : undefined);
      if (!recipientId || [ctx.instagramUserId, ctx.facebookPageId].includes(recipientId)) {
        throw new Error("The recipient identity is not known from an inbound message.");
      }
      return makeIntent(ctx, "message.send", { kind: "message.send", text }, target, hashContext(snapshot));
    },
    async prepareReaction(target, reaction) {
      const ctx = await context();
      if (ctx.authMode === "facebook") throw new Error("Facebook Login message reactions are unsupported by the verified Instagram API surface.");
      ensureScopes(ctx, OWNER_SCOPES[ctx.authMode]);
      ensureAccountTarget(target, ctx);
      if (reaction !== "love" && !/^emoji:.+$/u.test(reaction)) throw new Error("Direct reaction must be love or emoji:<character>.");
      const snapshot = await readConversationWithContext(ctx, target, { limit: 20 });
      const data = isRecord(snapshot.data) ? snapshot.data : {};
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const latest = messages.find((item) => isRecord(item) && item.direction === "inbound");
      if (data.complete !== true || !isRecord(latest) || typeof latest.id !== "string" ||
          !stringValue(isRecord(latest.from) ? latest.from.id : undefined)) throw new Error("A fully identified inbound message is required before preparing a reaction.");
      const latestAt = typeof latest.createdAt === "string" ? Date.parse(latest.createdAt) : Number.NaN;
      const age = now().getTime() - latestAt;
      if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) throw new Error("The standard 24-hour messaging window is not open.");
      return makeIntent(ctx, "message.react", { kind: "message.react", reaction }, target, hashContext(snapshot));
    }
  };
}

export function normalizeMessagePage(items: Record<string, unknown>[], ctx: ApiAccountContext) {
  const messages = items.map((item) => {
    const from = isRecord(item.from) ? item.from : undefined;
    const fromId = stringValue(from?.id);
    const direction = fromId && [ctx.instagramUserId, ctx.facebookPageId].includes(fromId) ? "outbound"
      : fromId ? "inbound" : "unknown";
    return { id: stringValue(item.id), from, to: item.to, text: stringValue(item.message), createdAt: stringValue(item.created_time), direction };
  });
  const timestampsKnown = messages.every((message) => Boolean(message.createdAt && Number.isFinite(Date.parse(message.createdAt))));
  const ordered = timestampsKnown && messages.every((message, index) => index === 0 || Date.parse(messages[index - 1].createdAt!) >= Date.parse(message.createdAt!));
  return { messages, complete: timestampsKnown && ordered && messages.every((message) => message.direction !== "unknown") };
}

export function messagingClient(ctx: ApiAccountContext): MetaClient {
  if (ctx.authMode === "facebook") {
    if (!ctx.pageClient) throw new Error("Facebook Page messaging permission and Page token are not resolved.");
    return ctx.pageClient;
  }
  return ctx.userClient;
}

export function assertMessagingTask(ctx: ApiAccountContext): void {
  if (ctx.authMode === "facebook" && !ctx.pageTasks?.includes("MESSAGING")) throw new Error("Facebook Page does not report the MESSAGING task.");
}

export function ensureScope(ctx: ApiAccountContext, scope: string): void {
  if (!ctx.confirmedScopes) throw new Error(`Granted permissions are unknown; required permission cannot be confirmed: ${scope}.`);
  if (!ctx.confirmedScopes.includes(scope)) throw new Error(`Missing required permission: ${scope}.`);
}

export function ensureScopes(ctx: ApiAccountContext, scopes: readonly string[]): void {
  for (const scope of scopes) ensureScope(ctx, scope);
}

export function hashContext(value: unknown): string {
  const stable = isRecord(value) && "capturedAt" in value
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "capturedAt"))
    : value;
  return createHash("sha256").update(stableStringify(stable)).digest("hex");
}

function makeIntent(ctx: ApiAccountContext, action: MutationIntent["action"], payload: MutationIntent["payload"], target: TargetRef, contextHash: string): MutationIntent {
  return { source: "api", accountBinding: ctx.accountBinding, action, payload, target, contextHash };
}
function observation(ctx: ApiAccountContext, nativeRef: string, data: unknown, extra: {
  coverage: Observation<unknown>["coverage"]; historyCompleteness: Observation<unknown>["historyCompleteness"];
  limits?: Observation<unknown>["limits"]; nextCursor?: string; errors: Observation<unknown>["errors"];
}) {
  return {
    source: "api" as const, nativeRef, accountBinding: ctx.accountBinding, capturedAt: new Date().toISOString(),
    availability: "ready" as const, coverage: extra.coverage, historyCompleteness: extra.historyCompleteness,
    ...(extra.limits ? { limits: extra.limits } : {}), data,
    errors: extra.errors, ...(extra.nextCursor ? { nextCursor: extra.nextCursor } : {})
  };
}
function graphPage(value: unknown) {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.data) ? record.data.filter(isRecord) : [];
  const paging = isRecord(record.paging) ? record.paging : {};
  const cursors = isRecord(paging.cursors) ? paging.cursors : {};
  const nextCursor = typeof cursors.after === "string" ? cursors.after : undefined;
  return { items, nextCursor, hasNext: Boolean(paging.next) || Boolean(nextCursor) };
}
function boundedLimit(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : fallback; }
function boundedMessageLimit(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(20, Math.floor(value))) : 20; }
function ensureAccountTarget(target: TargetRef, ctx: ApiAccountContext): void { if (target.accountBinding !== ctx.accountBinding) throw new Error("Target belongs to a different Instagram account."); }
function requireId(value: string | undefined, kind: string): string { if (!value || /[/?#]/.test(value)) throw new Error(`A valid ${kind} id is required.`); return value; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stableStringify(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`; }
