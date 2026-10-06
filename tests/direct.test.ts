import { describe, expect, it, vi } from "vitest";
import { createDirectDomain } from "../src/direct.js";
import type { ApiAccountContext } from "../src/account-context.js";

function context(mode: "facebook" | "instagram" = "facebook"): ApiAccountContext {
  const userClient = { get: vi.fn(), forFacebookPage: vi.fn() } as never;
  const pageClient = { get: vi.fn() } as never;
  return {
    authMode: mode, accountBinding: "instagram:ig-17", instagramUserId: "ig-17", facebookPageId: "page-4",
    requestedScopes: mode === "facebook" ? ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"] : ["instagram_business_manage_messages"],
    confirmedScopes: mode === "facebook" ? ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"] : ["instagram_business_manage_messages"], scopeStatus: "confirmed",
    userClient, pageClient, pageTasks: ["MESSAGING"]
  };
}

describe("Direct API domain", () => {
  it("does not read Facebook messaging without instagram_basic", async () => {
    const ctx = context();
    ctx.confirmedScopes = ["pages_show_list", "pages_manage_metadata", "instagram_manage_messages"];
    const get = vi.fn();
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createDirectDomain(async () => ctx);

    await expect(domain.readConversation({ accountBinding: ctx.accountBinding, nativeId: "thread-1" }))
      .rejects.toThrow("instagram_basic");
    await expect(domain.prepareSend({ accountBinding: ctx.accountBinding, nativeId: "thread-1" }, "Reply"))
      .rejects.toThrow("instagram_basic");
    expect(get).not.toHaveBeenCalled();
  });

  it("does not prepare Facebook reactions without a verified Instagram API capability", async () => {
    const ctx = context();
    const get = vi.fn();
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createDirectDomain(async () => ctx);

    await expect(domain.prepareReaction({ accountBinding: ctx.accountBinding, nativeId: "thread-1" }, "love"))
      .rejects.toThrow("unsupported");
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed when granted messaging scopes are unknown", async () => {
    const ctx = context();
    ctx.confirmedScopes = undefined;
    ctx.scopeStatus = "unknown";
    const get = vi.fn();
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createDirectDomain(async () => ctx);
    const target = { accountBinding: ctx.accountBinding, nativeId: "thread-1" };

    await expect(domain.listConversations()).rejects.toThrow(/granted permissions are unknown/i);
    await expect(domain.prepareSend(target, "Reply")).rejects.toThrow(/granted permissions are unknown/i);
    expect(get).not.toHaveBeenCalled();
  });

  it("uses Page conversations for Facebook Login and preserves cursor and unknown unread state", async () => {
    const ctx = context();
    const get = vi.fn().mockResolvedValue({ data: [{ id: "thread-2", updated_time: "2026-10-05T12:00:00Z" }], paging: { cursors: { after: "cursor-next" } } });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createDirectDomain(async () => ctx);

    const result = await domain.listConversations({ limit: 500, cursor: "cursor-in" });

    expect(get).toHaveBeenCalledWith("/page-4/conversations", expect.objectContaining({ platform: "instagram", limit: 100, after: "cursor-in" }));
    expect(result.data).toMatchObject({ items: [{ id: "thread-2", unread: "unknown", unanswered: "unknown" }], nextCursor: "cursor-next" });
    expect(result.coverage).toBe("partial");
    expect(result.limits).toEqual({ maxMessagesPerConversation: 20, requestsInactiveDays: 30 });
  });

  it("keeps direction unknown when sender and timestamp evidence are incomplete", async () => {
    const ctx = context("instagram");
    const get = vi.fn().mockResolvedValue({ data: [{ id: "message-1", from: { username: "someone" }, message: "hello" }] });
    (ctx.userClient as never as { get: typeof get }).get = get;
    const domain = createDirectDomain(async () => ctx);

    const result = await domain.readConversation({ accountBinding: ctx.accountBinding, nativeId: "thread-1" });

    expect(get).toHaveBeenCalledWith("/thread-1/messages", expect.objectContaining({ limit: 20, fields: "id,from,to,message,created_time" }));
    expect(result.coverage).toBe("unknown");
    expect(result.data).toMatchObject({ messages: [{ direction: "unknown", createdAt: undefined }], complete: false });
    expect(result.errors[0]?.code).toBe("direction_or_time_unknown");
  });

  it("classifies latest inbound, owner outbound, and ambiguous direction through the unanswered domain", async () => {
    const ctx = context();
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/conversations")) return { data: [{ id: "thread-in" }, { id: "thread-owner" }, { id: "thread-unknown" }] };
      if (path.endsWith("/thread-in/messages")) return { data: [{ id: "m-in", from: { id: "peer" }, created_time: "2026-10-06T10:00:00Z" }] };
      if (path.endsWith("/thread-owner/messages")) return { data: [{ id: "m-out", from: { id: "page-4" }, created_time: "2026-10-06T10:00:00Z" }] };
      return { data: [{ id: "m-unknown", from: { username: "peer" }, message: "Unclear sender", created_time: "2026-10-06T10:00:00Z" }] };
    });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createDirectDomain(async () => ctx);

    const result = await domain.listUnanswered({ limit: 3 });

    expect(result.data).toMatchObject({ items: [
      { conversationId: "thread-in", unanswered: true },
      { conversationId: "thread-owner", unanswered: false },
      { conversationId: "thread-unknown", unanswered: "unknown" }
    ] });
    expect((result.data as { items: Array<{ unread: unknown }> }).items.every((item) => item.unread === "unknown")).toBe(true);
  });

  it("keeps unanswered unknown when native message IDs are absent or equal timestamps make ordering ambiguous", async () => {
    const ctx = context();
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/conversations")) return { data: [{ id: "thread-missing-id" }, { id: "thread-equal-time" }] };
      if (path.endsWith("/thread-missing-id/messages")) return { data: [{ from: { id: "peer-1" }, created_time: "2026-10-06T10:00:00Z" }] };
      return { data: [
        { id: "message-in", from: { id: "peer-1" }, created_time: "2026-10-06T10:00:00Z" },
        { id: "message-out", from: { id: "page-4" }, created_time: "2026-10-06T10:00:00Z" }
      ] };
    });
    (ctx.pageClient as never as { get: typeof get }).get = get;
    const domain = createDirectDomain(async () => ctx);

    const result = await domain.listUnanswered({ limit: 2 });

    expect(result.data).toMatchObject({ items: [
      { conversationId: "thread-missing-id", unanswered: "unknown" },
      { conversationId: "thread-equal-time", unanswered: "unknown" }
    ] });
    expect(result.coverage).toBe("partial");
  });
});
