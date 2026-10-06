import type { ApiAccountContext, AccountContextResolver } from "./account-context.js";
import type { MutationAction, MutationIntent, Observation, TargetRef } from "./domain-types.js";
import { ensureScope, ensureScopes, hashContext, messagingClient } from "./direct.js";
import type { GraphJsonRecord } from "./meta-client.js";

export interface CommentsQuery { limit?: number; cursor?: string }
export interface CommentsDomain {
  listComments(target: TargetRef, q?: CommentsQuery): Promise<Observation<unknown>>;
  listReplies(target: TargetRef, q?: CommentsQuery): Promise<Observation<unknown>>;
  listUnanswered(target: TargetRef, q?: CommentsQuery): Promise<Observation<unknown>>;
  prepareReply(target: TargetRef, text: string, privateReply?: boolean): Promise<MutationIntent>;
  prepareAction(target: TargetRef, action: MutationAction): Promise<MutationIntent>;
}

const COMMENT_SCOPE: Record<ApiAccountContext["authMode"], string> = {
  facebook: "instagram_manage_comments", instagram: "instagram_business_manage_comments"
};
const COMMENT_FIELDS = "id,text,timestamp,from,like_count,hidden,replies_count";

export async function listCommentsWithContext(ctx: ApiAccountContext, target: TargetRef, q: CommentsQuery = {}) {
  ensureScope(ctx, COMMENT_SCOPE[ctx.authMode]);
  ensureTarget(target, ctx);
  const page = await commentReadClient(ctx).get(`/${encodeURIComponent(requireId(target.nativeId, "media"))}/comments`, {
    fields: COMMENT_FIELDS, limit: boundedLimit(q.limit), after: q.cursor
  });
  return makeObservation(ctx, `comments:${target.nativeId}`, page, boundedLimit(q.limit));
}

export async function listRepliesWithContext(ctx: ApiAccountContext, target: TargetRef, q: CommentsQuery = {}) {
  ensureScope(ctx, COMMENT_SCOPE[ctx.authMode]);
  ensureTarget(target, ctx);
  const page = await commentReadClient(ctx).get(`/${encodeURIComponent(requireId(target.nativeId, "comment"))}/replies`, {
    fields: COMMENT_FIELDS, limit: boundedLimit(q.limit), after: q.cursor
  });
  return makeObservation(ctx, `comment-replies:${target.nativeId}`, page, boundedLimit(q.limit));
}

function commentReadClient(ctx: ApiAccountContext) {
  // Meta's Facebook Login collection uses a user access token and the
  // instagram_manage_comments permission for API calls. Keep writes Page-bound.
  if (ctx.authMode === "facebook" && !ctx.pageClient) return ctx.userClient;
  return messagingClient(ctx);
}

export function createCommentsDomain(resolveContext: AccountContextResolver, now: () => Date = () => new Date()): CommentsDomain {
  async function context() { return resolveContext(); }
  async function loadComment(target: TargetRef, ctx: ApiAccountContext): Promise<Record<string, unknown>> {
    ensureTarget(target, ctx);
    const value = await messagingClient(ctx).get(`/${encodeURIComponent(requireId(target.nativeId, "comment"))}`, { fields: COMMENT_FIELDS });
    if (!isRecord(value) || typeof value.id !== "string") throw new Error("Meta did not return the requested comment.");
    return value;
  }
  return {
    async listComments(target, q = {}) {
      return listCommentsWithContext(await context(), target, q);
    },
    async listReplies(target, q = {}) {
      return listRepliesWithContext(await context(), target, q);
    },
    async listUnanswered(target, q = {}) {
      const ctx = await context();
      const result = await listCommentsWithContext(ctx, target, q);
      const comments = pageItems(result.data);
      const items = [];
      for (const comment of comments) {
        const from = isRecord(comment.from) ? comment.from : undefined;
        const authorId = stringValue(from?.id);
        const ownerKnown = authorId ? [ctx.instagramUserId, ctx.facebookPageId].includes(authorId) : undefined;
        const repliesCount = numberValue(comment.replies_count);
        const unanswered = ownerKnown === true ? false : ownerKnown === false && repliesCount === 0 ? true : "unknown";
        items.push({ id: comment.id, timestamp: comment.timestamp, unread: "unknown", unanswered,
          visibility: typeof comment.hidden === "boolean" ? (comment.hidden ? "hidden" : "visible") : "unknown" });
      }
      return { ...result, data: { items, nextCursor: isRecord(result.data) ? result.data.nextCursor : undefined } };
    },
    async prepareReply(target, text, privateReply = false) {
      const ctx = await context();
      if (privateReply) {
        if (ctx.authMode !== "facebook") throw new Error("Private replies require the Facebook Login Page token path.");
        ensureScopes(ctx, ["instagram_manage_comments", "pages_show_list", "instagram_manage_messages", "pages_manage_metadata"]);
      } else ensureScope(ctx, COMMENT_SCOPE[ctx.authMode]);
      const comment = await loadComment(target, ctx);
      const timestamp = stringValue(comment.timestamp);
      if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw new Error("A known comment timestamp is required before preparing a reply.");
      const age = now().getTime() - Date.parse(timestamp);
      if (privateReply && (age < 0 || age > 7 * 24 * 60 * 60 * 1000)) throw new Error("The private-reply 7-day window is not open.");
      const action = privateReply ? "comment.private_reply" : "comment.reply";
      return makeIntent(ctx, action, { kind: action, text }, target, hashContext(comment));
    },
    async prepareAction(target, action) {
      const ctx = await context();
      ensureScope(ctx, COMMENT_SCOPE[ctx.authMode]);
      if (!["comment.hide", "comment.show", "comment.delete"].includes(action)) throw new Error("API comment like/unlike is unsupported.");
      const comment = await loadComment(target, ctx);
      if ((action === "comment.hide" || action === "comment.show") && typeof comment.hidden !== "boolean") {
        throw new Error("Comment visibility is unknown; moderation intent was not prepared.");
      }
      if (action === "comment.hide" && comment.hidden === true || action === "comment.show" && comment.hidden === false) {
        throw new Error("The comment already has the requested visibility state.");
      }
      return makeIntent(ctx, action, { kind: action } as MutationIntent["payload"], target, hashContext(comment));
    }
  };
}

