import { expect, it, vi } from "vitest";
import { MetaStudentProvider, requestMeta } from "../src/student/meta-provider.js";
import { authorizationUrl, StudentRegistry } from "../src/student/registry.js";
import { BrokerError, type Connection, type ProductConfig } from "../src/student/types.js";
const config: ProductConfig = { product: "instagram", key: "ig", provider: "instagram_unified", appId: "123", appSecret: "app-secret", configId: "456", apiVersion: "v27.0", callbackUrl: "https://broker.example/student/oauth/callback", admission: "live", testSubjects: [] };
const instagramLoginConfig: ProductConfig = { ...config, provider: "instagram_login", configId: undefined };
const youtubeConfig = { ...config, product: "youtube", key: "youtube", provider: "youtube", appId: "123-client.apps.googleusercontent.com", appSecret: "google-app-secret", apiVersion: "v3", callbackUrl: "https://broker.example/youtube/oauth/callback", configId: undefined } as any;
const connection: Connection = { id: "connection", tenantId: "masterskaya", sub: "student", grantId: "grant", product: "instagram", providerId: "100", label: "my-account", capabilities: ["account", "posts", "comments"], status: "connected", updatedAt: "now" };
it("registers YouTube with separate Google OAuth credentials and builds read-only Google authorization", () => {
  expect(new StudentRegistry([youtubeConfig]).get("youtube")?.provider).toBe("youtube");
  const auth = new URL(authorizationUrl(youtubeConfig, "google-state", "A".repeat(43)));
  expect(auth.origin + auth.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(auth.searchParams.get("response_type")).toBe("code");
  expect(auth.searchParams.get("redirect_uri")).toBe(youtubeConfig.callbackUrl);
  expect(auth.searchParams.get("state")).toBe("google-state");
  expect(auth.searchParams.get("access_type")).toBe("offline");
  expect(auth.searchParams.get("scope")?.split(" ").sort()).toEqual(["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"].sort());
  expect(auth.searchParams.get("scope")).not.toContain("youtube.upload");
  expect(auth.searchParams.has("client_secret")).toBe(false);
});
it("exchanges a state-bound Google code, verifies the OIDC subject and discovers only owned YouTube channels", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const provider = new MetaStudentProvider(async (url, init) => {
    calls.push({ url, init });
    if (url.origin === "https://oauth2.googleapis.com") return { access_token: "google-access", refresh_token: "google-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid profile https://www.googleapis.com/auth/youtube.readonly" };
    if (url.origin === "https://openidconnect.googleapis.com") return { sub: "google-subject" };
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/youtube/v3/channels") return { items: [{ id: "UC-own", snippet: { title: "My channel", customUrl: "@my-channel" } }] };
    throw new Error("unexpected Google request");
  });
  const grant = await provider.exchange(youtubeConfig, "google-code", "V".repeat(43));
  expect(grant).toMatchObject({ accessToken: "google-access", refreshToken: "google-refresh", providerUserId: "google-subject", scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], assets: [{ product: "youtube", providerId: "UC-own", label: "My channel", capabilities: ["account"] }] });
  expect(calls[0].url.href).toBe("https://oauth2.googleapis.com/token");
  const exchangeBody = calls[0].init?.body as URLSearchParams;
  expect(exchangeBody.get("grant_type")).toBe("authorization_code");
  expect(exchangeBody.get("code_verifier")).toBe("V".repeat(43));
  expect(exchangeBody.get("redirect_uri")).toBe(youtubeConfig.callbackUrl);
  expect(calls[1].url.origin + calls[1].url.pathname).toBe("https://openidconnect.googleapis.com/v1/userinfo");
  expect(calls[2].url.searchParams.get("mine")).toBe("true");
});
it("refuses YouTube consent without the exact read-only YouTube scope", async () => {
  const calls: URL[] = [];
  const provider = new MetaStudentProvider(async (url) => { calls.push(url); return { access_token: "google-access", refresh_token: "google-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid profile" }; });
  await expect(provider.exchange(youtubeConfig, "google-code", "V".repeat(43))).rejects.toThrow("permission_unavailable");
  expect(calls).toHaveLength(1);
});
it("distinguishes a missing Google refresh token so the previous grant is not replaced", async () => {
  const provider = new MetaStudentProvider(async () => ({ access_token: "google-access-fixture", token_type: "Bearer", expires_in: 3600, scope: "openid profile https://www.googleapis.com/auth/youtube.readonly" }));
  await expect(provider.exchange(youtubeConfig, "google-code", "V".repeat(43))).rejects.toMatchObject({ code: "youtube_refresh_token_missing" });
});
it("reads only the selected owned YouTube channel account", async () => {
  const calls: URL[] = [];
  const provider = new MetaStudentProvider(async (url) => { calls.push(url); return { items: [{ id: "UC-own", snippet: { title: "My channel", customUrl: "@my-channel" }, statistics: { viewCount: "500", subscriberCount: "0", hiddenSubscriberCount: false, videoCount: "12" } }] }; });
  const result = await provider.read(youtubeConfig, { ...connection, product: "youtube", providerId: "UC-own", capabilities: ["account"] }, { accessToken: "google-access", refreshToken: "google-refresh", assetTokens: {} }, { connectionId: "connection", operation: "account" });
  expect(calls).toHaveLength(1);
  expect(calls[0].origin + calls[0].pathname).toBe("https://www.googleapis.com/youtube/v3/channels");
  expect(calls[0].searchParams.get("mine")).toBe("true");
  expect(calls[0].searchParams.has("id")).toBe(false);
  expect(result.data).toEqual({ id: "UC-own", title: "My channel", customUrl: "@my-channel", viewCount: "500", subscriberCount: "0", subscriberCountHidden: false, videoCount: "12" });
});
it("refreshes a YouTube grant only with its own Google refresh token and verifies the same subject and scope", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const provider = new MetaStudentProvider(async (url, init) => {
    calls.push({ url, init });
    if (url.origin === "https://oauth2.googleapis.com") return { access_token: "new-access", token_type: "Bearer", expires_in: 3600 };
    if (url.origin === "https://openidconnect.googleapis.com") return { sub: "google-subject" };
    return { items: [{ id: "UC-own", snippet: { title: "My channel" } }] };
  });
  const refreshed = await provider.refresh!(youtubeConfig, { accessToken: "old-access", refreshToken: "google-refresh", assetTokens: {} }, "google-subject", ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"]);
  expect(refreshed).toMatchObject({ accessToken: "new-access", refreshToken: "google-refresh", scopes: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"] });
  expect((calls[0].init?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
  expect((calls[0].init?.body as URLSearchParams).get("refresh_token")).toBe("google-refresh");
  expect(calls[1].url.pathname).toBe("/v1/userinfo");
  expect(calls[2].url.searchParams.get("mine")).toBe("true");
});
it("keeps the canonical direct Instagram URL compatible with the existing platform during rollout", () => {
  const direct = new URL(authorizationUrl(instagramLoginConfig, "state"));
  expect([...direct.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "response_type", "scope", "state"]);
  expect(direct.searchParams.has("force_reauth")).toBe(false);
  expect(direct.searchParams.has("force_authentication")).toBe(false);
  expect(direct.searchParams.has("enable_fb_login")).toBe(false);
  for (const other of [config, { ...config, product: "facebook" as const, provider: "facebook_business" as const }, { ...config, product: "threads" as const, provider: "threads" as const }]) {
    expect(new URL(authorizationUrl(other, "state")).searchParams.has("force_reauth")).toBe(false);
  }
});
it("preserves an unquoted Instagram identity beyond JS integer precision through the HTTP exchange", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response('{"access_token":"short-token","user_id":17841400000000001,"permissions":"instagram_business_basic"}'))
    .mockResolvedValueOnce(new Response('{"access_token":"long-token","token_type":"bearer","expires_in":5184000}'))
    .mockResolvedValueOnce(new Response('{"user_id":"17841400000000001","username":"owner"}'));
  try {
    const grant = await new MetaStudentProvider().exchange(instagramLoginConfig, "synthetic-code");
    expect(grant.providerUserId).toBe("17841400000000001");
    expect(grant.assets[0].providerId).toBe("17841400000000001");
  } finally { fetchMock.mockRestore(); }
});
it("binds a single wrapped Instagram profile to its verified app identity and projects only resource fields", async () => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.hostname === "api.instagram.com") return { data: [{ access_token: "short-token", user_id: "app-user", permissions: "instagram_business_basic" }] };
    if (url.pathname === "/access_token") return { access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 };
    expect(url.searchParams.get("fields")).toBe("id,user_id,username");
    return { data: [{ id: "app-user", user_id: "100", username: "owner", access_token: "PRIVATE-profile-token", nested: { secret: "PRIVATE-payload" } }] };
  });
  const grant = await provider.exchange(instagramLoginConfig, "code");
  expect(grant.providerUserId).toBe("app-user");
  expect(grant.assets).toEqual([{ product: "instagram", providerId: "100", label: "owner", capabilities: ["account", "posts"] }]);
  expect(grant.scopes).toEqual(["instagram_business_basic"]);
  const reader = new MetaStudentProvider(async () => ({ data: [{ user_id: "100", username: "owner", access_token: "PRIVATE-profile-token", nested: { secret: "PRIVATE-payload" } }] }));
  const result = await reader.read(instagramLoginConfig, connection, { accessToken: grant.accessToken, assetTokens: {} }, { connectionId: connection.id, operation: "account" });
  expect(result.data).toEqual({ user_id: "100", username: "owner" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
it("accepts bounded actual Instagram permission arrays without inventing requested capabilities", async () => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.hostname === "api.instagram.com") return { data: [{ access_token: "short-token", user_id: "100", permissions: ["instagram_business_basic", "instagram_business_manage_comments", "instagram_business_basic"] }] };
    if (url.pathname === "/access_token") return { access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 };
    return { user_id: "100", username: "owner" };
  });
  const grant = await provider.exchange(instagramLoginConfig, "code");
  expect(grant.scopes).toEqual(["instagram_business_basic", "instagram_business_manage_comments"]);
  expect(grant.assets[0].capabilities).toEqual(["account", "posts", "comments"]);
});
it.each([
  { name: "missing", profile: { username: "owner" }, reason: "instagram_profile_identity_missing" },
  { name: "unsafe number", profile: { user_id: 17_841_400_000_000_001 }, reason: "instagram_profile_identity_invalid" },
  { name: "null", profile: { user_id: null }, reason: "instagram_profile_identity_invalid" },
  { name: "empty wrapper", profile: { data: [] }, reason: "instagram_profile_response_invalid" },
  { name: "multiple", profile: { data: [{ user_id: "100" }, { user_id: "100" }] }, reason: "instagram_profile_response_invalid" },
  { name: "mixed", profile: { user_id: "100", data: [{ user_id: "100" }] }, reason: "instagram_profile_response_invalid" },
  { name: "mismatch", profile: { id: "different-app", user_id: "different-resource" }, reason: "grant_verification_failed" },
])("rejects $name Instagram profile proof with a fixed identity stage in exchange and read", async ({ profile, reason }) => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.hostname === "api.instagram.com") return { access_token: "short-token", user_id: "100", permissions: "instagram_business_basic" };
    if (url.pathname === "/access_token") return { access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 };
    return profile;
  });
  await expect(provider.exchange(instagramLoginConfig, "code")).rejects.toMatchObject({ code: reason, diagnostic: { stage: "account_identity" } });
  await expect(provider.read(instagramLoginConfig, connection, { accessToken: "token", assetTokens: {} }, { connectionId: connection.id, operation: "account" })).rejects.toMatchObject({ code: reason, diagnostic: { stage: "account_identity" } });
});
it.each([
  { grant: { permissions: "instagram_business_basic" }, reason: "instagram_short_identity_missing" },
  { grant: { user_id: null, permissions: "instagram_business_basic" }, reason: "instagram_short_identity_invalid" },
  { grant: { user_id: 17_841_400_000_000_001, permissions: "instagram_business_basic" }, reason: "instagram_short_identity_invalid" },
  { grant: { user_id: "100", permissions: [] }, reason: "instagram_permissions_invalid" },
  { grant: { user_id: "100", permissions: ["instagram_business_basic", 12] }, reason: "instagram_permissions_invalid" },
  { grant: { user_id: "100", permissions: Array(33).fill("instagram_business_basic") }, reason: "instagram_permissions_invalid" },
  { grant: { user_id: "100", permissions: ["instagram_business_basic", "unknown_scope"] }, reason: "instagram_permissions_unexpected" },
  { grant: { user_id: "100", permissions: ["instagram_business_manage_comments"] }, reason: "permission_unavailable" },
])("rejects malformed short Instagram identity or permissions without another request: $reason", async ({ grant, reason }) => {
  let calls = 0;
  const provider = new MetaStudentProvider(async () => { calls++; return { access_token: "PRIVATE-short-token", ...grant }; });
  await expect(provider.exchange(instagramLoginConfig, "PRIVATE-code")).rejects.toMatchObject({ code: reason, diagnostic: { stage: "token_exchange" } });
  expect(calls).toBe(1);
});
it("fails closed on unsafe numeric Instagram IDs when a JSON runtime supplies no source context", async () => {
  const nativeParse = JSON.parse;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"access_token":"short-token","user_id":17841400000000001,"permissions":"instagram_business_basic"}'));
  const parseMock = vi.spyOn(JSON, "parse").mockImplementation((input: string, reviver?: (key: string, value: any) => any) => nativeParse(input, reviver ? function (key, value) { return reviver.call(this, key, value); } : undefined));
  try {
    await expect(new MetaStudentProvider().exchange(instagramLoginConfig, "code")).rejects.toMatchObject({ code: "instagram_short_identity_invalid", diagnostic: { stage: "token_exchange" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { parseMock.mockRestore(); fetchMock.mockRestore(); }
});
it.each(["wrapped", "flat"])("exchanges an Instagram Login grant using explicit permissions and identity (%s)", async (shape) => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const provider = new MetaStudentProvider(async (url, init) => {
    calls.push({ url, init });
    if (url.hostname === "api.instagram.com") {
      const grant = { access_token: "short-token", user_id: "ig-user", permissions: "instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_content_publish" };
      return shape === "wrapped" ? { data: [grant] } : grant;
    }
    if (url.pathname === "/access_token") return { access_token: "long-token", token_type: "Bearer", expires_in: 5_184_000 };
    if (url.pathname === "/v27.0/me") return { user_id: "ig-user", username: "owner" };
    throw new Error("unexpected direct Instagram request");
  });
  const grant = await provider.exchange(instagramLoginConfig, "authorization-code");
  expect(grant).toMatchObject({ accessToken: "long-token", providerUserId: "ig-user", scopes: ["instagram_business_basic", "instagram_business_manage_insights", "instagram_business_manage_comments", "instagram_business_manage_messages", "instagram_business_content_publish"], assets: [{ product: "instagram", providerId: "ig-user", label: "owner", capabilities: ["account", "posts", "metrics", "comments", "inbox"] }] });
  expect(calls[0].url.href).toBe("https://api.instagram.com/oauth/access_token");
  expect(calls[0].init?.method).toBe("POST");
  const form = calls[0].init?.body as FormData;
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("redirect_uri")).toBe("https://broker.example/student/oauth/callback");
  expect(form.get("client_id")).toBe("123");
  expect(form.get("client_secret")).toBe("app-secret");
  expect(calls[1].url.origin + calls[1].url.pathname).toBe("https://graph.instagram.com/access_token");
  expect(calls[1].url.searchParams.get("grant_type")).toBe("ig_exchange_token");
  expect(calls[1].url.searchParams.get("access_token")).toBe("short-token");
  expect(calls[2].url.origin + calls[2].url.pathname).toBe("https://graph.instagram.com/v27.0/me");
  expect(calls[2].url.searchParams.get("fields")).toBe("id,user_id,username");
});
it("registers direct Instagram Login only for Instagram and creates the Instagram-hosted auth URL", () => {
  expect(new StudentRegistry([instagramLoginConfig]).get("instagram")?.provider).toBe("instagram_login");
  expect(() => new StudentRegistry([{ ...instagramLoginConfig, product: "facebook" }])).toThrow("invalid_provider_config");
  const auth = new URL(authorizationUrl(instagramLoginConfig, "state"));
  expect(auth.origin + auth.pathname).toBe("https://www.instagram.com/oauth/authorize");
  expect(auth.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_content_publish,instagram_business_manage_insights");
});
it.each([
  ["ambiguous", "instagram_short_response_invalid"],
  ["permissions_missing", "instagram_permissions_invalid"],
  ["permissions_unknown", "instagram_permissions_unexpected"],
  ["long_token_missing", "instagram_long_response_invalid"],
  ["long_type_wrong", "instagram_token_type_invalid"],
  ["long_expiry_wrong", "instagram_token_expiry_invalid"],
] as const)("rejects incomplete Instagram grants with a fixed safe diagnostic (%s)", async (scenario, reason) => {
  let identityCalls = 0;
  const provider = new MetaStudentProvider(async (url) => {
    if (url.hostname === "api.instagram.com") {
      const grant = { access_token: "PRIVATE-short-token", user_id: "ig-user", permissions: "instagram_business_basic" };
      if (scenario === "ambiguous") return { ...grant, data: [{ ...grant, access_token: "PRIVATE-other-token" }] };
      if (scenario === "permissions_missing") return { data: [{ access_token: grant.access_token, user_id: grant.user_id }] };
      if (scenario === "permissions_unknown") return { data: [{ ...grant, permissions: "instagram_business_basic,unknown_scope" }] };
      return { data: [grant] };
    }
    if (url.pathname === "/access_token") return {
      access_token: scenario === "long_token_missing" ? "" : "PRIVATE-long-token",
      token_type: scenario === "long_type_wrong" ? "mac" : "bearer",
      expires_in: scenario === "long_expiry_wrong" ? 0 : 5_184_000,
    };
    identityCalls++;
    throw new Error("identity request must not happen for an invalid grant");
  });
  await expect(provider.exchange(instagramLoginConfig, "PRIVATE-code")).rejects.toMatchObject({ code: reason, diagnostic: { stage: "token_exchange" } });
  expect(identityCalls).toBe(0);
});
it("rejects an Instagram Login identity mismatch and ungranted base scope", async () => {
  const make = (userId: string, permissions: string) => new MetaStudentProvider(async (url) => {
    if (url.hostname === "api.instagram.com") return { data: [{ access_token: "short-token", user_id: "ig-user", permissions }] };
    if (url.pathname.endsWith("/access_token")) return { access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 };
    return { user_id: userId, username: "owner" };
  });
  await expect(make("different-user", "instagram_business_basic").exchange(instagramLoginConfig, "code")).rejects.toThrow("grant_verification_failed");
  await expect(make("ig-user", "instagram_business_manage_comments").exchange(instagramLoginConfig, "code")).rejects.toThrow("permission_unavailable");
});
it("reads direct Instagram account identity from the documented user_id field on graph.instagram.com", async () => {
  let called: URL | undefined;
  const provider = new MetaStudentProvider(async (url) => { called = url; return { user_id: "100", username: "owner" }; });
  const result = await provider.read(instagramLoginConfig, connection, { accessToken: "token", assetTokens: {} }, { connectionId: "connection", operation: "account" });
  expect(called).toBeDefined();
  expect(called!.origin + called!.pathname).toBe("https://graph.instagram.com/v27.0/me");
  expect(called!.searchParams.get("fields")).toBe("user_id,username");
  expect(result.data).toEqual({ user_id: "100", username: "owner" });
});
it("allows only the fixed official Instagram Login token and Graph API hosts", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    await expect(requestMeta(new URL("https://api.instagram.com/oauth/access_token"), { method: "POST" })).resolves.toEqual({ ok: true });
    await expect(requestMeta(new URL("https://graph.instagram.com/v27.0/me"))).resolves.toEqual({ ok: true });
    await expect(requestMeta(new URL("https://instagram.com/oauth/authorize"))).rejects.toThrow("provider_host_rejected");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { fetchMock.mockRestore(); }
});
it("allows only fixed Google token, userinfo, and YouTube API hosts; authorization stays browser-only", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    await expect(requestMeta(new URL("https://oauth2.googleapis.com/token"), { method: "POST" })).resolves.toEqual({ ok: true });
    await expect(requestMeta(new URL("https://openidconnect.googleapis.com/v1/userinfo"))).resolves.toEqual({ ok: true });
    await expect(requestMeta(new URL("https://www.googleapis.com/youtube/v3/channels?mine=true"))).resolves.toEqual({ ok: true });
    await expect(requestMeta(new URL("https://accounts.google.com/o/oauth2/v2/auth"))).rejects.toThrow("provider_host_rejected");
    await expect(requestMeta(new URL("https://youtube.googleapis.com/youtube/v3/channels"))).rejects.toThrow("provider_host_rejected");
    await expect(requestMeta(new URL("https://www.googleapis.com/drive/v3/files"))).rejects.toThrow("provider_host_rejected");
    await expect(requestMeta(new URL("https://oauth2.googleapis.com/tokeninfo"))).rejects.toThrow("provider_host_rejected");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally { fetchMock.mockRestore(); }
});
it("maps Google invalid_grant to reauth_required without retaining the response description", async () => {
  const marker = "PRIVATE-GOOGLE-ERROR-DESCRIPTION";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant", error_description: marker }), { status: 400 }));
  try {
    let thrown: unknown;
    try { await requestMeta(new URL("https://oauth2.googleapis.com/token"), { method: "POST", body: new URLSearchParams({ code: "private-code" }) }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect(thrown).toMatchObject({ code: "reauth_required", diagnostic: { stage: "token_exchange", status: 400 } });
    expect(JSON.stringify(thrown)).not.toContain(marker);
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally { fetchMock.mockRestore(); }
});
it("Unified URL pins config_id and exchanges once directly for BISU, discovers all assigned IGs", async () => {
  const auth = new URL(authorizationUrl(config, "state")); expect(auth.origin + auth.pathname).toBe("https://www.facebook.com/dialog/oauth"); expect(auth.searchParams.get("config_id")).toBe("456"); expect(auth.searchParams.has("scope")).toBe(false);
  const seen: URL[] = [];
  const provider = new MetaStudentProvider(async (url) => {
    seen.push(url);
    if (url.pathname === "/v27.0/oauth/access_token") return { access_token: "bisu-token", token_type: "bearer" };
    if (url.pathname === "/v27.0/debug_token") return { data: { app_id: "123", is_valid: true, user_id: "bisu-user", type: "SYSTEM_USER", scopes: ["instagram_basic"], expires_at: 0, data_access_expires_at: 0 } };
    if (url.pathname === "/v27.0/me") return { id: "bisu-user", client_business_id: "business" };
    if (url.pathname === "/v27.0/me/assigned_instagram_accounts") return { data: [{ id: "100", username: "one" }, { id: "101", username: "two" }] };
    throw new Error("unexpected request " + url.pathname);
  });
  const result = await provider.exchange(config, "code"); expect(result.assets.map((a) => a.providerId)).toEqual(["100", "101"]); expect(result.clientBusinessId).toBe("business");
  const tokenExchange = seen.find((url) => url.pathname === "/v27.0/oauth/access_token");
  expect(tokenExchange?.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
  expect(tokenExchange?.searchParams.get("redirect_uri")).toBe(auth.searchParams.get("redirect_uri"));
  expect(seen.some((url) => url.toString().includes("fb_exchange_token") || url.pathname.endsWith("/accounts"))).toBe(false);
});
it("adds Meta's unified-login response-type override only to instagram_unified", () => {
  const unified = new URL(authorizationUrl(config, "state"));
  expect(unified.searchParams.get("override_default_response_type")).toBe("true");
  const facebook = new URL(authorizationUrl({ ...config, product: "facebook", provider: "facebook_business" }, "state"));
  expect(facebook.searchParams.has("override_default_response_type")).toBe(false);
  const threads = new URL(authorizationUrl({ ...config, product: "threads", provider: "threads", apiVersion: "v1.0" }, "state"));
  expect(threads.searchParams.has("override_default_response_type")).toBe(false);
});
it("preserves only numeric Meta error metadata and a fixed endpoint stage", async () => {
  const marker = "RAW-META-BODY-MARKER-token-code-state-secret";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: marker, code: 190, error_subcode: 1234567, fbtrace_id: marker, type: marker } }), { status: 400 }));
  try {
    let thrown: unknown;
    try { await requestMeta(new URL("https://graph.facebook.com/v27.0/oauth/access_token?code=private-code")); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(BrokerError);
    const error = thrown as BrokerError;
    expect(error.diagnostic).toEqual({ stage: "token_exchange", status: 400, metaCode: 190, metaSubcode: 1234567 });
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally { fetchMock.mockRestore(); }
});
it.each([
  { name: "bad inspection proof", expected: "token_inspection", debug: { app_id: "123", is_valid: true, user_id: "user", type: "USER", scopes: ["instagram_basic"] }, me: { id: "user", client_business_id: "business" }, assets: [{ id: "asset", username: "one" }] },
  { name: "missing identity field", expected: "account_identity", debug: { app_id: "123", is_valid: true, user_id: "user", type: "SYSTEM_USER", scopes: ["instagram_basic"] }, me: { id: "user" }, assets: [{ id: "asset", username: "one" }] },
  { name: "empty asset discovery", expected: "asset_discovery", debug: { app_id: "123", is_valid: true, user_id: "user", type: "SYSTEM_USER", scopes: ["instagram_basic"] }, me: { id: "user", client_business_id: "business" }, assets: [] },
])("attaches the last fixed endpoint stage to local exchange failure: $name", async ({ expected, debug, me, assets }) => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.pathname.endsWith("/oauth/access_token")) return { access_token: "token" };
    if (url.pathname.endsWith("/debug_token")) return { data: debug };
    if (url.pathname.endsWith("/assigned_instagram_accounts")) return { data: assets };
    if (url.pathname.endsWith("/me")) return me;
    throw new Error("unexpected fixed endpoint");
  });
  await expect(provider.exchange(config, "code")).rejects.toMatchObject({ diagnostic: { stage: expected } });
});
it("declined optional grants do not become capabilities", async () => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.pathname.endsWith("oauth/access_token")) return { access_token: "token" };
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", user_id: "user", scopes: ["instagram_basic"] } };
    if (url.pathname.endsWith("assigned_instagram_accounts")) return { data: [{ id: "100", username: "one" }] };
    return { id: "user", client_business_id: "business" };
  });
  expect((await provider.exchange(config, "code")).assets[0].capabilities).toEqual(["account", "posts"]);
});
it.each(["facebook", "messenger"] as const)("discovers %s Pages with their own tokens and verified optional permissions", async (product) => {
  const c = { ...config, product, provider: "facebook_business" as const };
  const provider = new MetaStudentProvider(async (url, init) => {
    if (url.pathname.endsWith("oauth/access_token")) return { access_token: "user-token" };
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "USER", user_id: "user", scopes: ["pages_read_engagement", "pages_messaging", "pages_manage_metadata"] } };
    if (url.pathname === "/v27.0/me") return { id: (init?.headers as Record<string, string>)?.Authorization === "Bearer page-token" ? "page" : "user" };
    if (url.pathname.endsWith("/me/accounts")) return { data: [{ id: "page", name: "Page", access_token: "page-token", tasks: ["MESSAGING"] }] };
    if (url.pathname === "/v27.0/page") {
      if (url.searchParams.get("fields") === "id,name,access_token") { expect(product).toBe("messenger"); expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer user-token"); return { id: "page", name: "Page", access_token: "page-token" }; }
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer page-token"); return { id: "page", name: "Page" };
    }
    throw new Error("unexpected " + url.pathname);
  });
  const result = await provider.exchange(c, "code"); expect(result.assetTokens.page).toBe("page-token"); expect(result.assets[0].capabilities).toEqual(product === "facebook" ? ["account", "posts"] : ["account", "inbox"]);
});
it("discovers only ads accounts within verified granular scope targets", async () => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.pathname.endsWith("oauth/access_token")) return { access_token: "token" };
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", user_id: "user", scopes: ["ads_read"], granular_scopes: [{ scope: "ads_read", target_ids: ["100"] }] } };
    if (url.pathname.endsWith("/adaccounts")) return { data: [{ id: "act_100", account_id: "100", name: "Own" }, { id: "act_200", account_id: "200", name: "Other" }] };
    return { id: "user" };
  });
  expect((await provider.exchange({ ...config, product: "ads", provider: "facebook_business" }, "code")).assets.map((a) => a.providerId)).toEqual(["act_100"]);
});
it("discovers WhatsApp phones through assigned WABAs and exposes no invented history capability", async () => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.pathname.endsWith("oauth/access_token")) return { access_token: "token" };
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", user_id: "user", scopes: ["whatsapp_business_management"] } };
    if (url.pathname.endsWith("assigned_whatsapp_business_accounts")) return { data: [{ id: "waba", name: "Business" }] };
    if (url.pathname === "/v27.0/waba/phone_numbers") return { data: [{ id: "phone", verified_name: "Business", display_phone_number: "private-number" }] };
    return { id: "user" };
  });
  const asset = (await provider.exchange({ ...config, product: "whatsapp", provider: "facebook_business" }, "code")).assets[0]; expect(asset).toEqual({ product: "whatsapp", providerId: "phone", parentId: "waba", label: "Business", capabilities: ["account"] });
});
it("Threads exchanges a dedicated code, upgrades to long-lived and validates actual scopes", async () => {
  const provider = new MetaStudentProvider(async (url, init) => {
    expect(url.hostname).toBe("graph.threads.com");
    if (url.pathname === "/oauth/access_token" && init?.method === "POST") return { access_token: "short", user_id: "threads-user" };
    if (url.pathname === "/access_token") { expect(url.searchParams.get("access_token")).toBe("short"); expect(init?.headers).toBeUndefined(); return { access_token: "long", expires_in: 5_184_000 }; }
    if (url.pathname === "/oauth/access_token") { expect(url.searchParams.get("grant_type")).toBe("client_credentials"); expect(url.searchParams.get("client_id")).toBe("123"); expect(url.searchParams.get("client_secret")).toBe("app-secret"); return { access_token: "TH|123|example-app-secret" }; }
    if (url.pathname === "/v1.0/debug_token") { expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer TH|123|example-app-secret"); expect(url.searchParams.get("input_token")).toBe("long"); return { data: { app_id: "123", type: "USER", expires_at: 0, is_valid: true, user_id: "threads-user", scopes: ["threads_basic", "threads_read_replies"] } }; }
    if (url.pathname === "/v1.0/me") return { id: "threads-user", username: "me" };
    throw new Error("unexpected " + url.pathname);
  });
  const result = await provider.exchange({ ...config, product: "threads", provider: "threads", apiVersion: "v1.0" }, "code"); expect(result.accessToken).toBe("long"); expect(result.assets[0].capabilities).toEqual(["account", "posts", "comments"]); expect(result.expiresAt).toBeGreaterThan(Date.now() / 1000);
});
it.each([
  { failAt: 0, stage: "token_short_exchange" },
  { failAt: 1, stage: "token_long_exchange" },
  { failAt: 2, stage: "app_token_exchange" },
])("distinguishes the fixed Threads $stage checkpoint without exposing exchange URLs", async ({ failAt, stage }) => {
  let call = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect((url as URL).origin).toBe("https://graph.threads.com");
    if (call++ === failAt) return new Response(JSON.stringify({ error: { code: 452, error_subcode: 4279019, message: "PRIVATE-token-url-payload" } }), { status: 400 });
    return new Response(JSON.stringify({ access_token: "PRIVATE-token", expires_in: 5_184_000 }));
  });
  try {
    await expect(new MetaStudentProvider().exchange({ ...config, product: "threads", provider: "threads", apiVersion: "v1.0" }, "PRIVATE-code")).rejects.toMatchObject({ code: "provider_unavailable", diagnostic: { stage, status: 400, metaCode: 452, metaSubcode: 4279019 } });
    expect(call).toBe(failAt + 1);
  } finally { fetchMock.mockRestore(); }
});
it("keeps Threads refresh failures at a fixed stage and never follows provider redirects or caller URLs", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect((url as URL).origin).toBe("https://graph.threads.com");
    expect((url as URL).pathname).toBe("/refresh_access_token");
    expect((url as URL).searchParams.get("access_token")).toBe("https://caller.invalid/PRIVATE-token");
    expect(init?.redirect).toBe("error");
    return new Response('{"error":{"code":452,"error_subcode":4279019,"message":"PRIVATE-provider-payload"}}', { status: 400, headers: { Location: "https://provider.invalid/PRIVATE" } });
  });
  try {
    let failure: unknown;
    try { await new MetaStudentProvider().refresh({ ...config, product: "threads", provider: "threads" }, { accessToken: "https://caller.invalid/PRIVATE-token", assetTokens: {} }, "threads-user"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BrokerError);
    expect(failure).toMatchObject({ code: "provider_unavailable", diagnostic: { stage: "token_refresh", status: 400, metaCode: 452, metaSubcode: 4279019 } });
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE|https:|access_token|message/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(requestMeta(new URL("https://caller.invalid/access_token"))).rejects.toThrow("provider_host_rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); }
});
it("rejects malformed granular grant proof instead of broadening capability", async () => {
  const provider = new MetaStudentProvider(async (url) => url.pathname.endsWith("oauth/access_token") ? { access_token: "token" } : { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", scopes: ["instagram_basic"], granular_scopes: [{ scope: "instagram_basic", target_ids: "bad" }] } });
  await expect(provider.exchange(config, "code")).rejects.toThrow("grant_verification_failed");
});
it("refreshes only Threads through the fixed official endpoint without disclosing credentials", async () => {
  const dataExpiry = Math.floor(Date.now() / 1000) + 100_000;
  const provider = new MetaStudentProvider(async (url, init) => {
    expect(url.hostname).toBe("graph.threads.com");
    if (url.pathname === "/refresh_access_token") { expect(url.searchParams.get("grant_type")).toBe("th_refresh_token"); expect(url.searchParams.get("access_token")).toBe("old"); expect(init?.headers).toBeUndefined(); return { access_token: "refreshed", expires_in: 5_184_000, token_type: "bearer" }; }
    if (url.pathname === "/oauth/access_token") { expect(url.searchParams.get("grant_type")).toBe("client_credentials"); return { access_token: "TH|123|example-app-secret" }; }
    if (url.pathname.endsWith("/debug_token")) { expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer TH|123|example-app-secret"); expect(url.searchParams.get("input_token")).toBe("refreshed"); return { data: { app_id: "123", type: "USER", expires_at: 0, is_valid: true, user_id: "threads-user", scopes: ["threads_basic"], data_access_expires_at: dataExpiry } }; }
    return { id: "threads-user" };
  });
  const refreshed = await provider.refresh({ ...config, product: "threads", provider: "threads" }, { accessToken: "old", assetTokens: {} }, "threads-user"); expect(refreshed.accessToken).toBe("refreshed"); expect(refreshed.expiresAt).toBe(dataExpiry);
  await expect(provider.refresh(config, { accessToken: "bisu", assetTokens: {} })).rejects.toThrow("refresh_unsupported");
});
it("upgrades Facebook USER grants while never applying that exchange to Unified SYSTEM_USER", async () => {
  let exchanged = false;
  const provider = new MetaStudentProvider(async (url) => {
    if (url.pathname.endsWith("oauth/access_token")) { if (url.searchParams.get("grant_type") === "fb_exchange_token") { exchanged = true; return { access_token: "long-user", expires_in: 5_184_000 }; } return { access_token: "short-user" }; }
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "USER", user_id: "user", scopes: ["ads_read"] } };
    if (url.pathname.endsWith("/adaccounts")) return { data: [{ id: "act_100", account_id: "100", name: "Own" }] };
    return { id: "user" };
  });
  const result = await provider.exchange({ ...config, product: "ads", provider: "facebook_business" }, "code"); expect(exchanged).toBe(true); expect(result.accessToken).toBe("long-user");
});
it("bounds multi-WABA discovery instead of issuing an unbounded request per phone collection", async () => {
  let calls = 0;
  const provider = new MetaStudentProvider(async (url) => {
    calls++;
    if (url.pathname.endsWith("oauth/access_token")) return { access_token: "token" };
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", user_id: "user", scopes: ["whatsapp_business_management"] } };
    if (url.pathname.endsWith("assigned_whatsapp_business_accounts")) return { data: Array.from({ length: 100 }, (_, n) => ({ id: `waba-${n}` })) };
    if (url.pathname.endsWith("phone_numbers")) return { data: [{ id: "phone" }] };
    return { id: "user" };
  });
  await expect(provider.exchange({ ...config, product: "whatsapp", provider: "facebook_business" }, "code")).rejects.toThrow("provider_budget_exceeded"); expect(calls).toBeLessThanOrEqual(32);
});
it("preserves cursor-only provider pagination and never follows a provider-supplied URL", async () => {
  let pages = 0;
  const provider = new MetaStudentProvider(async (url) => {
    expect(url.hostname).toBe("graph.facebook.com");
    if (url.pathname.endsWith("oauth/access_token")) return { access_token: "token" };
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", user_id: "user", scopes: ["instagram_basic"] } };
    if (url.pathname.endsWith("assigned_instagram_accounts")) { pages++; return pages === 1 ? { data: [{ id: "100", username: "one" }], paging: { cursors: { after: "after-one" } } } : { data: [{ id: "200", username: "two" }] }; }
    return { id: "user", client_business_id: "business" };
  });
  expect((await provider.exchange(config, "code")).assets.map((asset) => asset.providerId)).toEqual(["100", "200"]);
});
it("continues an empty discovery page carrying a fresh cursor to an owned asset", async () => {
  const provider = new MetaStudentProvider(async (url) => {
    if (url.pathname.endsWith("oauth/access_token")) return { access_token: "token" };
    if (url.pathname.endsWith("debug_token")) return { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", user_id: "user", scopes: ["instagram_basic"] } };
    if (url.pathname.endsWith("assigned_instagram_accounts")) return url.searchParams.get("after") === "fresh" ? { data: [{ id: "100", username: "owned" }] } : { data: [], paging: { cursors: { after: "fresh" } } };
    return { id: "user", client_business_id: "business" };
  });
  expect((await provider.exchange(config, "code")).assets.map((asset) => asset.providerId)).toEqual(["100"]);
});
it("reads account Threads insights from its own account edge", async () => {
  const provider = new MetaStudentProvider(async (url) => { expect(url.pathname).toBe("/v1.0/threads-user/threads_insights"); expect(url.searchParams.get("metric")).toBe("views,likes,replies,reposts,quotes,followers_count"); return { data: [{ name: "views", values: [{ value: 42, end_time: "now" }] }] }; });
  const result = await provider.read({ ...config, product: "threads", provider: "threads", apiVersion: "v1.0" }, { ...connection, product: "threads", providerId: "threads-user" }, { accessToken: "token", assetTokens: {} }, { connectionId: "connection", operation: "metrics" }); expect(result.data).toEqual({ items: [{ name: "views", values: [{ value: 42, end_time: "now" }] }] });
});
it("projects posts and opaque cursor without provider paging URLs or credentials", async () => {
  const provider = new MetaStudentProvider(async () => ({ data: [{ id: "200", caption: "hello", access_token: "hidden", secret: "hidden", media_url: "https://cdn.example/image?access_token=hidden" }], paging: { next: "https://graph.facebook.com/next?access_token=hidden", cursors: { after: "opaque" } } }));
  const result = await provider.read(config, connection, { accessToken: "token", assetTokens: {} }, { connectionId: "connection", operation: "posts", limit: 5 });
  expect(result.data).toEqual({ items: [{ id: "200", caption: "hello" }], nextCursor: "opaque" }); expect(JSON.stringify(result)).not.toContain("hidden");
});
it("rejects a media ID absent from the selected own asset before reading its comments", async () => {
  const provider = new MetaStudentProvider(async (url) => { if (url.pathname === "/v27.0/100/media") return { data: [{ id: "owned" }] }; throw new Error("foreign request sent"); });
  await expect(provider.read(config, connection, { accessToken: "token", assetTokens: {} }, { connectionId: "connection", operation: "comments", mediaId: "foreign" })).rejects.toThrow("media_not_owned_or_outside_window");
});
it.each(["instagram", "messenger"] as const)("requests only documented conversation metadata for %s with the selected resource credential", async (product) => {
  const provider = new MetaStudentProvider(async (url, init) => {
    if (product === "messenger" && url.pathname === "/v27.0/me") { expect(url.searchParams.get("fields")).toBe("id,name"); return { id: "100", name: "Synthetic Page" }; }
    expect(url.searchParams.get("fields")).toBe("id,updated_time");
    expect(url.searchParams.get("platform")).toBe(product);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-selected-asset-token");
    return { data: [{ id: "conversation", updated_time: "2026-11-09T10:00:00Z", message_count: 777, text: "PRIVATE-message", access_token: "PRIVATE-token" }] };
  });
  const result = await provider.read({ ...config, product }, { ...connection, product }, { accessToken: "synthetic-user-token", assetTokens: { "100": "synthetic-selected-asset-token" } }, { connectionId: connection.id, operation: "inbox" });
  expect(result.data).toEqual({ items: [{ id: "conversation", updated_time: "2026-11-09T10:00:00Z" }] });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|777|message_count/);
});
it("keeps Threads OAuth separate and fails wrong-app grants before discovery", async () => {
  const threads = { ...config, product: "threads" as const, provider: "threads" as const };
  expect(new URL(authorizationUrl(threads, "state")).hostname).toBe("threads.com");
  const provider = new MetaStudentProvider(async (url) => url.pathname.endsWith("oauth/access_token") ? { access_token: "token" } : { data: { app_id: "other", is_valid: true, user_id: "user", scopes: ["instagram_basic"] } });
  await expect(provider.exchange(config, "code")).rejects.toThrow("grant_verification_failed");
});
