import { describe, expect, it, vi } from "vitest";
import { createToolHandlers } from "../src/tools.js";

describe("tool handlers", () => {
  it("builds login URLs with the analytics scope preset by default", () => {
    const handlers = createToolHandlers({
      config: {
        authMode: "instagram",
        appId: "123",
        appSecret: "secret",
        redirectUri: "http://localhost:8787/callback",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn(),
        save: vi.fn(),
      },
    });

    const result = handlers.buildLoginUrl();

    expect(result.scopes).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ]);
    expect(result.url).toContain("instagram_business_manage_comments");
  });

  it("ranks media locally by engagement", async () => {
    const handlers = createToolHandlers({
      config: {
        authMode: "instagram",
        accessToken: "env-token",
        userId: "ig-user",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn(),
        save: vi.fn(),
      },
      clientFactory: () => ({
        get: vi.fn().mockResolvedValue({
          data: [
            { id: "1", like_count: 2, comments_count: 1, timestamp: "2026-05-01T00:00:00+0000" },
            { id: "2", like_count: 5, comments_count: 4, timestamp: "2026-05-02T00:00:00+0000" },
          ],
        }),
      } as never),
    });

    const result = await handlers.getTopMedia();

    expect(result.data.map((item) => item.id)).toEqual(["2", "1"]);
    expect(result.data[0].engagement_score).toBe(9);
  });

  it("returns auth status with redacted token metadata", async () => {
    const handlers = createToolHandlers({
      config: {
        authMode: "instagram",
        appId: "123",
        appSecret: "secret",
        redirectUri: "http://localhost:8787/callback",
        accessToken: "env-token",
        userId: "ig-user",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn().mockResolvedValue({
          accessToken: "stored-token",
          tokenType: "bearer",
          userId: "stored-user",
          permissions: ["instagram_business_basic"],
          expiresAt: "2026-07-22T00:39:04.000Z",
        }),
        save: vi.fn(),
      },
    });

    const result = await handlers.authStatus();

    expect(result.config.hasAppId).toBe(true);
    expect(result.config.hasAppSecret).toBe(true);
    expect(result.config.defaultScopes).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ]);
    expect(result.envToken).toBe("env-...oken");
    expect(result.storedToken?.accessToken).toBe("stor...oken");
  });

  it("builds Facebook Login URLs when configured for Facebook auth mode", () => {
    const handlers = createToolHandlers({
      config: {
        authMode: "facebook",
        appId: "123",
        appSecret: "secret",
        redirectUri: "http://localhost:8787/callback",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn(),
        save: vi.fn(),
      },
    });

    const result = handlers.buildLoginUrl();

    expect(result.authMode).toBe("facebook");
    expect(result.url).toContain("https://www.facebook.com/v25.0/dialog/oauth");
    expect(result.scopes).toEqual([
      "instagram_basic",
      "pages_show_list",
      "pages_read_engagement",
      "instagram_manage_insights",
      "instagram_manage_comments",
    ]);
  });

  it("resolves and saves an Instagram Business account from Facebook Pages", async () => {
    const save = vi.fn();
    const get = vi.fn().mockResolvedValue({
      data: [{
        id: "page-1",
        name: "Page",
        instagram_business_account: {
          id: "ig-1",
          username: "creator",
        },
      }],
    });
    const handlers = createToolHandlers({
      config: {
        authMode: "facebook",
        accessToken: "env-token",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn(),
        save,
      },
      clientFactory: () => ({ get } as never),
    });

    const result = await handlers.resolveInstagramAccount();

    expect((result.instagramBusinessAccount as { id?: string }).id).toBe("ig-1");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "env-token",
      authMode: "facebook",
      userId: "ig-1",
      username: "creator",
      pageId: "page-1",
    }));
  });

  it("uses Facebook-safe account fields by default", async () => {
    const get = vi.fn().mockResolvedValue({ id: "ig-1", username: "creator" });
    const handlers = createToolHandlers({
      config: {
        authMode: "facebook",
        accessToken: "env-token",
        userId: "ig-1",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn(),
        save: vi.fn(),
      },
      clientFactory: () => ({ get } as never),
    });

    await handlers.getAccountInfo();

    expect(get).toHaveBeenCalledWith("/ig-1", expect.objectContaining({
      fields: expect.not.arrayContaining(["user_id", "account_type"]),
    }));
    expect(get).toHaveBeenCalledWith("/ig-1", expect.objectContaining({
      fields: expect.arrayContaining(["id", "username", "followers_count", "media_count"]),
    }));
  });

  it("uses a safe default account insight metric", async () => {
    const get = vi.fn().mockResolvedValue({ data: [] });
    const handlers = createToolHandlers({
      config: {
        authMode: "facebook",
        accessToken: "env-token",
        userId: "ig-1",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn(),
        save: vi.fn(),
      },
      clientFactory: () => ({ get } as never),
    });

    await handlers.getUserInsights();

    expect(get).toHaveBeenCalledWith("/ig-1/insights", expect.objectContaining({
      metric: "reach",
      period: "day",
    }));
  });

  it("resolves and saves a directly selected Instagram account id", async () => {
    const save = vi.fn();
    const get = vi.fn().mockResolvedValue({
      id: "ig-1",
      username: "creator",
      followers_count: 10,
      media_count: 2,
    });
    const handlers = createToolHandlers({
      config: {
        authMode: "facebook",
        accessToken: "env-token",
        graphApiVersion: "v25.0",
        tokenStorePath: "/tmp/token.json",
        publishLogPath: "/tmp/publish-log.jsonl",
      },
      tokenStore: {
        load: vi.fn(),
        save,
      },
      clientFactory: () => ({ get } as never),
    });

    const result = await handlers.resolveInstagramAccount({ userId: "ig-1" });

    expect(result.resolutionMode).toBe("direct_user_id");
    expect((result.instagramBusinessAccount as { username?: string }).username).toBe("creator");
    expect(get).toHaveBeenCalledWith("/ig-1", expect.objectContaining({
      fields: expect.arrayContaining(["id", "username", "followers_count", "media_count"]),
    }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "env-token",
      authMode: "facebook",
      userId: "ig-1",
      username: "creator",
    }));
  });
});
