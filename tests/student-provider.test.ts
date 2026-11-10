import { expect, it, vi } from "vitest";
import { MetaStudentProvider, requestMeta } from "../src/student/meta-provider.js";
import { authorizationUrl } from "../src/student/registry.js";
import { BrokerError, type Connection, type ProductConfig } from "../src/student/types.js";
const config: ProductConfig = { product: "instagram", key: "ig", provider: "instagram_unified", appId: "123", appSecret: "app-secret", configId: "456", apiVersion: "v27.0", callbackUrl: "https://broker.example/student/oauth/callback", admission: "live", testSubjects: [] };
const connection: Connection = { id: "connection", tenantId: "masterskaya", sub: "student", grantId: "grant", product: "instagram", providerId: "100", label: "my-account", capabilities: ["account", "posts", "comments"], status: "connected", updatedAt: "now" };
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
    if (url.pathname === "/v27.0/me") return { id: "user" };
    if (url.pathname.endsWith("/me/accounts")) return { data: [{ id: "page", name: "Page", access_token: "page-token", tasks: ["MESSAGING"] }] };
    if (url.pathname === "/v27.0/page") { expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer page-token"); return { id: "page", name: "Page" }; }
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
    if (url.pathname === "/access_token") return { access_token: "long", expires_in: 5_184_000 };
    if (url.pathname === "/oauth/access_token") { expect(url.searchParams.get("grant_type")).toBe("client_credentials"); expect(url.searchParams.get("client_id")).toBe("123"); expect(url.searchParams.get("client_secret")).toBe("app-secret"); return { access_token: "TH|123|example-app-secret" }; }
    if (url.pathname === "/v1.0/debug_token") { expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer TH|123|example-app-secret"); expect(url.searchParams.get("input_token")).toBe("long"); return { data: { app_id: "123", is_valid: true, user_id: "threads-user", scopes: ["threads_basic", "threads_read_replies"] } }; }
    if (url.pathname === "/v1.0/me") return { id: "threads-user", username: "me" };
    throw new Error("unexpected " + url.pathname);
  });
  const result = await provider.exchange({ ...config, product: "threads", provider: "threads", apiVersion: "v1.0" }, "code"); expect(result.accessToken).toBe("long"); expect(result.assets[0].capabilities).toEqual(["account", "posts", "comments"]); expect(result.expiresAt).toBeGreaterThan(Date.now() / 1000);
});
it("rejects malformed granular grant proof instead of broadening capability", async () => {
  const provider = new MetaStudentProvider(async (url) => url.pathname.endsWith("oauth/access_token") ? { access_token: "token" } : { data: { app_id: "123", is_valid: true, type: "SYSTEM_USER", scopes: ["instagram_basic"], granular_scopes: [{ scope: "instagram_basic", target_ids: "bad" }] } });
  await expect(provider.exchange(config, "code")).rejects.toThrow("grant_verification_failed");
});
it("refreshes only Threads through the fixed official endpoint without disclosing credentials", async () => {
  const dataExpiry = Math.floor(Date.now() / 1000) + 100_000;
  const provider = new MetaStudentProvider(async (url, init) => {
    expect(url.hostname).toBe("graph.threads.com");
    if (url.pathname === "/refresh_access_token") { expect(url.searchParams.get("grant_type")).toBe("th_refresh_token"); expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer old"); return { access_token: "refreshed", expires_in: 5_184_000, token_type: "bearer" }; }
    if (url.pathname === "/oauth/access_token") { expect(url.searchParams.get("grant_type")).toBe("client_credentials"); return { access_token: "TH|123|example-app-secret" }; }
    if (url.pathname.endsWith("/debug_token")) { expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer TH|123|example-app-secret"); expect(url.searchParams.get("input_token")).toBe("refreshed"); return { data: { app_id: "123", is_valid: true, user_id: "threads-user", scopes: ["threads_basic"], data_access_expires_at: dataExpiry } }; }
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
it("keeps Threads OAuth separate and fails wrong-app grants before discovery", async () => {
  const threads = { ...config, product: "threads" as const, provider: "threads" as const };
  expect(new URL(authorizationUrl(threads, "state")).hostname).toBe("threads.com");
  const provider = new MetaStudentProvider(async (url) => url.pathname.endsWith("oauth/access_token") ? { access_token: "token" } : { data: { app_id: "other", is_valid: true, user_id: "user", scopes: ["instagram_basic"] } });
  await expect(provider.exchange(config, "code")).rejects.toThrow("grant_verification_failed");
});
