import { MetaClient } from "./meta-client.js";
import type { AuthMode, OAuthToken } from "./oauth.js";
import { requestJsonHttp } from "./http-json.js";

export interface OAuthIdentityConstraints {
  expectedAccountId?: string;
  expectedPageId?: string;
}

export interface VerifiedOAuthIdentity {
  userId: string;
  pageId?: string;
  permissions?: string[];
  clientBusinessId?: string;
}

export interface OAuthIdentityConfig {
  authMode: AuthMode;
  graphApiVersion: string;
  appId?: string;
  appSecret?: string;
}

type IdentityMetaClient = Pick<MetaClient, "get" | "forFacebookPage">;
export type OAuthIdentityClientFactory = (accessToken: string, authMode: AuthMode) => IdentityMetaClient;
export interface OAuthIdentityVerificationOptions {
  /** Enabled only by the callback after consuming state pinned to the expected Page. */
  allowKnownPageFallback?: boolean;
  signal?: AbortSignal;
}

/** Resolve the Instagram identity from the freshly exchanged token before it can replace stored credentials. */
export async function verifyOAuthAccountIdentity(
  config: OAuthIdentityConfig,
  token: OAuthToken,
  expected: OAuthIdentityConstraints = {},
  clientFactory: OAuthIdentityClientFactory = (accessToken, authMode) => new MetaClient({
    accessToken,
    apiVersion: config.graphApiVersion,
    baseUrl: authMode !== "instagram" ? "https://graph.facebook.com" : "https://graph.instagram.com",
  }),
  verification: OAuthIdentityVerificationOptions = {},
): Promise<VerifiedOAuthIdentity> {
  if (!token.accessToken || (token.authMode && token.authMode !== config.authMode)) {
    throw new Error("OAUTH_IDENTITY_UNVERIFIED");
  }

  if (config.authMode === "instagram") {
    if (expected.expectedPageId) throw new Error("OAUTH_IDENTITY_MISMATCH");
    const userId = token.userId;
    if (!userId) throw new Error("OAUTH_IDENTITY_UNVERIFIED");
    if (expected.expectedAccountId && expected.expectedAccountId !== userId) throw new Error("OAUTH_IDENTITY_MISMATCH");
    return { userId };
  }

  const client = clientFactory(token.accessToken, config.authMode);
  if (config.authMode === "unified") {
    if (expected.expectedPageId) throw new Error("OAUTH_IDENTITY_MISMATCH");
    const proof = await readUnifiedTokenProof({ ...config, signal: verification.signal }, token);
    const readOptions = verification.signal ? { signal: verification.signal } : {};
    const me = asRecord(await client.get("/me", { fields: ["id", "client_business_id"] }, readOptions));
    const clientBusinessId = stringValue(me?.client_business_id);
    if (!clientBusinessId || stringValue(me?.id) !== proof.systemUserId) throw new Error("OAUTH_IDENTITY_UNVERIFIED");
    if (token.clientBusinessId && token.clientBusinessId !== clientBusinessId) throw new Error("OAUTH_IDENTITY_MISMATCH");
    const response = asRecord(await client.get("/me/assigned_instagram_accounts", { fields: ["id", "username"], limit: 100 }, readOptions));
    const paging = response?.paging === undefined ? undefined : asRecord(response.paging);
    // Never infer uniqueness from an incomplete page or follow provider URLs.
    if (!Array.isArray(response?.data) || (response.paging !== undefined && !paging) || paging?.next !== undefined) throw new Error("OAUTH_IDENTITY_AMBIGUOUS");
    const seen = new Set<string>();
    const accounts: string[] = [];
    for (const item of response.data) {
      const row = asRecord(item), id = stringValue(row?.id);
      if (!id || !stringValue(row?.username) || seen.has(id)) throw new Error("OAUTH_IDENTITY_UNVERIFIED");
      seen.add(id); accounts.push(id);
    }
    const selected = expected.expectedAccountId;
    if (selected && !seen.has(selected)) throw new Error("OAUTH_IDENTITY_MISMATCH");
    if (!selected && accounts.length !== 1) throw new Error("OAUTH_IDENTITY_AMBIGUOUS");
    const userId = selected ?? accounts[0]!;
    const permissions = unifiedPermissionsForAccount(proof, userId);
    if (!permissions.includes("instagram_basic")) throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
    return { userId, clientBusinessId, permissions };
  }
  if (expected.expectedPageId) {
    const page = verification.allowKnownPageFallback === true
      ? await client.forFacebookPage(expected.expectedPageId, { allowKnownPageFallback: true })
      : await client.forFacebookPage(expected.expectedPageId);
    const userId = page.instagramUserId;
    if (!userId || page.pageId !== expected.expectedPageId) throw new Error("OAUTH_IDENTITY_UNVERIFIED");
    if (expected.expectedAccountId && userId !== expected.expectedAccountId) throw new Error("OAUTH_IDENTITY_MISMATCH");
    return { userId, pageId: page.pageId };
  }

  if (expected.expectedAccountId) {
    const response = asRecord(await client.get(`/${encodeURIComponent(expected.expectedAccountId)}`, { fields: ["id", "username"] }));
    const userId = stringValue(response?.id);
    if (!userId || !stringValue(response?.username)) throw new Error("OAUTH_IDENTITY_UNVERIFIED");
    if (userId !== expected.expectedAccountId) throw new Error("OAUTH_IDENTITY_MISMATCH");
    return { userId };
  }

  const response = asRecord(await client.get("/me/accounts", {
    fields: ["id", "instagram_business_account{id}"],
    limit: 100,
  }));
  const data = Array.isArray(response?.data) ? response.data : [];
  const accounts = data.flatMap((item) => {
    const page = asRecord(item);
    const instagram = asRecord(page?.instagram_business_account);
    const pageId = stringValue(page?.id);
    const userId = stringValue(instagram?.id);
    return pageId && userId ? [{ pageId, userId }] : [];
  });
  const paging = asRecord(response?.paging);
  if (typeof paging?.next === "string" || accounts.length !== 1) {
    throw new Error("OAUTH_IDENTITY_AMBIGUOUS");
  }
  return accounts[0]!;
}

