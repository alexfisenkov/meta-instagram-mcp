import { requestJsonHttp, type JsonHttpRequestInit } from "./http-json.js";

export type AuthMode = "facebook" | "instagram" | "unified";

export interface OAuthToken {
  accessToken: string;
  tokenType?: string;
  authMode?: AuthMode;
  expiresAt?: string;
  userId?: string;
  pageId?: string;
  permissions?: string[];
  clientBusinessId?: string;
}

export function defaultScopesForAuthMode(authMode: AuthMode): string[] {
  return [...getScopePresets(authMode)[authMode === "unified" ? "readOnly" : "analytics"]];
}

export type ScopePreset = "readOnly" | "inbox" | "comments" | "analytics" | "fullStandard";

export function getScopePresets(authMode: AuthMode): Record<ScopePreset, string[]> {
  if (authMode === "unified") {
    return {
      readOnly: ["instagram_basic"],
      inbox: ["instagram_basic", "instagram_manage_messages"],
      comments: ["instagram_basic", "instagram_manage_comments"],
      analytics: ["instagram_basic", "instagram_manage_insights", "instagram_manage_comments"],
      fullStandard: ["instagram_basic", "instagram_manage_insights", "instagram_manage_comments", "instagram_content_publish", "instagram_manage_messages"]
    };
  }
  if (authMode === "facebook") {
    return {
      readOnly: ["instagram_basic", "pages_show_list", "pages_read_engagement"],
      inbox: ["instagram_basic", "pages_show_list", "pages_manage_metadata", "instagram_manage_messages"],
      comments: ["instagram_basic", "instagram_manage_comments"],
      analytics: [
        "instagram_basic",
        "pages_show_list",
        "pages_read_engagement",
        "instagram_manage_insights",
        "instagram_manage_comments"
      ],
      fullStandard: [
        "instagram_basic",
        "pages_show_list",
        "pages_read_engagement",
        "instagram_manage_insights",
        "instagram_manage_comments",
        "pages_manage_metadata",
        "instagram_content_publish",
        "instagram_manage_messages"
      ]
    };
  }
  return {
    readOnly: ["instagram_business_basic"],
    inbox: ["instagram_business_basic", "instagram_business_manage_messages"],
    comments: ["instagram_business_basic", "instagram_business_manage_comments"],
    analytics: [
      "instagram_business_basic",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments"
    ],
    fullStandard: [
      "instagram_business_basic",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
      "instagram_business_content_publish",
      "instagram_business_manage_messages"
    ]
  };
}

export function buildAuthUrl(options: {
  authMode: AuthMode;
  appId: string;
  configId?: string;
  redirectUri: string;
  scopes: string[];
  forceReauth?: boolean;
  enableFacebookLogin?: boolean;
  graphApiVersion?: string;
}): URL {
  if (options.authMode === "unified") {
    if (!isOAuthConfigurationId(options.configId) || !isOAuthConfigurationId(options.appId)) throw new Error("UNIFIED_CONFIG_ID_REQUIRED");
    assertUnifiedRedirect(options.redirectUri);
    const url = new URL("https://www.facebook.com/dialog/oauth");
    for (const [key, value] of Object.entries({ client_id: options.appId, config_id: options.configId,
      redirect_uri: options.redirectUri, response_type: "code", display: "popup", prompt: "login", override_default_response_type: "true" })) url.searchParams.set(key, value);
    return url;
  }
  const url = options.authMode === "facebook"
    ? new URL(`https://www.facebook.com/${options.graphApiVersion ?? "v25.0"}/dialog/oauth`)
    : new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scopes.join(","));
  if (options.forceReauth) {
    if (options.authMode === "facebook") url.searchParams.set("auth_type", "rerequest");
    else url.searchParams.set("force_reauth", "true");
  }
  if (options.authMode === "instagram" && options.enableFacebookLogin !== undefined) {
    url.searchParams.set("enable_fb_login", options.enableFacebookLogin ? "1" : "0");
  }
  return url;
}

