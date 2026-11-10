import { expect, it } from "vitest";
import { MetaStudentProvider } from "../src/student/meta-provider.js";
import { configFingerprint } from "../src/student/registry.js";
import { BrokerError, type Connection, type ProductConfig } from "../src/student/types.js";

const config: ProductConfig = { product: "messenger", key: "messenger", provider: "facebook_business", appId: "123", appSecret: "synthetic-secret", configId: "456", apiVersion: "v27.0", callbackUrl: "https://broker.example/meta/oauth/callback", admission: "test", testSubjects: [] };
const connection: Connection = { id: "connection", tenantId: "masterskaya", sub: "synthetic-owner", grantId: "grant", product: "messenger", providerId: "100", label: "Synthetic Page", capabilities: ["account", "inbox"], status: "connected", updatedAt: "synthetic" };
const scopes = ["pages_read_engagement", "pages_messaging", "pages_manage_metadata"];
interface Scenario { user?: boolean; tasks?: unknown; pageToken?: unknown; selectedId?: string; tokenIdentity?: string; deniedToken?: boolean; scopes?: string[]; granularScopes?: unknown }
function fixture(scenario: Scenario = {}) {
  const calls: Array<{ url: URL; token?: string }> = [];
  const grantToken = scenario.user ? "synthetic-user-grant" : "synthetic-system-grant";
  const pageToken = Object.hasOwn(scenario, "pageToken") ? scenario.pageToken : "synthetic-page-token";
  const provider = new MetaStudentProvider(async (url, init) => {
    expect(url.origin).toBe("https://graph.facebook.com");
    const token = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, token });
    if (url.pathname.endsWith("/oauth/access_token")) return { access_token: grantToken };
    if (url.pathname.endsWith("/debug_token")) return { data: { app_id: "123", is_valid: true, type: scenario.user ? "USER" : "SYSTEM_USER", user_id: "synthetic-grant-user", scopes: scenario.scopes ?? scopes, ...(scenario.granularScopes ? { granular_scopes: scenario.granularScopes } : {}) } };
    if (url.pathname === "/v27.0/me") return token === `Bearer ${grantToken}` ? { id: "synthetic-grant-user", name: "Synthetic user" } : { id: scenario.tokenIdentity ?? "100", name: "Synthetic Page" };
    if (url.pathname === "/v27.0/me/accounts" || url.pathname === "/v27.0/me/assigned_pages") return { data: [{ id: "100", name: "Synthetic Page", access_token: "unchecked-list-token", tasks: Object.hasOwn(scenario, "tasks") ? scenario.tasks : ["MESSAGING"] }] };
    if (url.pathname === "/v27.0/100") {
      if (url.searchParams.get("fields") === "id,name,access_token") {
        if (scenario.deniedToken) throw new BrokerError("permission_unavailable", { stage: "account_identity", status: 403, metaCode: 200 });
        return { id: scenario.selectedId ?? "100", name: "Synthetic Page", ...(pageToken !== undefined ? { access_token: pageToken } : {}) };
      }
      return { id: "100", name: "Synthetic Page" };
    }
    if (url.pathname === "/v27.0/100/conversations") return { data: [{ id: "conversation", updated_time: "2026-11-09T10:00:00Z" }] };
    throw new Error("unexpected synthetic endpoint");
  });
  return { provider, calls, grantToken };
}

it.each([false, true])("uses a freshly issued Page token and /me identity for Messenger (user grant=%s)", async (user) => {
  const { provider, calls, grantToken } = fixture({ user });
  const grant = await provider.exchange(config, "synthetic-code");
  expect(grant.accessToken).toBe(grantToken);
  expect(grant.assetTokens).toEqual({ "100": "synthetic-page-token" });
  expect(grant.assets).toEqual([{ product: "messenger", providerId: "100", label: "Synthetic Page", capabilities: ["account", "inbox"] }]);
  expect(calls.some(({ url }) => url.pathname === "/v27.0/100" && url.searchParams.get("fields") === "id,name,access_token")).toBe(true);
  expect(calls.some(({ url, token }) => url.pathname === "/v27.0/me" && token === "Bearer synthetic-page-token")).toBe(true);
  await provider.read(config, connection, grant, { connectionId: connection.id, operation: "inbox" });
  expect(calls.filter(({ url }) => url.pathname.endsWith("/conversations")).map(({ token }) => token)).toEqual(["Bearer synthetic-page-token"]);
});

