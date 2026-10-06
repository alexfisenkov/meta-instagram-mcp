import { describe, expect, it, vi } from "vitest";
import { createToolHandlers } from "../src/tools.js";

describe("legacy tool API-domain integration", () => {
  it("exposes API provider while preserving existing comment handlers and login scope choices", async () => {
    const pageClient = { get: vi.fn(), post: vi.fn(), postJson: vi.fn(), delete: vi.fn() };
    const loadToken = vi.fn().mockResolvedValue({ accessToken: "safe-fixture-token", authMode: "facebook", userId: "ig-1", pageId: "page-1" });
    const userClient = {
      get: vi.fn().mockResolvedValue({ data: [
        "instagram_basic", "pages_show_list", "instagram_manage_messages", "pages_manage_metadata", "instagram_manage_comments", "instagram_manage_insights"
      ].map((permission) => ({ permission, status: "granted" })) }),
      post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockResolvedValue({ client: pageClient, pageId: "page-1", instagramUserId: "ig-1", tasks: ["MESSAGING"] })
    };
    const handlers = createToolHandlers({
      config: { authMode: "facebook", appId: "123", redirectUri: "http://localhost:8787/callback", graphApiVersion: "v25.0", tokenStorePath: "/tmp/token.json", publishLogPath: "/tmp/publish-log.jsonl" },
      tokenStore: {
        load: loadToken,
        save: vi.fn()
      },
      clientFactory: () => userClient as never
    });

    expect(typeof handlers.listComments).toBe("function");
    expect(handlers.apiProvider.source).toBe("api");
    expect((await handlers.apiProvider.status()).capabilities).toContain("direct.read");
    expect(userClient.get).toHaveBeenCalledWith("/me/permissions");
    userClient.get.mockResolvedValueOnce({ data: [
      "pages_show_list", "instagram_manage_messages", "pages_manage_metadata", "instagram_manage_comments", "instagram_manage_insights"
    ].map((permission) => ({ permission, status: "granted" })) });
    const missingBasic = await handlers.apiProvider.status();
    expect(missingBasic.availability).toBe("missing_scope");
    expect(missingBasic.capabilities).toContain("direct.read:missing_scope");
    expect(missingBasic.capabilities).not.toContain("direct.read");

    userClient.get.mockResolvedValueOnce({ data: [{ permission: "instagram_basic" }] });
    const unverified = await handlers.apiProvider.status();
    expect(unverified.availability).toBe("permission_blocked");
    expect(unverified.capabilities).not.toContain("direct.read");
    expect(handlers.buildLoginUrl({ scopePreset: "inbox" }).scopes).toEqual([
      "instagram_basic", "pages_show_list", "pages_manage_metadata", "instagram_manage_messages"
    ]);
  });
});