export async function exchangeCodeForLongLivedToken(options: {
  authMode: AuthMode;
  code: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphApiVersion: string;
}): Promise<OAuthToken> {
  if (options.authMode === "unified") {
    assertUnifiedRedirect(options.redirectUri);
    const { appId, appSecret, redirectUri, code } = options;
    let result: Record<string, unknown>;
    try {
      result = await graphGet(`https://graph.facebook.com/${options.graphApiVersion}/oauth/access_token`, {
        client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
      });
    } catch { throw new Error("UNIFIED_OAUTH_EXCHANGE_FAILED"); }
    // This is a BISU token, not a Facebook user token to upgrade again.
    return normalizeToken(result, "unified");
  }
  if (options.authMode === "facebook") {
    const shortToken = await graphGet(`https://graph.facebook.com/${options.graphApiVersion}/oauth/access_token`, {
      client_id: options.appId,
      client_secret: options.appSecret,
      redirect_uri: options.redirectUri,
      code: options.code
    });
    const accessToken = requireString(shortToken.access_token, "Facebook short-lived access_token");
    const longToken = await graphGet(`https://graph.facebook.com/${options.graphApiVersion}/oauth/access_token`, {
      grant_type: "fb_exchange_token",
      client_id: options.appId,
      client_secret: options.appSecret,
      fb_exchange_token: accessToken
    });
    return normalizeToken(longToken, "facebook");
  }

  const shortToken = await graphPostForm("https://api.instagram.com/oauth/access_token", {
    client_id: options.appId,
    client_secret: options.appSecret,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
    code: options.code
  });
  const accessToken = requireString(shortToken.access_token, "Instagram short-lived access_token");
  const shortUserId = normalizeUserId(shortToken.user_id);
  if (!shortUserId) throw new Error("OAUTH_IDENTITY_UNVERIFIED");
  const longToken = await graphGet("https://graph.instagram.com/access_token", {
    grant_type: "ig_exchange_token",
    client_secret: options.appSecret,
    access_token: accessToken
  });
  const longUserId = normalizeUserId(longToken.user_id);
  if (longUserId && shortUserId !== longUserId) {
    throw new Error("OAuth identity mismatch.");
  }
  return { ...normalizeToken(longToken, "instagram"), userId: shortUserId };
}

export async function refreshLongLivedToken(options: {
  authMode: AuthMode;
  accessToken: string;
  appId?: string;
  appSecret?: string;
  userId?: string;
  pageId?: string;
  graphApiVersion: string;
}): Promise<OAuthToken> {
  if (options.authMode === "unified") throw new Error("UNIFIED_REAUTH_REQUIRED");
  if (options.authMode === "facebook") {
    if (!options.appId || !options.appSecret) {
      throw new Error("META_INSTAGRAM_APP_ID and META_INSTAGRAM_APP_SECRET are required to refresh Facebook Login tokens.");
    }
    const token = await graphGet(`https://graph.facebook.com/${options.graphApiVersion}/oauth/access_token`, {
      grant_type: "fb_exchange_token",
      client_id: options.appId,
      client_secret: options.appSecret,
      fb_exchange_token: options.accessToken
    });
    return {
      ...normalizeToken(token, "facebook"),
      userId: options.userId,
      pageId: options.pageId
    };
  }

  const token = await graphGet("https://graph.instagram.com/refresh_access_token", {
    grant_type: "ig_refresh_token",
    access_token: options.accessToken
  });
  return {
    ...normalizeToken(token, "instagram"),
    userId: options.userId,
    pageId: options.pageId
  };
}

async function graphGet(urlString: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(urlString);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return requestJson(url, { method: "GET", allowRouteRetry: false });
}

async function graphPostForm(urlString: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  return requestJson(new URL(urlString), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    allowRouteRetry: false
  });
}

async function requestJson(url: URL, init: JsonHttpRequestInit): Promise<Record<string, unknown>> {
  const response = await requestJsonHttp(url, { ...init, headers: { accept: "application/json", ...init.headers } });
  const body = isRecord(response.body) ? response.body : {};
  if (!response.ok || isRecord(body.error)) {
    const message = isRecord(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : `HTTP ${response.status}`;
    throw new Error(`Meta OAuth error: ${message}`);
  }
  return body;
}

function normalizeToken(raw: Record<string, unknown>, authMode: AuthMode): OAuthToken {
  const accessToken = requireString(raw.access_token, "access_token");
  // user_id и permissions приходят в ответе Instagram Login и нужны дальше:
  // callback-server сохраняет userId в токен-стор, иначе аккаунт приходится
  // отдельно доразрешать через meta_resolve_instagram_account. Рефакторинг
  // транспорта их потерял — восстановлено 20.08.2026.
  // A Facebook access token's provider user_id is not an Instagram account id.
  // The Instagram ID is resolved separately from a direct account or Facebook Page.
  const userId = authMode === "instagram" ? normalizeUserId(raw.user_id) : undefined;
  return {
    accessToken,
    tokenType: typeof raw.token_type === "string" ? raw.token_type : "bearer",
    authMode,
    expiresAt: expiresAt(raw.expires_in),
    ...(userId ? { userId } : {}),
    ...(normalizePermissions(raw.permissions) ? { permissions: normalizePermissions(raw.permissions) } : {})
  };
}

function normalizeUserId(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

// Meta отдаёт permissions то массивом, то строкой через запятую — приводим к массиву.
function normalizePermissions(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string");
    return list.length ? list : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function expiresAt(expiresIn: unknown): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return undefined;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

export function assertUnifiedRedirect(value: string): void {
  let redirect: URL;
  try { redirect = new URL(value); } catch { throw new Error("UNIFIED_HTTPS_REDIRECT_REQUIRED"); }
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) throw new Error("UNIFIED_HTTPS_REDIRECT_REQUIRED");
}

export function isOAuthConfigurationId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,63}$/.test(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not returned by Meta.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
