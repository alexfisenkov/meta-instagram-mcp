import type { StoredToken } from "./token-store.js";

export type AuthMode = "instagram" | "facebook";

export const DEFAULT_READ_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_insights",
] as const;

export const DEFAULT_ANALYTICS_SCOPES = [
  ...DEFAULT_READ_SCOPES,
  "instagram_business_manage_comments",
] as const;

export const FULL_STANDARD_SCOPES = [
  ...DEFAULT_ANALYTICS_SCOPES,
  "instagram_business_content_publish",
  "instagram_business_manage_messages",
] as const;

export const SCOPE_PRESETS = {
  readOnly: [...DEFAULT_READ_SCOPES],
  analytics: [...DEFAULT_ANALYTICS_SCOPES],
  fullStandard: [...FULL_STANDARD_SCOPES],
} as const;

export const FACEBOOK_READ_SCOPES = [
  "instagram_basic",
  "pages_show_list",
] as const;

export const FACEBOOK_ANALYTICS_SCOPES = [
  ...FACEBOOK_READ_SCOPES,
  "pages_read_engagement",
  "instagram_manage_insights",
  "instagram_manage_comments",
] as const;

export const FACEBOOK_FULL_STANDARD_SCOPES = [
  ...FACEBOOK_ANALYTICS_SCOPES,
  "instagram_content_publish",
  "instagram_manage_messages",
] as const;

export const FACEBOOK_SCOPE_PRESETS = {
  readOnly: [...FACEBOOK_READ_SCOPES],
  analytics: [...FACEBOOK_ANALYTICS_SCOPES],
  fullStandard: [...FACEBOOK_FULL_STANDARD_SCOPES],
} as const;

type FetchLike = typeof fetch;

export interface BuildAuthUrlOptions {
  authMode?: AuthMode;
  appId: string;
  redirectUri: string;
  scopes?: string[];
  forceReauth?: boolean;
  enableFacebookLogin?: boolean;
  graphApiVersion?: string;
}

export interface ExchangeCodeOptions {
  authMode?: AuthMode;
  code: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphApiVersion?: string;
  fetchImpl?: FetchLike;
  now?: Date;
}

export interface RefreshTokenOptions {
  authMode?: AuthMode;
  accessToken: string;
  appId?: string;
  appSecret?: string;
  userId?: string;
  pageId?: string;
  graphApiVersion?: string;
  fetchImpl?: FetchLike;
  now?: Date;
}

interface ShortTokenResponse {
  data?: Array<{
    access_token: string;
    user_id?: string;
    permissions?: string;
  }>;
  access_token?: string;
  user_id?: string;
  permissions?: string;
}

interface LongTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

export function buildAuthUrl(options: BuildAuthUrlOptions): URL {
  if ((options.authMode ?? "instagram") === "facebook") return buildFacebookAuthUrl(options);

  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? defaultScopesForAuthMode("instagram")).join(","));

  if (options.forceReauth) url.searchParams.set("force_reauth", "1");
  if (options.enableFacebookLogin !== undefined) {
    url.searchParams.set("enable_fb_login", options.enableFacebookLogin ? "1" : "0");
  }

  return url;
}

export async function exchangeCodeForLongLivedToken(options: ExchangeCodeOptions): Promise<StoredToken> {
  if ((options.authMode ?? "instagram") === "facebook") return exchangeFacebookCodeForLongLivedToken(options);

  const fetchImpl = options.fetchImpl ?? fetch;
  const shortToken = await exchangeCodeForShortToken(options, fetchImpl);
  const longTokenUrl = new URL("https://graph.instagram.com/access_token");
  longTokenUrl.searchParams.set("grant_type", "ig_exchange_token");
  longTokenUrl.searchParams.set("client_secret", options.appSecret);
  longTokenUrl.searchParams.set("access_token", shortToken.accessToken);

  const response = await fetchImpl(longTokenUrl);
  const body = await readJson<LongTokenResponse>(response);

  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "bearer",
    authMode: "instagram",
    userId: shortToken.userId,
    permissions: shortToken.permissions,
    expiresAt: expiresAtIso(body.expires_in, options.now),
  };
}

export async function refreshLongLivedToken(options: RefreshTokenOptions): Promise<StoredToken> {
  if ((options.authMode ?? "instagram") === "facebook") return refreshFacebookLongLivedToken(options);

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", options.accessToken);

  const response = await fetchImpl(url);
  const body = await readJson<LongTokenResponse>(response);

  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "bearer",
    authMode: "instagram",
    userId: options.userId,
    pageId: options.pageId,
    expiresAt: expiresAtIso(body.expires_in, options.now),
  };
}

