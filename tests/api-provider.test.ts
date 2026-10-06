import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationSafety } from "../src/action-safety.js";
import { createApiProvider } from "../src/api-provider.js";
import type { ApiAccountContext } from "../src/account-context.js";

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
});
