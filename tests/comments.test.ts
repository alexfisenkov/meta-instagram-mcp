import { describe, expect, it, vi } from "vitest";
import { buildCommentWrite, createCommentsDomain } from "../src/comments.js";
import type { ApiAccountContext } from "../src/account-context.js";

function makeContext(): ApiAccountContext {
  return {
    authMode: "facebook", accountBinding: "instagram:ig-17", instagramUserId: "ig-17", facebookPageId: "page-4",
    requestedScopes: ["instagram_manage_comments", "pages_show_list", "pages_manage_metadata", "instagram_manage_messages"],
    confirmedScopes: ["instagram_manage_comments", "pages_show_list", "pages_manage_metadata", "instagram_manage_messages"], scopeStatus: "confirmed",
    userClient: { get: vi.fn() } as never, pageClient: { get: vi.fn() } as never
  };
}

describe("Comments API domain", () => {
  it("reads the exact media comment page and preserves visibility evidence", async () => {
    const ctx = makeContext();
    const get = vi.fn().mockResolvedValue({ data: [{ id: "comment-5", text: "question", timestamp: "2026-10-05T10:00:00Z", hidden: true, replies_count: 0 }], paging: { cursors: { after: "next-comments" }, next: "https://graph.facebook.com/next" } });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createCommentsDomain(async () => ctx);

    const result = await domain.listComments({ accountBinding: ctx.accountBinding, nativeId: "media-3" }, { limit: 1, cursor: "prev" });

    expect(get).toHaveBeenCalledWith("/media-3/comments", expect.objectContaining({ fields: "id,text,timestamp,from,like_count,hidden,replies_count", limit: 1, after: "prev" }));
    expect(result.data).toMatchObject({ items: [{ id: "comment-5", hidden: true }], nextCursor: "next-comments" });
    expect(result.coverage).toBe("partial");
  });

  it("maps private reply to IG ID with comment_id and text; does not invent comment-like routes", () => {
    const ctx = makeContext();
    const privateReply = buildCommentWrite(ctx, {
      source: "api", accountBinding: ctx.accountBinding, action: "comment.private_reply",
      payload: { kind: "comment.private_reply", text: "Hello" },
      target: { accountBinding: ctx.accountBinding, nativeId: "comment-5" }, contextHash: "ctx"
    });
    expect(privateReply).toEqual({ method: "postJson", path: "/ig-17/messages", body: {
      recipient: { comment_id: "comment-5" }, message: { text: "Hello" }
    } });
    expect(() => buildCommentWrite(ctx, {
      source: "api", accountBinding: ctx.accountBinding, action: "comment.like",
      payload: { kind: "comment.like" }, target: { accountBinding: ctx.accountBinding, nativeId: "comment-5" }, contextHash: "ctx"
    })).toThrow(/unsupported/);
    const publicReply = buildCommentWrite(ctx, {
      source: "api", accountBinding: ctx.accountBinding, action: "comment.reply",
      payload: { kind: "comment.reply", text: "Public answer" },
      target: { accountBinding: ctx.accountBinding, nativeId: "comment-5" }, contextHash: "ctx"
    });
    expect(publicReply).toEqual({ method: "post", path: "/comment-5/replies", form: { message: "Public answer" } });
    expect(buildCommentWrite(ctx, { source: "api", accountBinding: ctx.accountBinding, action: "comment.hide", payload: { kind: "comment.hide" }, target: { accountBinding: ctx.accountBinding, nativeId: "comment-5" }, contextHash: "ctx" })).toMatchObject({ method: "post", path: "/comment-5", form: { hidden: true } });
    expect(buildCommentWrite(ctx, { source: "api", accountBinding: ctx.accountBinding, action: "comment.show", payload: { kind: "comment.show" }, target: { accountBinding: ctx.accountBinding, nativeId: "comment-5" }, contextHash: "ctx" })).toMatchObject({ method: "post", path: "/comment-5", form: { hidden: false } });
    expect(buildCommentWrite(ctx, { source: "api", accountBinding: ctx.accountBinding, action: "comment.delete", payload: { kind: "comment.delete" }, target: { accountBinding: ctx.accountBinding, nativeId: "comment-5" }, contextHash: "ctx" })).toMatchObject({ method: "delete", path: "/comment-5" });
  });

  it("prepares a single-window private reply only from a Facebook Page-token context", async () => {
    const ctx = makeContext();
    const get = vi.fn().mockResolvedValue({ id: "comment-5", timestamp: "2026-10-03T12:00:00Z", text: "question" });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createCommentsDomain(async () => ctx, () => new Date("2026-10-06T12:00:00Z"));

    const intent = await domain.prepareReply({ accountBinding: ctx.accountBinding, nativeId: "comment-5" }, "Private response", true);

    expect(get).toHaveBeenCalledWith("/comment-5", expect.any(Object));
    expect(intent).toMatchObject({ action: "comment.private_reply", source: "api", payload: { kind: "comment.private_reply", text: "Private response" } });
    const expired = createCommentsDomain(async () => ctx, () => new Date("2026-10-12T12:00:00Z"));
    await expect(expired.prepareReply({ accountBinding: ctx.accountBinding, nativeId: "comment-5" }, "Late", true)).rejects.toThrow(/7-day/);
  });

  it("fails closed when granted comment scopes are unknown", async () => {
    const ctx = makeContext();
    ctx.confirmedScopes = undefined;
    ctx.scopeStatus = "unknown";
    const get = vi.fn();
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createCommentsDomain(async () => ctx);
    const target = { accountBinding: ctx.accountBinding, nativeId: "media-3" };

    await expect(domain.listComments(target)).rejects.toThrow(/granted permissions are unknown/i);
    await expect(domain.prepareReply({ ...target, nativeId: "comment-5" }, "Reply")).rejects.toThrow(/granted permissions are unknown/i);
    expect(get).not.toHaveBeenCalled();
  });

  it("marks a comment pending only when a complete known reply set contains no owner reply", async () => {
    const ctx = makeContext();
    const get = vi.fn(async (path: string) => path === "/media-3/comments"
      ? { data: [{ id: "comment-pending", text: "Question", timestamp: "2026-10-05T10:00:00Z", from: { id: "peer-1" }, replies_count: 1 }] }
      : { data: [{ id: "reply-1", timestamp: "2026-10-05T11:00:00Z", from: { id: "peer-2" }, text: "Peer reply" }] });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createCommentsDomain(async () => ctx);

    const result = await domain.listUnanswered({ accountBinding: ctx.accountBinding, nativeId: "media-3" });

    expect(get).toHaveBeenCalledWith("/comment-pending/replies", expect.any(Object));
    expect(result.data).toMatchObject({ items: [{ commentId: "comment-pending", unread: "unknown", unanswered: true }] });
  });

  it("recognizes a verified owner reply and keeps incomplete reply evidence unknown", async () => {
    const ctx = makeContext();
    const get = vi.fn(async (path: string) => {
      if (path === "/media-3/comments") return { data: [
        { id: "comment-answered", timestamp: "2026-10-05T10:00:00Z", from: { id: "peer-1" }, replies_count: 1 },
        { id: "comment-incomplete", timestamp: "2026-10-05T10:00:00Z", from: { id: "peer-2" }, replies_count: 2 }
      ] };
      if (path === "/comment-answered/replies") return { data: [{ id: "reply-owner", timestamp: "2026-10-05T11:00:00Z", from: { id: "page-4" } }] };
      return { data: [{ id: "reply-unknown", timestamp: "2026-10-05T11:00:00Z", from: { id: "peer-3" } }] };
    });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createCommentsDomain(async () => ctx);

    const result = await domain.listUnanswered({ accountBinding: ctx.accountBinding, nativeId: "media-3" });

    expect(result.data).toMatchObject({ items: [
      { commentId: "comment-answered", unanswered: false },
      { commentId: "comment-incomplete", unanswered: "unknown" }
    ] });
  });

  it("keeps comment status unknown when reply pagination has a next page without an after cursor", async () => {
    const ctx = makeContext();
    const get = vi.fn(async (path: string) => path === "/media-3/comments"
      ? { data: [{ id: "comment-paged", timestamp: "2026-10-05T10:00:00Z", from: { id: "peer-1" }, replies_count: 1 }] }
      : { data: [{ id: "reply-peer", timestamp: "2026-10-05T11:00:00Z", from: { id: "peer-2" } }], paging: { next: "https://graph.facebook.com/next" } });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createCommentsDomain(async () => ctx);

    const result = await domain.listUnanswered({ accountBinding: ctx.accountBinding, nativeId: "media-3" });

    expect(result.data).toMatchObject({ items: [{ commentId: "comment-paged", unanswered: "unknown" }] });
  });

  it("marks triage coverage partial for a timestamped comment without author identity but preserves raw-list coverage", async () => {
    const ctx = makeContext();
    const get = vi.fn().mockResolvedValue({ data: [{ id: "comment-no-author", timestamp: "2026-10-05T10:00:00Z", replies_count: 0 }] });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createCommentsDomain(async () => ctx);
    const target = { accountBinding: ctx.accountBinding, nativeId: "media-3" };

    const raw = await domain.listComments(target);
    const triage = await domain.listUnanswered(target);

    expect(raw.coverage).toBe("complete");
    expect(triage.data).toMatchObject({ items: [{ commentId: "comment-no-author", unanswered: "unknown" }] });
    expect(triage.coverage).toBe("partial");
  });
});
