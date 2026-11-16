import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
import { requestJsonHttp } from "../src/http-json.js";
import { buildAuthUrl, defaultScopesForAuthMode, exchangeCodeForLongLivedToken, refreshLongLivedToken } from "../src/oauth.js";
import { verifyDirectInstagramToken, verifyOAuthAccountIdentity } from "../src/oauth-account-identity.js";
import { jsonHttpResponse } from "./helpers/json-http.js";

const http = vi.mocked(requestJsonHttp);
const config = { authMode: "instagram" as const, graphApiVersion: "v27.0" };
const exchangeOptions = { ...config, appId: "123", appSecret: "private-app-secret", redirectUri: "https://example.test/callback", code: "private-code" };
const grant = { access_token: "sample-short", user_id: "app-user", permissions: "instagram_business_basic,instagram_business_manage_comments" };
const long = { access_token: "sample-long", token_type: "bearer", expires_in: 5184000 };
afterEach(() => http.mockReset());

describe("direct Instagram Login compatibility", () => {
  it("starts with minimal basic permission and documented boolean URL controls", () => {
    expect(defaultScopesForAuthMode("instagram")).toEqual(["instagram_business_basic"]);
    const url = buildAuthUrl({ ...exchangeOptions, scopes: ["instagram_business_basic"], enableFacebookLogin: false, forceReauth: true });
    expect(url.searchParams.get("enable_fb_login")).toBe("false");
    expect(url.searchParams.get("force_reauth")).toBe("true");
  });
  it.each([grant, { data: [grant] }])("accepts one flat or wrapped grant and preserves actual CSV permissions", async (short) => {
    http.mockResolvedValueOnce(jsonHttpResponse(short)).mockResolvedValueOnce(jsonHttpResponse(long));
    await expect(exchangeCodeForLongLivedToken(exchangeOptions)).resolves.toMatchObject({ accessToken: "sample-long", userId: "app-user", permissions: ["instagram_business_basic", "instagram_business_manage_comments"] });
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("normalizes actual array grants and safe integer identity", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ data: [{ ...grant, user_id: 12345, permissions: ["instagram_business_basic"] }] })).mockResolvedValueOnce(jsonHttpResponse(long));
    await expect(exchangeCodeForLongLivedToken(exchangeOptions)).resolves.toMatchObject({ userId: "12345", permissions: ["instagram_business_basic"] });
  });
  it("does not invent grants when the provider omitted them", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ access_token: "short", user_id: "app-user" })).mockResolvedValueOnce(jsonHttpResponse(long));
    expect((await exchangeCodeForLongLivedToken(exchangeOptions)).permissions).toBeUndefined();
  });
  it.each([
    { ...grant, data: [grant] }, { data: [] }, { data: [grant, grant] }, { data: [null] },
    { data: [{ ...grant, user_id: Number.MAX_SAFE_INTEGER + 1 }] },
    { data: [{ ...grant, permissions: ["instagram_business_basic", "sample-private-token"] }] },
    { data: [{ ...grant, permissions: [] }] },
    { data: [{ ...grant, permissions: "instagram_business_manage_comments" }] },
  ])("rejects ambiguous/malformed grants before long token exchange %#", async (short) => {
    http.mockResolvedValueOnce(jsonHttpResponse(short));
    await expect(exchangeCodeForLongLivedToken(exchangeOptions)).rejects.toThrow(/INSTAGRAM_OAUTH_|OAUTH_IDENTITY_|OAUTH_PERMISSIONS_/);
    expect(http).toHaveBeenCalledOnce();
  });
  it("reports a fixed error instead of upstream payload/secret echoes", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ error: { message: "private-code private-app-secret" } }, 400));
    await expect(exchangeCodeForLongLivedToken(exchangeOptions)).rejects.toThrow("INSTAGRAM_OAUTH_EXCHANGE_FAILED");
  });
  it("does not expose upstream token or error text on refresh failure", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ error: { message: "private-code private-app-secret" } }, 400));
    await expect(refreshLongLivedToken({ ...config, accessToken: "sample-private-token" })).rejects.toThrow("INSTAGRAM_TOKEN_REFRESH_FAILED");
  });
});

describe("direct Dashboard token identity", () => {
  it.each([{ user_id: "ig-user", username: "creator" }, { data: [{ user_id: "ig-user", username: "creator" }] }])("resolves only professional user_id and leaves permissions unknown", async (profile) => {
    http.mockResolvedValueOnce(jsonHttpResponse(profile));
    await expect(verifyDirectInstagramToken(config, "dashboard-secret")).resolves.toEqual({ userId: "ig-user", username: "creator", permissionsVerification: "unknown" });
    const [url] = http.mock.calls[0]!;
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toBe("/v27.0/me");
    expect(url.searchParams.get("fields")).toBe("user_id,username");
  });
  it.each([
    { id: "app-user", username: "creator" }, { data: [] },
    { user_id: "ig-user", username: "creator", data: [{ user_id: "other", username: "creator" }] },
    { data: [{ user_id: "one", username: "one" }, { user_id: "two", username: "two" }] },
    { user_id: Number.MAX_SAFE_INTEGER + 1, username: "creator" },
  ])("rejects missing, mixed, ambiguous or unsafe identities %#", async (profile) => {
    http.mockResolvedValueOnce(jsonHttpResponse(profile));
    await expect(verifyDirectInstagramToken(config, "dashboard-secret")).rejects.toThrow("OAUTH_IDENTITY_UNVERIFIED");
  });
  it("checks the selected account and cancellation without printing raw errors", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ user_id: "other", username: "creator" }));
    await expect(verifyDirectInstagramToken(config, "dashboard-secret", { expectedAccountId: "ig-user" })).rejects.toThrow("OAUTH_IDENTITY_MISMATCH");
    const abort = new AbortController(); abort.abort(); http.mockClear();
    await expect(verifyDirectInstagramToken(config, "dashboard-secret", { signal: abort.signal })).rejects.toThrow("OAUTH_CANCELLED");
    expect(http).not.toHaveBeenCalled();
  });
  it("binds an OAuth app-scoped identity to the fresh professional user_id", async () => {
    const client = { get: vi.fn(async () => ({ id: "app-user", user_id: "ig-user", username: "creator" })), forFacebookPage: vi.fn() };
    await expect(verifyOAuthAccountIdentity(config, { accessToken: "fresh", authMode: "instagram", userId: "app-user", permissions: ["instagram_business_basic"] }, { expectedAccountId: "ig-user" }, () => client as never)).resolves.toMatchObject({ userId: "ig-user", oauthUserId: "app-user", username: "creator" });
    expect(client.get).toHaveBeenCalledOnce();
  });
  it("rejects an unproved OAuth identity even if a professional profile is readable", async () => {
    http.mockResolvedValueOnce(jsonHttpResponse({ id: "different-app-user", user_id: "ig-user", username: "creator" }));
    await expect(verifyDirectInstagramToken(config, "fresh", { expectedOAuthUserId: "unproved-app-user" })).rejects.toThrow("OAUTH_IDENTITY_MISMATCH");
  });
  it("hides raw profile failures and forwards cancellation", async () => {
    const controller = new AbortController();
    http.mockResolvedValueOnce(jsonHttpResponse({ error: { message: "PRIVATE-ERROR-TOKEN" } }, 400));
    await expect(verifyDirectInstagramToken(config, "fresh", { signal: controller.signal })).rejects.toThrow("OAUTH_IDENTITY_UNVERIFIED");
    expect(http.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });
});
