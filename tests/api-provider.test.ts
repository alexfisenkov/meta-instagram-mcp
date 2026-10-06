import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationSafety } from "../src/action-safety.js";
import { createApiProvider } from "../src/api-provider.js";
import type { ApiAccountContext } from "../src/account-context.js";
import { createSourceRouter, type SourceProvider } from "../src/source-router.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function makeContext(permissions?: string[]) {
  const pageClient = { get: vi.fn(), post: vi.fn(), postJson: vi.fn(), delete: vi.fn() };
  const userClient = { get: vi.fn(), forFacebookPage: vi.fn() };
  const ctx: ApiAccountContext = {
    authMode: "facebook", accountBinding: "instagram:ig-17", instagramUserId: "ig-17", facebookPageId: "page-4",
    requestedScopes: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"], ...(permissions ? { confirmedScopes: permissions } : {}),
    scopeStatus: permissions ? "confirmed" : "unknown", userClient: userClient as never, pageClient: pageClient as never,
    pageTasks: ["MESSAGING"]
  };
  return { ctx, pageClient, userClient };
}

describe("official API provider", () => {
  it("requires instagram_basic before reporting Facebook messaging as ready", async () => {
    const { ctx } = makeContext(["pages_show_list", "pages_manage_metadata", "instagram_manage_messages"]);
    const provider = createApiProvider({ resolveContext: async () => ctx });

    const status = await provider.status();

    expect(status.availability).toBe("missing_scope");
    expect(status.capabilities).toContain("direct.read:missing_scope");
    expect(status.capabilities).not.toContain("direct.read");
  });

  it("reports unknown grants as permission_blocked without claiming scopes are confirmed", async () => {
    const { ctx } = makeContext();
    const provider = createApiProvider({ resolveContext: async () => ctx });

    const status = await provider.status();

    expect(status.availability).toBe("permission_blocked");
    expect(status.scopes).toMatchObject({ requested: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"], status: "unknown" });
  });

  it("uses confirmed Facebook user access for read-only comments and insights when the saved Page is unavailable", async () => {
    const { ctx, pageClient, userClient } = makeContext([
      "instagram_basic", "instagram_manage_comments", "instagram_manage_insights", "pages_manage_metadata", "instagram_manage_messages"
    ]);
    ctx.pageClient = undefined;
    ctx.pageTasks = undefined;
    ctx.pageResolutionStatus = "unavailable";
    userClient.get.mockImplementation(async (path: string) => path === "/ig-17/insights"
      ? { data: [{ name: "reach", values: [] }] }
      : { data: [{ id: "comment-3", timestamp: "2026-10-06T10:00:00Z", text: "Fixture only" }] });
    const provider = createApiProvider({ resolveContext: async () => ctx });

    const commentStatus = await provider.status("comments.list");
    const directStatus = await provider.status("inbox.list");
    const comments = await provider.read({ operation: "comments.list", target: { accountBinding: ctx.accountBinding, nativeId: "media-2" }, limit: 1 });
    const insights = await provider.read({ operation: "insights.read" });
    const sendIntent = { source: "api", accountBinding: ctx.accountBinding, action: "message.send", payload: { kind: "message.send", text: "No send" }, target: { accountBinding: ctx.accountBinding, nativeId: "thread-2" }, contextHash: "ctx" } as const;

    expect(commentStatus.availability).toBe("ready");
    expect(directStatus.availability).toBe("missing_scope");
    expect(directStatus.reason).toMatch(/Page access is unavailable/i);
    expect(comments).toMatchObject({ availability: "ready", accountBinding: ctx.accountBinding });
    expect(insights).toMatchObject({ availability: "ready", accountBinding: ctx.accountBinding });
    expect(userClient.get).toHaveBeenCalledWith("/media-2/comments", expect.any(Object));
    expect(userClient.get).toHaveBeenCalledWith("/ig-17/insights", expect.any(Object));
    await expect(provider.refreshContext(sendIntent as never)).rejects.toThrow(/MESSAGING task/i);
    expect(pageClient.postJson).not.toHaveBeenCalled();
  });

  it("keeps user-only reads blocked when granted scopes remain unknown", async () => {
    const { ctx, userClient } = makeContext();
    ctx.pageClient = undefined;
    ctx.pageResolutionStatus = "unavailable";
    const provider = createApiProvider({ resolveContext: async () => ctx });

    const status = await provider.status("insights.read");
    const observation = await provider.read({ operation: "insights.read" });

    expect(status.availability).toBe("permission_blocked");
    expect(observation.availability).toBe("permission_blocked");
    expect(userClient.get).not.toHaveBeenCalled();
  });

  it("advertises Facebook message reactions as unsupported and never dispatches them", async () => {
    const { ctx, pageClient } = makeContext(["instagram_basic", "pages_manage_metadata", "instagram_manage_messages"]);
    pageClient.get.mockResolvedValue({ data: [{ id: "msg-11", from: { id: "peer-5" }, message: "Question", created_time: "2026-10-06T10:00:00.000Z" }] });
    const provider = createApiProvider({ resolveContext: async () => ctx });
    const status = await provider.status();
    const intent = { source: "api", accountBinding: ctx.accountBinding, action: "message.react", payload: { kind: "message.react", reaction: "love" }, target: { accountBinding: ctx.accountBinding, nativeId: "thread-2" }, contextHash: "context" } as const;
    const refreshed = await provider.refreshContext(intent as never);
    const result = await provider.execute(intent as never, "request", refreshed.contextHash);

    expect(status.capabilities).toContain("message.react:unsupported");
    expect(status.capabilities).toContain("message.unreact:unsupported");
    expect(result).toMatchObject({ status: "FAILED" });
    expect(pageClient.postJson).not.toHaveBeenCalled();
  });

  it("prepares a bounded API-bound send and dispatches only after MutationSafety approval", async () => {
    const { ctx, pageClient } = makeContext(["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"]);
    const inbound = { id: "msg-11", from: { id: "peer-5" }, to: [{ id: "ig-17" }], message: "Question", created_time: "2026-10-06T10:00:00.000Z" };
    const get = vi.fn().mockResolvedValue({ data: [inbound] });
    pageClient.get = get;
    pageClient.postJson.mockResolvedValue({ recipient_id: "peer-5", message_id: "sent-9" });
    const provider = createApiProvider({ resolveContext: async () => ctx, now: () => new Date("2026-10-06T11:00:00.000Z") });
    const target = { accountBinding: ctx.accountBinding, nativeId: "thread-2" };
    const intent = await provider.direct.prepareSend(target, "Approved test text");
    expect(intent).toMatchObject({ source: "api", action: "message.send", target, payload: { kind: "message.send", text: "Approved test text" } });
    expect(get).toHaveBeenCalledWith("/thread-2/messages", expect.objectContaining({ limit: 20 }));

    const dir = await mkdtemp(join(tmpdir(), "api-provider-safety-"));
    dirs.push(dir);
    const safety = new MutationSafety({ executors: [provider], auditPath: join(dir, "audit.jsonl"), writeEnabled: true });
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });

    expect(pageClient.postJson).toHaveBeenCalledTimes(1);
    expect(pageClient.postJson).toHaveBeenCalledWith("/page-4/messages", {
      recipient: { id: "peer-5" }, message: { text: "Approved test text" }
    });
    expect(result).toMatchObject({ status: "ACK", receiptId: "sent-9" });
  });

  it("reads a post-action Direct target only from the configured API account and exposes verified owner ids", async () => {
    const { ctx, pageClient } = makeContext(["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"]);
    pageClient.get.mockResolvedValue({ data: [{ id: "sent-9", from: { id: "page-4" }, message: "Exact reply", created_time: "2026-10-06T12:00:01.000Z" }] });
    const provider = createApiProvider({ resolveContext: async () => ctx });

    const evidence = await provider.readForAction({ operation: "conversation.read", target: { accountBinding: ctx.accountBinding, nativeId: "thread-2" }, limit: 20 });

    expect(pageClient.get).toHaveBeenCalledWith("/thread-2/messages", expect.objectContaining({ limit: 20 }));
    expect(evidence.ownerSenderIds).toEqual(["ig-17", "page-4"]);
    expect(evidence.observation).toMatchObject({ source: "api", accountBinding: ctx.accountBinding, nativeRef: "conversation:thread-2",
      data: { messages: [{ id: "sent-9", direction: "outbound", text: "Exact reply" }] } });
  });

  it("uses the existing unanswered classifiers only for explicit layered triage reads", async () => {
    const { ctx, pageClient } = makeContext(["instagram_basic", "instagram_manage_messages", "pages_manage_metadata", "instagram_manage_comments"]);
    pageClient.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/conversations")) return { data: [{ id: "thread-1" }] };
      if (path === "/thread-1/messages") return { data: [{ id: "m-1", from: { id: "peer-1" }, message: "Question", created_time: "2026-10-06T10:00:00Z" }] };
      if (path === "/media-1/comments") return { data: [{ id: "comment-1", text: "Question", timestamp: "2026-10-06T10:00:00Z", from: { id: "peer-1" }, replies_count: 0 }] };
      return { data: [] };
    });
    const provider = createApiProvider({ resolveContext: async () => ctx });

    const direct = await provider.read({ operation: "inbox.list", limit: 5, triage: true });
    const comments = await provider.read({ operation: "comments.list", target: { accountBinding: ctx.accountBinding, nativeId: "media-1" }, limit: 5, triage: true });
    const rawInbox = await provider.read({ operation: "inbox.list", limit: 5 });

    expect(direct.data).toMatchObject({ items: [{ conversationId: "thread-1", unanswered: true, unread: "unknown" }] });
    expect(direct.coverage).toBe("partial");
    expect(comments.data).toMatchObject({ items: [{ commentId: "comment-1", unanswered: true, unread: "unknown" }] });
    expect(rawInbox.data).toMatchObject({ items: [{ id: "thread-1", unanswered: "unknown" }] });
    expect(rawInbox.coverage).toBe("unknown");
  });

  it("asks a ready browser source to complement API comment triage with unknown author identity", async () => {
    const { ctx, pageClient } = makeContext(["instagram_manage_comments"]);
    pageClient.get.mockResolvedValue({ data: [{ id: "comment-no-author", timestamp: "2026-10-05T10:00:00Z", replies_count: 0 }] });
    const api = createApiProvider({ resolveContext: async () => ctx });
    const browser: SourceProvider = {
      source: "browser",
      status: async () => ({ source: "browser", availability: "ready", capabilities: ["comments.list"] }),
      read: vi.fn(async () => ({ source: "browser" as const, nativeRef: "comments:media-1", accountBinding: ctx.accountBinding,
        capturedAt: "2026-10-06T12:00:00Z", availability: "ready" as const, coverage: "complete" as const, historyCompleteness: "complete" as const,
        data: { comments: [{ id: "comment-no-author", unanswered: "unknown" }] }, errors: [] }))
    };
    const router = createSourceRouter({ providers: [api, browser] });

    const result = await router.read({ operation: "comments.list", target: { accountBinding: ctx.accountBinding, nativeId: "media-1" }, triage: true });

    expect(result.triedSources).toEqual(["api", "browser"]);
    expect(browser.read).toHaveBeenCalledOnce();
    expect(result.observations[0]).toMatchObject({ source: "api", coverage: "partial", data: { items: [{ unanswered: "unknown" }] } });
  });
});
