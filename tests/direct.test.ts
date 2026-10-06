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
});
