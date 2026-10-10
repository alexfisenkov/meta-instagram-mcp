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

  it("discovers actual Facebook permission grants when no verified OAuth grant was saved", async () => {
    const userClient = {
      get: vi.fn().mockResolvedValue({ data: [
        { permission: "instagram_manage_messages", status: "granted" },
        { permission: "instagram_manage_comments", status: "declined" }
      ] }),
      post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockResolvedValue({ client: {}, pageId: "page-9", instagramUserId: "ig-account-7", tasks: [] })
    };
    const resolve = createAccountContextResolver({
      config,
      tokenStore: { load: vi.fn().mockResolvedValue({ accessToken: "user-secret", authMode: "facebook", userId: "ig-account-7", pageId: "page-9" }) },
      clientFactory: () => userClient as never
    });

    const context = await resolve();

    expect(userClient.get).toHaveBeenCalledWith("/me/permissions");
    expect(context.confirmedScopes).toEqual(["instagram_manage_messages"]);
    expect(context.scopeStatus).toBe("confirmed");
  });

  it("passes an active read budget signal through Page and permission discovery", async () => {
    const signal = new AbortController().signal;
    const userClient = {
      get: vi.fn().mockResolvedValue({ data: [{ permission: "instagram_manage_messages", status: "granted" }] }),
      post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockResolvedValue({ client: {}, pageId: "page-9", instagramUserId: "ig-account-7", tasks: ["MESSAGING"] })
    };
    const resolve = createAccountContextResolver({
      config,
      tokenStore: { load: vi.fn().mockResolvedValue({ accessToken: "user-secret", authMode: "facebook", userId: "ig-account-7", pageId: "page-9" }) },
      clientFactory: () => userClient as never
    });

    await resolve({ signal });

    expect(userClient.forFacebookPage).toHaveBeenCalledWith("page-9", { signal });
    expect(userClient.get).toHaveBeenCalledWith("/me/permissions", {}, { signal });
  });

  it("keeps fresh user grants when an optional saved Page is no longer resolvable", async () => {
    const userClient = {
      get: vi.fn().mockResolvedValue({ data: [
        { permission: "instagram_manage_insights", status: "granted" },
        { permission: "instagram_manage_comments", status: "granted" },
        { permission: "instagram_manage_messages", status: "declined" }
      ] }),
      post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockRejectedValue(new Error("The requested Facebook Page was not found in the available Pages."))
    };
    const resolve = createAccountContextResolver({
      config,
      tokenStore: { load: vi.fn().mockResolvedValue({ accessToken: "user-secret", authMode: "facebook", userId: "ig-account-7", pageId: "page-9" }) },
      clientFactory: () => userClient as never
    });

    const context = await resolve();

    expect(context).toMatchObject({
      accountBinding: "instagram:ig-account-7", instagramUserId: "ig-account-7",
      confirmedScopes: ["instagram_manage_insights", "instagram_manage_comments"],
      scopeStatus: "confirmed", pageResolutionStatus: "unavailable"
    });
    expect(context.facebookPageId).toBeUndefined();
    expect(context.pageClient).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("user-secret");
    expect(userClient.get).toHaveBeenCalledWith("/me/permissions");
  });

  it("does not soften an expired-token or account-mismatch Page lookup failure", async () => {
    const expiredClient = {
      get: vi.fn(), post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockRejectedValue(new Error("OAuth access token has expired."))
    };
    const expiredResolver = createAccountContextResolver({
      config, tokenStore: { load: vi.fn().mockResolvedValue({ accessToken: "user-secret", authMode: "facebook", userId: "ig-account-7", pageId: "page-9" }) },
      clientFactory: () => expiredClient as never
    });
    await expect(expiredResolver()).rejects.toThrow(/expired/i);
    expect(expiredClient.get).not.toHaveBeenCalled();

    const mismatchClient = {
      get: vi.fn(), post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockResolvedValue({ client: {}, pageId: "page-9", instagramUserId: "different-ig", tasks: [] })
    };
    const mismatchResolver = createAccountContextResolver({
      config, tokenStore: { load: vi.fn().mockResolvedValue({ accessToken: "user-secret", authMode: "facebook", userId: "ig-account-7", pageId: "page-9" }) },
      clientFactory: () => mismatchClient as never
    });
    await expect(mismatchResolver()).rejects.toThrow(/different Instagram account/i);
    expect(mismatchClient.get).not.toHaveBeenCalled();
  });

  it("keeps grant status unknown when Facebook permission discovery fails", async () => {
    const userClient = {
      get: vi.fn().mockRejectedValue(new Error("offline")),
      post: vi.fn(), postJson: vi.fn(), delete: vi.fn(),
      forFacebookPage: vi.fn().mockResolvedValue({ client: {}, pageId: "page-9", instagramUserId: "ig-account-7", tasks: [] })
    };
    const resolve = createAccountContextResolver({
      config,
      tokenStore: { load: vi.fn().mockResolvedValue({ accessToken: "user-secret", authMode: "facebook", userId: "ig-account-7", pageId: "page-9" }) },
      clientFactory: () => userClient as never
    });

    const context = await resolve();

    expect(context.confirmedScopes).toBeUndefined();
    expect(context.scopeStatus).toBe("unknown");
  });
});
