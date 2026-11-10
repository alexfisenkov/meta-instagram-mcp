import { afterEach, expect, it, vi } from "vitest";
import { MetaStudentProvider } from "../src/student/meta-provider.js";
import type { ProductConfig } from "../src/student/types.js";

const config: ProductConfig = { product: "threads", key: "threads", provider: "threads", appId: "123", appSecret: "synthetic-app-secret", apiVersion: "v1.0", callbackUrl: "https://broker.example/meta/oauth/callback", admission: "test", testSubjects: [] };
// Exact documented shape/values; freeze the clock before this historical sample expires.
// https://developers.facebook.com/docs/threads/troubleshooting/debug-access-token/
const documentedProof = { type: "USER", application: "Threads API Test App", data_access_expires_at: 1754846089, expires_at: 1752254132, is_valid: true, issued_at: 1747070132, scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_manage_insights", "threads_read_replies", "threads_manage_mentions", "threads_keyword_search", "threads_location_tagging"], user_id: "1234567890123456" };
afterEach(() => vi.restoreAllMocks());

it("accepts Meta's documented Threads inspection without app_id only through fresh dedicated app-token binding", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-06-01T12:00:00Z"));
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const provider = new MetaStudentProvider(async (url, init) => {
    requests.push({ url, init });
    expect(url.origin).toBe("https://graph.threads.com");
    if (url.pathname === "/oauth/access_token" && init?.method === "POST") return { access_token: "synthetic-short" };
    if (url.pathname === "/access_token" || url.pathname === "/refresh_access_token") return { access_token: "synthetic-long", token_type: "bearer", expires_in: 5184000 };
    if (url.pathname === "/oauth/access_token") {
      expect(url.searchParams.get("grant_type")).toBe("client_credentials");
      expect(url.searchParams.get("client_id")).toBe("123");
      expect(url.searchParams.get("client_secret")).toBe("synthetic-app-secret");
      return { access_token: "synthetic-fresh-app-token" };
    }
    if (url.pathname === "/v1.0/debug_token") {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-fresh-app-token");
      expect(url.searchParams.get("input_token")).toBe("synthetic-long");
      return { data: structuredClone(documentedProof) };
    }
    if (url.pathname === "/v1.0/me") return { id: documentedProof.user_id, username: "synthetic-owner" };
    throw new Error("unexpected fixed Threads endpoint");
  });
  const grant = await provider.exchange(config, "synthetic-code");
  expect(grant.providerUserId).toBe(documentedProof.user_id);
  expect(grant.expiresAt).toBe(documentedProof.expires_at);
  expect(grant.assets[0].capabilities).toEqual(["account", "posts", "metrics", "comments"]);
  const refreshed = await provider.refresh(config, { accessToken: grant.accessToken, assetTokens: {} }, documentedProof.user_id);
  expect(refreshed.expiresAt).toBe(documentedProof.expires_at);
  expect(refreshed.scopes).toEqual(documentedProof.scopes);
  expect(requests.filter(({ url }) => url.searchParams.get("grant_type") === "client_credentials")).toHaveLength(2);
});
it.each([
  { name: "foreign explicit app", change: { app_id: "foreign-app" }, reason: "threads_inspection_app_mismatch" },
  { name: "wrong token type", change: { type: "APP" }, reason: "threads_inspection_type_invalid" },
  { name: "missing token type", change: { type: undefined }, reason: "threads_inspection_type_invalid" },
  { name: "invalid grant", change: { is_valid: false }, reason: "threads_inspection_not_valid" },
  { name: "missing base scope", change: { scopes: ["threads_read_replies"] }, reason: "threads_inspection_scopes_invalid" },
  { name: "foreign permission family", change: { scopes: ["threads_basic", "instagram_basic"] }, reason: "threads_inspection_scopes_invalid" },
  { name: "missing identity", change: { user_id: undefined }, reason: "threads_inspection_identity_invalid" },
  { name: "unsafe numeric identity", change: { user_id: 17841400000000001 }, reason: "threads_inspection_identity_invalid" },
  { name: "missing expiry", change: { expires_at: undefined }, reason: "threads_inspection_expiry_invalid" },
  { name: "expired token", change: { expires_at: 1 }, reason: "threads_inspection_expired" },
] as const)("rejects Threads $name at the fixed inspection checkpoint", async ({ change, reason }) => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-06-01T12:00:00Z"));
  const provider = new MetaStudentProvider(async (url) => {
    if (url.pathname === "/oauth/access_token") return { access_token: "synthetic-token" };
    if (url.pathname === "/access_token") return { access_token: "synthetic-long", expires_in: 5184000 };
    if (url.pathname.endsWith("/debug_token")) return { data: { ...documentedProof, ...change } };
    throw new Error("identity must not be queried for invalid inspection");
  });
  await expect(provider.exchange(config, "synthetic-code")).rejects.toMatchObject({ code: reason, diagnostic: { stage: "token_inspection" } });
});
it("rejects missing dedicated app credentials or app-token responses before inspection", async () => {
  let calls = 0;
  const provider = new MetaStudentProvider(async (url) => { calls++; return url.pathname === "/access_token" ? { access_token: "synthetic-long", expires_in: 5184000 } : url.searchParams.get("grant_type") === "client_credentials" ? {} : { access_token: "synthetic-short" }; });
  await expect(provider.exchange({ ...config, appSecret: "" }, "code")).rejects.toMatchObject({ code: "threads_app_binding_missing", diagnostic: { stage: "app_token_exchange" } });
  expect(calls).toBe(0);
  await expect(provider.exchange(config, "code")).rejects.toMatchObject({ code: "threads_app_token_invalid", diagnostic: { stage: "app_token_exchange" } });
  expect(calls).toBe(3);
});
it("binds inspected Threads identity to fresh /me on exchange and the stored identity on refresh", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-06-01T12:00:00Z"));
  const provider = new MetaStudentProvider(async (url) => url.pathname.endsWith("/debug_token") ? { data: documentedProof } : url.pathname.endsWith("/me") ? { id: "foreign-user" } : { access_token: "synthetic-token", expires_in: 5184000 });
  await expect(provider.exchange(config, "code")).rejects.toMatchObject({ code: "threads_identity_mismatch", diagnostic: { stage: "account_identity" } });
  await expect(provider.refresh(config, { accessToken: "synthetic-old", assetTokens: {} }, "foreign-user")).rejects.toMatchObject({ code: "threads_identity_mismatch", diagnostic: { stage: "account_identity" } });
});
it.each(["instagram_unified", "facebook_business"] as const)("keeps app_id mandatory for %s inspection", async (providerType) => {
  const provider = new MetaStudentProvider(async (url) => url.pathname.endsWith("/debug_token") ? { data: { type: "SYSTEM_USER", user_id: "user", is_valid: true, scopes: ["instagram_basic"], expires_at: 0 } } : { access_token: "synthetic-token" });
  await expect(provider.exchange({ ...config, provider: providerType, product: providerType === "instagram_unified" ? "instagram" : "facebook", configId: "456" }, "code")).rejects.toMatchObject({ code: "grant_verification_failed", diagnostic: { stage: "token_inspection" } });
});