export function buildCommentWrite(ctx: ApiAccountContext, intent: MutationIntent): { method: "post" | "postJson" | "delete"; path: string; body?: GraphJsonRecord; form?: Record<string, string | boolean> } {
  const commentId = requireId(intent.target.nativeId, "comment");
  if (intent.action === "comment.reply" && intent.payload.kind === "comment.reply") {
    return { method: "post", path: `/${encodeURIComponent(commentId)}/replies`, form: { message: intent.payload.text } };
  }
  if (intent.action === "comment.private_reply" && intent.payload.kind === "comment.private_reply") {
    return { method: "postJson", path: `/${encodeURIComponent(ctx.instagramUserId)}/messages`, body: {
      recipient: { comment_id: commentId }, message: { text: intent.payload.text }
    } };
  }
  if (intent.action === "comment.hide") return { method: "post", path: `/${encodeURIComponent(commentId)}`, form: { hidden: true } };
  if (intent.action === "comment.show") return { method: "post", path: `/${encodeURIComponent(commentId)}`, form: { hidden: false } };
  if (intent.action === "comment.delete") return { method: "delete", path: `/${encodeURIComponent(commentId)}` };
  throw new Error("API comment like/unlike is unsupported.");
}

function makeIntent(ctx: ApiAccountContext, action: MutationIntent["action"], payload: MutationIntent["payload"], target: TargetRef, contextHash: string): MutationIntent {
  return { source: "api", accountBinding: ctx.accountBinding, action, payload, target, contextHash };
}
function makeObservation(ctx: ApiAccountContext, nativeRef: string, value: unknown, requestedLimit: number) {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.data) ? record.data.filter(isRecord) : [];
  const paging = isRecord(record.paging) ? record.paging : {};
  const cursors = isRecord(paging.cursors) ? paging.cursors : {};
  const nextCursor = typeof cursors.after === "string" ? cursors.after : undefined;
  const complete = items.every((item) => typeof item.timestamp === "string" && Number.isFinite(Date.parse(item.timestamp)));
  return { source: "api" as const, nativeRef, accountBinding: ctx.accountBinding, capturedAt: new Date().toISOString(),
    availability: "ready" as const, coverage: paging.next || nextCursor || items.length >= requestedLimit ? "partial" as const : complete ? "complete" as const : "unknown" as const,
    historyCompleteness: "limited" as const, data: { items, nextCursor, orderedBy: "api" },
    errors: complete ? [] : [{ code: "timestamp_unknown", message: "Comment timestamps are incomplete." }] };
}
function pageItems(value: unknown): Record<string, unknown>[] { if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.items)) return []; return value.data.items.filter(isRecord); }
function ensureTarget(target: TargetRef, ctx: ApiAccountContext): void { if (target.accountBinding !== ctx.accountBinding) throw new Error("Target belongs to a different Instagram account."); }
function requireId(value: string | undefined, kind: string): string { if (!value || /[/?#]/.test(value)) throw new Error(`A valid ${kind} id is required.`); return value; }
function boundedLimit(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 25; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
