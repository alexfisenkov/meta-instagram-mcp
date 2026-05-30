import { describe, expect, it, vi } from "vitest";
import { buildAuthUrl, exchangeCodeForLongLivedToken, refreshLongLivedToken } from "../src/oauth.js";

describe("oauth", () => {
  it("builds the official Instagram authorization URL with read-only scopes", () => {
    const url = buildAuthUrl({
      appId: "123",
      redirectUri: "http://localhost:8787/callback",
      scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      forceReauth: true,
    });

    expect(url.origin).toBe("https://www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_insights");
    expect(url.searchParams.get("force_reauth")).toBe("1");
  });

  it("builds the official Facebook Login URL for Instagram Graph API access", () => {
    const url = buildAuthUrl({
      authMode: "facebook",
      appId: "123",
      redirectUri: "http://localhost:8787/callback",
      scopes: ["instagram_basic", "pages_show_list"],
      forceReauth: true,
      graphApiVersion: "v25.0",
    });

    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v25.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("scope")).toBe("instagram_basic,pages_show_list");
    expect(url.searchParams.get("auth_type")).toBe("rerequest");
  });

  it("exchanges an authorization code for a long-lived token using server-side requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          access_token: "short-token",
          user_id: "ig-user",
          permissions: "instagram_business_basic,instagram_business_manage_insights",
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "long-token",
        token_type: "bearer",
        expires_in: 5183944,
      }), { status: 200 }));

    const token = await exchangeCodeForLongLivedToken({
      code: "code-123",
      appId: "123",
      appSecret: "secret",
      redirectUri: "http://localhost:8787/callback",
      fetchImpl: fetchMock,
      now: new Date("2026-05-23T00:00:00.000Z"),
    });

    expect(token.accessToken).toBe("long-token");
    expect(token.userId).toBe("ig-user");
    expect(token.expiresAt).toBe("2026-07-21T23:59:04.000Z");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.instagram.com/oauth/access_token");
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("client_secret=secret");
    expect(String(fetchMock.mock.calls[1][0])).toContain("https://graph.instagram.com/access_token");
    expect(String(fetchMock.mock.calls[1][0])).toContain("client_secret=secret");
  });

  it("exchanges a Facebook authorization code for a long-lived token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "short-facebook-token",
        token_type: "bearer",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "long-facebook-token",
        token_type: "bearer",
        expires_in: 5183944,
      }), { status: 200 }));

    const token = await exchangeCodeForLongLivedToken({
      authMode: "facebook",
      code: "code-123",
      appId: "123",
      appSecret: "secret",
      redirectUri: "http://localhost:8787/callback",
      graphApiVersion: "v25.0",
      fetchImpl: fetchMock,
      now: new Date("2026-05-23T00:00:00.000Z"),
    });

    expect(token.accessToken).toBe("long-facebook-token");
    expect(token.authMode).toBe("facebook");
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://graph.facebook.com/v25.0/oauth/access_token");
    expect(String(fetchMock.mock.calls[0][0])).toContain("code=code-123");
    expect(String(fetchMock.mock.calls[1][0])).toContain("grant_type=fb_exchange_token");
  });

  it("refreshes a long-lived token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "new-long-token",
      token_type: "bearer",
      expires_in: 60,
    }), { status: 200 }));

    const token = await refreshLongLivedToken({
      accessToken: "old-token",
      userId: "ig-user",
      fetchImpl: fetchMock,
      now: new Date("2026-05-23T00:00:00.000Z"),
    });

    expect(token.accessToken).toBe("new-long-token");
    expect(token.expiresAt).toBe("2026-05-23T00:01:00.000Z");
    expect(String(fetchMock.mock.calls[0][0])).toContain("grant_type=ig_refresh_token");
  });
});
