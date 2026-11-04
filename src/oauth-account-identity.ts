import { MetaClient } from "./meta-client.js";
import type { AuthMode, OAuthToken } from "./oauth.js";

export interface OAuthIdentityConstraints {
  expectedAccountId?: string;
  expectedPageId?: string;
}

export interface VerifiedOAuthIdentity {
  userId: string;
  pageId?: string;
}

export interface OAuthIdentityConfig {
  authMode: AuthMode;
  graphApiVersion: string;
}

type IdentityMetaClient = Pick<MetaClient, "get" | "forFacebookPage">;
export type OAuthIdentityClientFactory = (accessToken: string, authMode: AuthMode) => IdentityMetaClient;
export interface OAuthIdentityVerificationOptions {
  /** Enabled only by the callback after consuming state pinned to the expected Page. */
  allowKnownPageFallback?: boolean;
}

/** Resolve the Instagram identity from the freshly exchanged token before it can replace stored credentials. */
export async function verifyOAuthAccountIdentity(
  config: OAuthIdentityConfig,
  token: OAuthToken,
  expected: OAuthIdentityConstraints = {},
  clientFactory: OAuthIdentityClientFactory = (accessToken, authMode) => new MetaClient({
    accessToken,
    apiVersion: config.graphApiVersion,
    baseUrl: authMode === "facebook" ? "https://graph.facebook.com" : "https://graph.instagram.com",
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
