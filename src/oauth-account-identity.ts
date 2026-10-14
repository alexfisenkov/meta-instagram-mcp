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
    const page = await client.forFacebookPage(expected.expectedPageId);
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