export function getScopePresets(authMode: AuthMode) {
  return authMode === "facebook" ? FACEBOOK_SCOPE_PRESETS : SCOPE_PRESETS;
}

export function defaultScopesForAuthMode(authMode: AuthMode): string[] {
  return authMode === "facebook" ? [...FACEBOOK_ANALYTICS_SCOPES] : [...DEFAULT_ANALYTICS_SCOPES];
}

function buildFacebookAuthUrl(options: BuildAuthUrlOptions): URL {
  const url = new URL(`https://www.facebook.com/${normalizeVersion(options.graphApiVersion ?? "v25.0")}/dialog/oauth`);
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? defaultScopesForAuthMode("facebook")).join(","));

  if (options.forceReauth) url.searchParams.set("auth_type", "rerequest");

  return url;
}

async function exchangeFacebookCodeForLongLivedToken(options: ExchangeCodeOptions): Promise<StoredToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const shortToken = await exchangeFacebookCodeForShortToken(options, fetchImpl);
  const longToken = await exchangeFacebookToken({
    accessToken: shortToken.accessToken,
    appId: options.appId,
    appSecret: options.appSecret,
    graphApiVersion: options.graphApiVersion,
    fetchImpl,
  });

  return {
    accessToken: longToken.access_token,
    tokenType: longToken.token_type ?? "bearer",
    authMode: "facebook",
    expiresAt: expiresAtIso(longToken.expires_in, options.now),
  };
}

async function refreshFacebookLongLivedToken(options: RefreshTokenOptions): Promise<StoredToken> {
  if (!options.appId || !options.appSecret) {
    throw new Error("Missing META_INSTAGRAM_APP_ID or META_INSTAGRAM_APP_SECRET for Facebook token refresh.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const longToken = await exchangeFacebookToken({
    accessToken: options.accessToken,
    appId: options.appId,
    appSecret: options.appSecret,
    graphApiVersion: options.graphApiVersion,
    fetchImpl,
  });

  return {
    accessToken: longToken.access_token,
    tokenType: longToken.token_type ?? "bearer",
    authMode: "facebook",
    userId: options.userId,
    pageId: options.pageId,
    expiresAt: expiresAtIso(longToken.expires_in, options.now),
  };
}

async function exchangeFacebookCodeForShortToken(
  options: ExchangeCodeOptions,
  fetchImpl: FetchLike,
): Promise<{ accessToken: string }> {
  const url = facebookOAuthUrl(options.graphApiVersion);
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("client_secret", options.appSecret);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code", options.code);

  const response = await fetchImpl(url);
  const body = await readJson<LongTokenResponse>(response);

  if (!body.access_token) {
    throw new Error("Facebook OAuth response did not include access_token");
  }

  return { accessToken: body.access_token };
}

async function exchangeFacebookToken(options: {
  accessToken: string;
  appId: string;
  appSecret: string;
  graphApiVersion?: string;
  fetchImpl: FetchLike;
}): Promise<LongTokenResponse> {
  const url = facebookOAuthUrl(options.graphApiVersion);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("client_secret", options.appSecret);
  url.searchParams.set("fb_exchange_token", options.accessToken);

  return readJson<LongTokenResponse>(await options.fetchImpl(url));
}

async function exchangeCodeForShortToken(
  options: ExchangeCodeOptions,
  fetchImpl: FetchLike,
): Promise<{ accessToken: string; userId?: string; permissions?: string[] }> {
  const form = new URLSearchParams();
  form.set("client_id", options.appId);
  form.set("client_secret", options.appSecret);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", options.redirectUri);
  form.set("code", options.code);

  const response = await fetchImpl("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await readJson<ShortTokenResponse>(response);
  const token = body.data?.[0] ?? body;

  if (!token.access_token) {
    throw new Error("Instagram OAuth response did not include access_token");
  }

  return {
    accessToken: token.access_token,
    userId: token.user_id,
    permissions: token.permissions
      ?.split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = typeof body?.error_message === "string"
      ? body.error_message
      : typeof body?.error?.message === "string"
        ? body.error.message
        : `HTTP ${response.status}`;
    throw new Error(`Meta OAuth request failed: ${message}`);
  }

  return body as T;
}

function facebookOAuthUrl(graphApiVersion: string | undefined): URL {
  return new URL(`https://graph.facebook.com/${normalizeVersion(graphApiVersion ?? "v25.0")}/oauth/access_token`);
}

function expiresAtIso(expiresInSeconds: number | undefined, now: Date = new Date()): string | undefined {
  if (expiresInSeconds === undefined) return undefined;
  return new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
}

function normalizeVersion(version: string): string {
  return version.replace(/^\/+|\/+$/g, "");
}