/** Read actual grants of this Facebook user token; requested or stored labels are not proof. */
export async function readFacebookGrantedPermissions(graphApiVersion: string, token: OAuthToken): Promise<string[]> {
  if (!token.accessToken || (token.authMode && token.authMode !== "facebook")) throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
  const { accessToken } = token;
  const client = new MetaClient({ accessToken, apiVersion: graphApiVersion, baseUrl: "https://graph.facebook.com" });
  const response = asRecord(await client.get("/me/permissions"));
  const paging = response?.paging;
  if (!Array.isArray(response?.data) || (paging !== undefined && (!asRecord(paging) || asRecord(paging)?.next !== undefined))) {
    throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
  }
  const seen = new Set<string>();
  const granted: string[] = [];
  for (const item of response.data) {
    const row = asRecord(item);
    if (typeof row?.permission !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(row.permission)
      || typeof row.status !== "string" || !["granted", "declined", "expired"].includes(row.status) || seen.has(row.permission)) {
      throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
    }
    seen.add(row.permission);
    if (row.status === "granted") granted.push(row.permission);
  }
  return granted;
}

/** Inspect a BISU token with this Meta app's credentials; stored/requested grants are never proof. */
export async function readUnifiedGrantedPermissions(config: UnifiedInspectionConfig, token: OAuthToken): Promise<string[]> {
  const proof = await readUnifiedTokenProof(config, token);
  return token.userId ? unifiedPermissionsForAccount(proof, token.userId) : proof.permissions;
}

type UnifiedInspectionConfig = Pick<OAuthIdentityConfig, "graphApiVersion" | "appId" | "appSecret"> & { signal?: AbortSignal };
interface UnifiedTokenProof { permissions: string[]; systemUserId: string; granularScopes: { scope: string; targets?: string[] }[] }
async function readUnifiedTokenProof(config: UnifiedInspectionConfig, token: OAuthToken): Promise<UnifiedTokenProof> {
  if (config.signal?.aborted) throw new Error("OAUTH_CANCELLED");
  if (!config.appId || !config.appSecret || !token.accessToken || (token.authMode && token.authMode !== "unified") || !/^v\d+\.0$/.test(config.graphApiVersion)) throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
  const url = new URL(`https://graph.facebook.com/${config.graphApiVersion}/debug_token`);
  url.searchParams.set("input_token", token.accessToken);
  // Bearer app credential stays in a header. Never expose upstream bodies or URLs on failure.
  let response;
  try {
    response = await requestJsonHttp(url, { method: "GET", headers: { authorization: `Bearer ${config.appId}|${config.appSecret}`, accept: "application/json" }, allowRouteRetry: false, signal: config.signal });
  } catch { throw new Error("OAUTH_PERMISSIONS_UNVERIFIED"); }
  const body = asRecord(response.body), data = asRecord(body?.data);
  const permissions = data?.scopes;
  const systemUserId = stringValue(data?.user_id);
  if (!response.ok || body?.error !== undefined || data?.is_valid !== true || stringValue(data.app_id) !== config.appId || data.type !== "SYSTEM_USER" || !systemUserId
    || !Array.isArray(permissions) || permissions.length < 1 || permissions.length > 100 || !permissions.every((scope) => typeof scope === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(scope))
    || new Set(permissions).size !== permissions.length || !permissions.includes("instagram_basic")
    || data.expires_at === undefined || [data.expires_at, data.data_access_expires_at].some((expiry) => expiry !== undefined && (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry < 0 || (expiry > 0 && expiry <= Date.now() / 1000)))) {
    throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
  }
  const granularScopes: UnifiedTokenProof["granularScopes"] = [];
  if (data.granular_scopes !== undefined) {
    if (!Array.isArray(data.granular_scopes) || data.granular_scopes.length > 100) throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
    for (const item of data.granular_scopes) {
      const row = asRecord(item);
      const targets = Array.isArray(row?.target_ids) ? row.target_ids.map((target) =>
        typeof target === "number" && Number.isSafeInteger(target) && target > 0 ? String(target) : target) : undefined;
      if (typeof row?.scope !== "string" || !permissions.includes(row.scope)
        || (row.target_ids !== undefined && (!targets || targets.length > 1000 || !targets.every((target) => typeof target === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(target))))) throw new Error("OAUTH_PERMISSIONS_UNVERIFIED");
      granularScopes.push({ scope: row.scope, ...(targets ? { targets: targets as string[] } : {}) });
    }
  }
  return { permissions: permissions as string[], systemUserId, granularScopes };
}

function unifiedPermissionsForAccount(proof: UnifiedTokenProof, userId: string): string[] {
  return proof.permissions.filter((scope) => {
    const restrictions = proof.granularScopes.filter((row) => row.scope === scope);
    return restrictions.length === 0 || restrictions.some((row) => row.targets === undefined || row.targets.includes(userId));
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}
