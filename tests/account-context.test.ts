import { describe, expect, it, vi } from "vitest";
import { createAccountContextResolver } from "../src/account-context.js";
import type { MetaInstagramConfig } from "../src/config.js";

const config: MetaInstagramConfig = {
  authMode: "facebook", userId: "ig-account-7", pageId: "page-9",
  graphApiVersion: "v25.0", tokenStorePath: "/tmp/unused-token.json", publishLogPath: "/tmp/unused-log.jsonl"
};

describe("API account context", () => {
  it("binds Page token privately while exposing distinct Page and Instagram IDs and scope certainty", async () => {
    const pageClient = { get: vi.fn(), post: vi.fn(), postJson: vi.fn(), delete: vi.fn() };
    const userClient = {
      get: vi.fn(), post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockResolvedValue({
        client: pageClient, pageId: "page-9", instagramUserId: "ig-account-7", tasks: ["MESSAGING"]
      })
    };
    const resolve = createAccountContextResolver({
      config,
      tokenStore: { load: vi.fn().mockResolvedValue({
        accessToken: "user-secret", authMode: "facebook", userId: "ig-account-7", pageId: "page-9",
        permissions: ["instagram_manage_messages"]
      }) },
      clientFactory: () => userClient as never
    });

    const context = await resolve();
    expect(context).toMatchObject({
      authMode: "facebook", instagramUserId: "ig-account-7", facebookPageId: "page-9",
      confirmedScopes: ["instagram_manage_messages"], scopeStatus: "confirmed"
    });
    expect(context.pageClient).toBe(pageClient);
    expect(JSON.stringify(context)).not.toContain("user-secret");
    expect(JSON.stringify(context)).not.toContain("page-secret");
    expect(userClient.forFacebookPage).toHaveBeenCalledWith("page-9");
  });
});