it.each([undefined, [], ["MANAGE"], ["MESSAGING", 42]])("does not advertise inbox without proven messaging tasks: %j", async (tasks) => {
  const { provider } = fixture({ tasks });
  expect((await provider.exchange(config, "code")).assets[0].capabilities).toEqual(["account"]);
});

it.each([{ pageToken: undefined }, { deniedToken: true }])("retains only the verified profile when a Page token is not issued: %j", async (scenario) => {
  const { provider, calls } = fixture(scenario);
  const grant = await provider.exchange(config, "code");
  expect(grant.assets[0].capabilities).toEqual(["account"]);
  expect(grant.assetTokens).toEqual({});
  expect(calls.some(({ url }) => url.pathname.endsWith("/conversations"))).toBe(false);
});

it.each([{ selectedId: "foreign-page" }, { tokenIdentity: "foreign-page" }])("rejects a foreign Page identity without storing its token: %j", async (scenario) => {
  await expect(fixture(scenario).provider.exchange(config, "code")).rejects.toThrow("grant_verification_failed");
});

it("blocks a legacy system-token fallback before any Conversations request", async () => {
  const { provider, calls, grantToken } = fixture();
  await expect(provider.read(config, connection, { accessToken: grantToken, assetTokens: { "100": grantToken } }, { connectionId: connection.id, operation: "inbox" })).rejects.toThrow("permission_unavailable");
  expect(calls).toEqual([]);
});
it("accepts the documented MODERATE task but does not invent missing or foreign-page messaging scopes", async () => {
  expect((await fixture({ tasks: ["MODERATE"] }).provider.exchange(config, "code")).assets[0].capabilities).toEqual(["account", "inbox"]);
  for (const scenario of [{ scopes: ["pages_read_engagement"] }, { granularScopes: [{ scope: "pages_messaging", target_ids: ["foreign-page"] }] }]) {
    expect((await fixture(scenario).provider.exchange(config, "code")).assets[0].capabilities).toEqual(["account"]);
  }
});
it("reads the confirmed minimal profile without a Page token and rejects a wrong Page token before Conversations", async () => {
  const limited = fixture({ deniedToken: true });
  const grant = await limited.provider.exchange(config, "code");
  await expect(limited.provider.read(config, { ...connection, capabilities: ["account"] }, grant, { connectionId: connection.id, operation: "account" })).resolves.toMatchObject({ data: { id: "100", name: "Synthetic Page" }, coverage: "partial" });
  expect(limited.calls.at(-1)?.url.searchParams.get("fields")).toBe("id,name");
  const wrong = fixture({ tokenIdentity: "foreign-page" });
  await expect(wrong.provider.read(config, connection, { accessToken: "synthetic-system-grant", assetTokens: { "100": "synthetic-page-token" } }, { connectionId: connection.id, operation: "inbox" })).rejects.toThrow("grant_verification_failed");
  expect(wrong.calls.some(({ url }) => url.pathname.endsWith("/conversations"))).toBe(false);
});
it("requires new Messenger page-proof authorization while preserving all other Meta fingerprint golden vectors", () => {
  // Recorded from the prior compiled e148 runtime with these exact synthetic inputs.
  expect(configFingerprint(config)).not.toBe("9a6b1b7fea5868381391e3db7f8c66204addf8e1e7e96adb5289a85db8e84608");
  const golden = {
    facebook: "f24d9e5965efb2ec6866dbcfcaa169f9e387b6775bf3845fa68e34580b01d8a1",
    instagram: "4be68fe1fbadda85e9abee57f892ab8c55082b4b3a78d0e95afb87abd1bd5570",
    threads: "9f3e47fd063d812ca13b91186277d4b8a9d398fac31be5e0731960d5cc9f6fc3",
    ads: "bd4c885c86e68f28b4e3c4fa0c23c63936c5f9b3b5dfafe0dabbedf29095642d",
    whatsapp: "95f84815e388095a34de05a40b2ff967c771ee0ccd87dbba030ce1669e8dd8fb",
  };
  for (const product of Object.keys(golden) as Array<keyof typeof golden>) {
    const provider = product === "instagram" ? "instagram_login" : product === "threads" ? "threads" : "facebook_business";
    expect(configFingerprint({ ...config, product, provider, configId: ["instagram", "threads"].includes(product) ? undefined : "456", apiVersion: product === "threads" ? "v1.0" : "v27.0" })).toBe(golden[product]);
  }
});
