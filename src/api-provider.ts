import type { AccountContextResolver, ApiAccountContext } from "./account-context.js";
import { createCommentsDomain, buildCommentWrite, listCommentsWithContext, listRepliesWithContext } from "./comments.js";
import { createDirectDomain, ensureScope, ensureScopes, hashContext, messagingClient, readConversationWithContext, listConversationsWithContext } from "./direct.js";
import type { MutationIntent, MutationResult, Observation, TargetRef } from "./domain-types.js";
import { MetaApiError, MetaTransportError, type MetaClient } from "./meta-client.js";
import type { ActionReadbackEvidence } from "./action-readback.js";

export type ApiReadRequest =
  | { operation: "account.inspect" }
  | { operation: "inbox.list"; limit?: number; cursor?: string }
  | { operation: "conversation.read"; target: TargetRef; olderCursor?: string; limit?: number }
  | { operation: "comments.list" | "comments.replies"; target: TargetRef; cursor?: string; limit?: number }
  | { operation: "insights.read"; target?: TargetRef; period?: string };

export interface ApiProviderOptions {
  resolveContext: AccountContextResolver;
  now?: () => Date;
}
export type ApiActionReadRequest =
  | { operation: "conversation.read"; target: TargetRef; limit?: number }
  | { operation: "comments.replies"; target: TargetRef; limit?: number };

export interface ApiProvider {
  readonly source: "api";
  status(operation?: ApiReadRequest["operation"]): Promise<{ source: "api"; availability: "ready" | "missing_scope" | "permission_blocked" | "unsupported"; capabilities: string[]; reason?: string; accountBinding?: string; scopes: { requested: string[]; confirmed?: string[]; status: "confirmed" | "unknown" } }>;
  read(request: ApiReadRequest): Promise<Observation<unknown>>;
  readForAction(request: ApiActionReadRequest): Promise<ActionReadbackEvidence>;
  refreshContext(intent: MutationIntent): Promise<{ target: TargetRef; contextHash: string }>;
  execute(intent: MutationIntent, requestId: string, contextHash: string): Promise<MutationResult>;
  readonly direct: ReturnType<typeof createDirectDomain>;
  readonly comments: ReturnType<typeof createCommentsDomain>;
}

const MSG_SCOPES: Record<ApiAccountContext["authMode"], string[]> = {
  facebook: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"], instagram: ["instagram_business_manage_messages"]
};
const COMMENTS_SCOPE: Record<ApiAccountContext["authMode"], string> = {
  facebook: "instagram_manage_comments", instagram: "instagram_business_manage_comments"
};
const INSIGHTS_SCOPE: Record<ApiAccountContext["authMode"], string> = {
  facebook: "instagram_manage_insights", instagram: "instagram_business_manage_insights"
};

