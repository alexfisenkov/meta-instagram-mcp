import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// oauth.ts ходит в сеть через requestJsonHttp напрямую (инъекции fetchImpl больше
// нет), поэтому подменяем транспорт — ни один тест не должен стучаться в Meta.
vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));

import { requestJsonHttp } from "../src/http-json.js";
import { exchangeCodeForLongLivedToken, refreshLongLivedToken } from "../src/oauth.js";
import { jsonHttpResponse, metaErrorResponse } from "./helpers/json-http.js";

const httpMock = vi.mocked(requestJsonHttp);
const NOW = "2026-05-23T00:00:00.000Z";

function calledUrl(call: number): string {
  return httpMock.mock.calls[call][0].href;
}

beforeEach(() => {
  httpMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("exchangeCodeForLongLivedToken", () => {
  it("exchanges an Instagram code server-side and returns the long-lived token", async () => {
    httpMock
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "short-token", user_id: "ig-user" }))
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "long-token", token_type: "bearer", expires_in: 5183944 }));

    const token = await exchangeCodeForLongLivedToken({
      authMode: "instagram",
      code: "code-123",
      appId: "123",
      appSecret: "secret",
      redirectUri: "http://localhost:8787/callback",
      graphApiVersion: "v25.0"
    });

    expect(token).toEqual({
      accessToken: "long-token",
      tokenType: "bearer",
      authMode: "instagram",
      expiresAt: "2026-07-21T23:59:04.000Z"
    });
    expect(calledUrl(0)).toBe("https://api.instagram.com/oauth/access_token");
    expect(httpMock.mock.calls[0][1]?.method).toBe("POST");
    expect(String(httpMock.mock.calls[0][1]?.body)).toContain("client_secret=secret");
    expect(calledUrl(1)).toContain("https://graph.instagram.com/access_token");
    expect(calledUrl(1)).toContain("grant_type=ig_exchange_token");
    expect(calledUrl(1)).toContain("access_token=short-token");
  });

  it("never puts the app secret in the query string of the Instagram code exchange", async () => {
    httpMock
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "short-token" }))
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "long-token" }));

    await exchangeCodeForLongLivedToken({
      authMode: "instagram",
      code: "code-123",
      appId: "123",
      appSecret: "secret",
      redirectUri: "http://localhost:8787/callback",
      graphApiVersion: "v25.0"
    });

    expect(calledUrl(0)).not.toContain("secret");
    expect(calledUrl(0)).not.toContain("code-123");
  });

  it("exchanges a Facebook code through the Graph oauth endpoint", async () => {
    httpMock
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "short-facebook-token", token_type: "bearer" }))
      .mockResolvedValueOnce(
        jsonHttpResponse({ access_token: "long-facebook-token", token_type: "bearer", expires_in: 5183944 })
      );

    const token = await exchangeCodeForLongLivedToken({
      authMode: "facebook",
      code: "code-123",
      appId: "123",
      appSecret: "secret",
      redirectUri: "http://localhost:8787/callback",
      graphApiVersion: "v25.0"
    });

    expect(token.accessToken).toBe("long-facebook-token");
    expect(token.authMode).toBe("facebook");
    expect(calledUrl(0)).toContain("https://graph.facebook.com/v25.0/oauth/access_token");
    expect(calledUrl(0)).toContain("code=code-123");
    expect(calledUrl(1)).toContain("grant_type=fb_exchange_token");
    expect(calledUrl(1)).toContain("fb_exchange_token=short-facebook-token");
  });

  it("fails loudly when Meta answers without an access_token", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ user_id: "ig-user" }));

    await expect(
      exchangeCodeForLongLivedToken({
        authMode: "instagram",
        code: "code-123",
        appId: "123",
        appSecret: "secret",
        redirectUri: "http://localhost:8787/callback",
        graphApiVersion: "v25.0"
      })
    ).rejects.toThrow("Instagram short-lived access_token was not returned by Meta.");
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the Meta OAuth error message", async () => {
    httpMock.mockResolvedValueOnce(metaErrorResponse("Invalid verification code format."));

    await expect(
      exchangeCodeForLongLivedToken({
        authMode: "instagram",
        code: "bad",
        appId: "123",
        appSecret: "secret",
        redirectUri: "http://localhost:8787/callback",
        graphApiVersion: "v25.0"
      })
    ).rejects.toThrow("Meta OAuth error: Invalid verification code format.");
  });
});

describe("refreshLongLivedToken", () => {
  it("refreshes an Instagram token and carries the account ids over", async () => {
    httpMock.mockResolvedValueOnce(
      jsonHttpResponse({ access_token: "new-long-token", token_type: "bearer", expires_in: 60 })
    );

    const token = await refreshLongLivedToken({
      authMode: "instagram",
      accessToken: "old-token",
      userId: "ig-user",
      pageId: "fb-page",
      graphApiVersion: "v25.0"
    });

    expect(token.accessToken).toBe("new-long-token");
    expect(token.expiresAt).toBe("2026-05-23T00:01:00.000Z");
    expect(token.userId).toBe("ig-user");
    expect(token.pageId).toBe("fb-page");
    expect(calledUrl(0)).toContain("https://graph.instagram.com/refresh_access_token");
    expect(calledUrl(0)).toContain("grant_type=ig_refresh_token");
  });

  it("refuses to refresh a Facebook token without app credentials and sends nothing", async () => {
    await expect(
      refreshLongLivedToken({ authMode: "facebook", accessToken: "old-token", graphApiVersion: "v25.0" })
    ).rejects.toThrow("META_INSTAGRAM_APP_ID and META_INSTAGRAM_APP_SECRET are required");
    expect(httpMock).not.toHaveBeenCalled();
  });
});