export function createApiProvider(options: ApiProviderOptions): ApiProvider {
  const now = options.now ?? (() => new Date());
  const direct = createDirectDomain(options.resolveContext, now);
  const comments = createCommentsDomain(options.resolveContext, now);
  const refreshed = new Map<string, { intent: MutationIntent; context: ApiAccountContext; snapshot: unknown }>();

  return {
    source: "api",
    direct,
    comments,
    async status(operation) {
      try {
        const ctx = await options.resolveContext();
        const availabilityFor = (scopes: readonly string[], clientReady = true): "ready" | "missing_scope" | "permission_blocked" => {
          if (!ctx.confirmedScopes) return "permission_blocked";
          if (!clientReady || scopes.some((scope) => !ctx.confirmedScopes!.includes(scope))) return "missing_scope";
          return "ready";
        };
        const messageClientReady = ctx.authMode !== "facebook" || Boolean(ctx.pageClient && ctx.pageTasks?.includes("MESSAGING"));
        const directAvailability = availabilityFor(MSG_SCOPES[ctx.authMode], messageClientReady);
        const commentsAvailability = availabilityFor([COMMENTS_SCOPE[ctx.authMode]]);
        const insightsAvailability = availabilityFor([INSIGHTS_SCOPE[ctx.authMode]]);
        const capabilityAvailability = {
          "account.inspect": "unsupported" as const,
          "inbox.list": directAvailability, "conversation.read": directAvailability,
          "comments.list": commentsAvailability, "comments.replies": commentsAvailability,
          "insights.read": insightsAvailability
        } as const;
        const requestedAvailability = operation ? capabilityAvailability[operation] : directAvailability;
        const available = requestedAvailability;
        return {
          source: "api", availability: available, accountBinding: ctx.accountBinding,
          capabilities: [
            ...(directAvailability === "ready" ? ["direct.read", "inbox.list", "conversation.read"] : [`direct.read:${directAvailability}`, `inbox.list:${directAvailability}`, `conversation.read:${directAvailability}`]),
            ...(ctx.authMode === "facebook" ? ["message.react:unsupported", "message.unreact:unsupported"] : []),
            ...(commentsAvailability === "ready" ? ["comments.read", "comments.list", "comments.replies"] : [`comments.read:${commentsAvailability}`, `comments.list:${commentsAvailability}`, `comments.replies:${commentsAvailability}`]),
            insightsAvailability === "ready" ? "insights.read" : `insights.read:${insightsAvailability}`,
            "comment.like:unsupported", "comment.unlike:unsupported"
          ],
          ...(available === "permission_blocked" ? { reason: "The granted permissions could not be confirmed from the verified OAuth response or Meta permission endpoint." }
            : available === "missing_scope" ? { reason: (!operation || operation === "inbox.list" || operation === "conversation.read") && ctx.authMode === "facebook" && !ctx.pageClient
              ? "Facebook Page access is unavailable; Facebook Login Direct requires a resolved Page token and MESSAGING task."
              : "The connected account is missing a permission or Page task required for this operation." } : {}),
          scopes: { requested: ctx.requestedScopes, ...(ctx.confirmedScopes ? { confirmed: ctx.confirmedScopes } : {}), status: ctx.scopeStatus }
        };
      } catch (error) {
        return { source: "api", availability: "permission_blocked", capabilities: [], reason: safeReason(error), scopes: { requested: [], status: "unknown" } };
      }
    },
    async read(request) {
      let ctx: ApiAccountContext | undefined;
      try {
        ctx = await options.resolveContext();
        if (request.operation === "conversation.read" && request.olderCursor?.startsWith("browser-older:")) {
          return failureObservation(ctx, request.operation, "unsupported", new Error("Browser history cursors are scoped to the browser companion."));
        }
        if (request.operation === "account.inspect") return failureObservation(ctx, request.operation, "unsupported", new Error("Account inspection is supplied by a verified local companion."));
        if (request.operation === "inbox.list") return await listConversationsWithContext(ctx, request);
        if (request.operation === "conversation.read") return await readConversationWithContext(ctx, request.target, { limit: request.limit, olderCursor: request.olderCursor });
        if (request.operation === "comments.list") return await listCommentsWithContext(ctx, request.target, request);
        if (request.operation === "comments.replies") return await listRepliesWithContext(ctx, request.target, request);
        if (request.operation !== "insights.read") throw new Error("Unsupported API read operation.");
        ensureScope(ctx, INSIGHTS_SCOPE[ctx.authMode]);
        const target = request.target;
        if (target && target.accountBinding !== ctx.accountBinding) throw new Error("Target belongs to a different Instagram account.");
        const path = target?.nativeId
          ? `/${encodeURIComponent(target.nativeId)}/insights`
          : `/${encodeURIComponent(ctx.instagramUserId)}/insights`;
        const client = ctx.userClient;
        const data = await client.get(path, target ? { period: request.period ?? "day" } : { period: request.period ?? "day", metric: "reach" });
        return makeObservation(ctx, target ? `insights:${target.nativeId}` : "account-insights", data, "complete", []);
      } catch (error) {
        const availability = classifyAvailability(error, ctx);
        return failureObservation(ctx, request.operation, availability, error);
      }
    },
    async readForAction(request) {
      const ctx = await options.resolveContext();
      if (request.target.accountBinding !== ctx.accountBinding) throw new Error("Read-back target belongs to a different account.");
      const observation = request.operation === "conversation.read"
        ? await readConversationWithContext(ctx, request.target, { limit: 20 })
        : await listRepliesWithContext(ctx, request.target, { limit: 100 });
      return { observation, ownerSenderIds: [ctx.instagramUserId, ctx.facebookPageId].filter((id): id is string => Boolean(id)) };
    },
    async refreshContext(intent) {
      if (intent.source !== "api") throw new Error("API executor only accepts API-bound intents.");
      const ctx = await options.resolveContext();
      if (intent.accountBinding !== ctx.accountBinding || intent.target.accountBinding !== ctx.accountBinding) throw new Error("Mutation belongs to a different account.");
      let snapshot: unknown;
      if (intent.action.startsWith("message.")) {
        ensureScopes(ctx, MSG_SCOPES[ctx.authMode]);
        const observation = await readConversationWithContext(ctx, intent.target, { limit: 20 });
        snapshot = observation;
        validateMessageWindow(observation, now());
      } else {
        if (intent.action === "comment.private_reply") ensureScopes(ctx, [...MSG_SCOPES.facebook, COMMENTS_SCOPE.facebook]);
        else ensureScope(ctx, COMMENTS_SCOPE[ctx.authMode]);
        const comment = await readComment(ctx, intent.target);
        snapshot = comment;
        if (intent.action === "comment.private_reply") validatePrivateReplyWindow(comment, now());
      }
      const contextHash = hashContext(snapshot);
      refreshed.clear();
      refreshed.set(contextHash, { intent, context: ctx, snapshot });
      return { target: intent.target, contextHash };
    },
    async execute(intent, requestId, contextHash) {
      const cached = refreshed.get(contextHash);
      refreshed.delete(contextHash);
      if (cached?.context.authMode === "facebook" && (intent.action === "message.react" || intent.action === "message.unreact")) {
        return { status: "FAILED", reason: "Facebook Login message reactions are unsupported by the verified Instagram API surface." };
      }
      if (!cached || cached.intent.action !== intent.action || cached.intent.target.nativeId !== intent.target.nativeId ||
          cached.intent.accountBinding !== intent.accountBinding || cached.intent.payload.kind !== intent.payload.kind) {
        return { status: "FAILED", reason: "Fresh API context is unavailable; no request was sent." };
      }
      try {
        const { context: ctx, snapshot } = cached;
        let result: unknown;
        if (intent.action === "message.send" && intent.payload.kind === "message.send") {
          const latestInbound = latestInboundFromSnapshot(snapshot);
          const recipientId = isRecord(latestInbound?.from) ? stringValue(latestInbound.from.id) : undefined;
          const senderId = ctx.authMode === "facebook" ? ctx.facebookPageId : ctx.instagramUserId;
          if (!recipientId || !senderId) return { status: "FAILED", reason: "Recipient or sender identity is unknown; no request was sent." };
          result = await messagingClient(ctx).postJson(`/${encodeURIComponent(senderId)}/messages`, {
            recipient: { id: recipientId }, message: { text: intent.payload.text }
          });
        } else if ((intent.action === "message.react" || intent.action === "message.unreact") && intent.payload.kind === intent.action) {
          const latestInbound = latestInboundFromSnapshot(snapshot);
          const recipientId = stringValue(isRecord(latestInbound?.from) ? latestInbound.from.id : undefined);
          const senderId = ctx.authMode === "facebook" ? ctx.facebookPageId : ctx.instagramUserId;
          if (!latestInbound || typeof latestInbound.id !== "string" || !recipientId || !senderId) return { status: "FAILED", reason: "Reaction target or sender identity is unknown; no request was sent." };
          const isEmoji = intent.payload.reaction.startsWith("emoji:");
          const reaction = isEmoji ? "emoji" : intent.payload.reaction;
          result = await messagingClient(ctx).postJson(`/${encodeURIComponent(senderId)}/messages`, {
            recipient: { id: recipientId },
            sender_action: intent.action === "message.react" ? "react" : "unreact",
            payload: { message_id: latestInbound.id, reaction, ...(isEmoji ? { emoji: intent.payload.reaction.slice("emoji:".length) } : {}) }
          });
        } else {
          const write = buildCommentWrite(ctx, intent);
          const client = messagingClient(ctx);
          result = write.method === "postJson" ? await client.postJson(write.path, write.body!)
            : write.method === "delete" ? await client.delete(write.path)
              : await client.post(write.path, write.form!);
        }
        return { status: "ACK", ...(receiptId(result) ? { receiptId: receiptId(result) } : {}) };
      } catch (error) {
        if (error instanceof MetaApiError && error.status >= 400 && error.status < 500) return { status: "FAILED", reason: "Meta rejected the API mutation." };
        if (error instanceof MetaTransportError) return { status: "OUTCOME_UNKNOWN", reason: "Meta request outcome is unknown; no retry was made." };
        return { status: "OUTCOME_UNKNOWN", reason: safeReason(error) };
      }
    }
  };
}

function readComment(ctx: ApiAccountContext, target: TargetRef): Promise<unknown> {
  if (!target.nativeId || /[/?#]/.test(target.nativeId)) throw new Error("A valid comment id is required.");
  return messagingClient(ctx).get(`/${encodeURIComponent(target.nativeId)}`, { fields: "id,text,timestamp,from,like_count,hidden,replies_count" });
}
function validateMessageWindow(snapshot: unknown, now: Date): void {
  const latest = latestInboundFromSnapshot(snapshot);
  const at = typeof latest?.createdAt === "string" ? Date.parse(latest.createdAt) : Number.NaN;
  if (!Number.isFinite(at) || now.getTime() < at || now.getTime() - at > 24 * 60 * 60 * 1000) throw new Error("The standard 24-hour messaging window is not open.");
}
function validatePrivateReplyWindow(comment: unknown, now: Date): void {
  if (!isRecord(comment) || typeof comment.timestamp !== "string" || !Number.isFinite(Date.parse(comment.timestamp))) throw new Error("A known comment timestamp is required.");
  const age = now.getTime() - Date.parse(comment.timestamp);
  if (age < 0 || age > 7 * 24 * 60 * 60 * 1000) throw new Error("Private reply is outside its 7-day eligibility window.");
}
function latestInboundFromSnapshot(snapshot: unknown): Record<string, unknown> | undefined {
  if (!isRecord(snapshot) || !isRecord(snapshot.data) || !Array.isArray(snapshot.data.messages)) return undefined;
  return snapshot.data.messages.find((message) => isRecord(message) && message.direction === "inbound") as Record<string, unknown> | undefined;
}
function makeObservation(ctx: ApiAccountContext, nativeRef: string, data: unknown, coverage: Observation<unknown>["coverage"], errors: Observation<unknown>["errors"]): Observation<unknown> {
  return { source: "api", nativeRef, accountBinding: ctx.accountBinding, capturedAt: new Date().toISOString(), availability: "ready", coverage, historyCompleteness: "not_applicable", data, errors };
}
function failureObservation(ctx: ApiAccountContext | undefined, operation: string, availability: Observation<unknown>["availability"], error: unknown): Observation<unknown> {
  return { source: "api", nativeRef: operation, accountBinding: ctx?.accountBinding ?? "unresolved", capturedAt: new Date().toISOString(),
    availability, coverage: "unknown", historyCompleteness: "unknown", errors: [{ code: availability, message: safeReason(error) }] };
}
function classifyAvailability(error: unknown, ctx?: ApiAccountContext): Observation<unknown>["availability"] {
  if (error instanceof MetaApiError && (error.status === 403 || error.apiCode === 10 || error.apiCode === 200)) return "permission_blocked";
  if (error instanceof MetaTransportError) return "offline";
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message.startsWith("Missing required permission:")) return "missing_scope";
  if (ctx?.scopeStatus === "unknown") return "permission_blocked";
  return "permission_blocked";
}
function safeReason(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : "API request failed."; }
function receiptId(value: unknown): string | undefined { return isRecord(value) && typeof value.id === "string" ? value.id : isRecord(value) && typeof value.message_id === "string" ? value.message_id : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
