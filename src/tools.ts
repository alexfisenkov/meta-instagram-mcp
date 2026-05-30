import type { AppConfig } from "./config.js";
import { redactToken } from "./config.js";
import { MetaClient } from "./meta-client.js";
import {
  SCOPE_PRESETS,
  type AuthMode,
  buildAuthUrl,
  defaultScopesForAuthMode,
  exchangeCodeForLongLivedToken,
  getScopePresets,
  refreshLongLivedToken,
} from "./oauth.js";
import type { StoredToken } from "./token-store.js";
import { loadStoredToken, saveStoredToken } from "./token-store.js";

interface TokenStoreDependency {
  load: () => Promise<StoredToken | undefined>;
  save: (token: StoredToken) => Promise<void>;
}

export interface ToolHandlerDependencies {
  config: AppConfig;
  tokenStore?: TokenStoreDependency;
  clientFactory?: (accessToken: string, authMode: AuthMode) => MetaClient;
}

export interface AuthStatus {
  config: {
    authMode: AuthMode;
    hasAppId: boolean;
    hasAppSecret: boolean;
    hasRedirectUri: boolean;
    defaultScopes: string[];
    graphApiVersion: string;
    tokenStorePath: string;
    userId?: string;
    pageId?: string;
  };
  envToken?: string;
  storedToken?: {
    accessToken: string;
    tokenType: string;
    authMode?: AuthMode;
    userId?: string;
    username?: string;
    pageId?: string;
    permissions?: string[];
    expiresAt?: string;
  };
}

export function createToolHandlers(dependencies: ToolHandlerDependencies) {
  const store = dependencies.tokenStore ?? {
    load: () => loadStoredToken(dependencies.config.tokenStorePath),
    save: (token: StoredToken) => saveStoredToken(dependencies.config.tokenStorePath, token),
  };
  const makeClient = dependencies.clientFactory ?? ((accessToken: string, authMode: AuthMode) => new MetaClient({
    accessToken,
    apiVersion: dependencies.config.graphApiVersion,
    baseUrl: graphBaseUrl(authMode),
  }));

  async function resolveToken(explicitToken?: string): Promise<{
    accessToken: string;
    authMode: AuthMode;
    userId?: string;
    pageId?: string;
    stored?: StoredToken;
  }> {
    if (explicitToken) return { accessToken: explicitToken, authMode: dependencies.config.authMode };
    if (dependencies.config.accessToken) {
      return {
        accessToken: dependencies.config.accessToken,
        authMode: dependencies.config.authMode,
        userId: dependencies.config.userId,
        pageId: dependencies.config.pageId,
      };
    }

    const stored = await store.load();
    if (!stored?.accessToken) {
      throw new Error("No Instagram access token configured. Set META_INSTAGRAM_ACCESS_TOKEN or run meta_exchange_code first.");
    }

    return {
      accessToken: stored.accessToken,
      authMode: stored.authMode ?? dependencies.config.authMode,
      userId: stored.userId,
      pageId: stored.pageId,
      stored,
    };
  }

  return {
    async authStatus(): Promise<AuthStatus> {
      const stored = await store.load();

      return {
        config: {
          authMode: dependencies.config.authMode,
          hasAppId: Boolean(dependencies.config.appId),
          hasAppSecret: Boolean(dependencies.config.appSecret),
          hasRedirectUri: Boolean(dependencies.config.redirectUri),
          defaultScopes: dependencies.config.defaultScopes ?? defaultScopesForAuthMode(dependencies.config.authMode),
          graphApiVersion: dependencies.config.graphApiVersion,
          tokenStorePath: dependencies.config.tokenStorePath,
          userId: dependencies.config.userId,
          pageId: dependencies.config.pageId,
        },
        envToken: redactToken(dependencies.config.accessToken),
        storedToken: stored
          ? {
              accessToken: redactToken(stored.accessToken) ?? "[redacted]",
              tokenType: stored.tokenType,
              authMode: stored.authMode,
              userId: stored.userId,
              username: stored.username,
              pageId: stored.pageId,
              permissions: stored.permissions,
              expiresAt: stored.expiresAt,
            }
          : undefined,
      };
    },

    scopePresets() {
      const presets = getScopePresets(dependencies.config.authMode);

      return {
        authMode: dependencies.config.authMode,
        default: dependencies.config.defaultScopes ?? defaultScopesForAuthMode(dependencies.config.authMode),
        presets: {
          readOnly: {
            scopes: presets.readOnly,
            purpose: dependencies.config.authMode === "facebook"
              ? "Facebook Login minimum for listing connected Pages and Instagram account identity."
              : "Profile, media list, and account/media insights.",
          },
          analytics: {
            scopes: presets.analytics,
            purpose: "Read-only analytics plus comment reading for media-level review.",
          },
          fullStandard: {
            scopes: presets.fullStandard,
            purpose: "Maximum standard scopes for the selected auth mode. Includes future publish/messages scopes, but this MCP exposes no write tools yet.",
          },
        },
      };
    },

    buildLoginUrl(args: {
      scopes?: string[];
      scopePreset?: keyof typeof SCOPE_PRESETS;
      forceReauth?: boolean;
      enableFacebookLogin?: boolean;
    } = {}) {
      requireConfig(dependencies.config.appId, "META_INSTAGRAM_APP_ID");
      requireConfig(dependencies.config.redirectUri, "META_INSTAGRAM_REDIRECT_URI");

      const scopes = resolveScopes(args.scopes, args.scopePreset, dependencies.config.defaultScopes, dependencies.config.authMode);
      const url = buildAuthUrl({
        authMode: dependencies.config.authMode,
        appId: dependencies.config.appId!,
        redirectUri: dependencies.config.redirectUri!,
        scopes,
        forceReauth: args.forceReauth,
        enableFacebookLogin: args.enableFacebookLogin,
        graphApiVersion: dependencies.config.graphApiVersion,
      });

      return {
        authMode: dependencies.config.authMode,
        url: url.toString(),
        scopes,
        redirectUri: dependencies.config.redirectUri,
      };
    },

    async exchangeCode(args: { code: string; save?: boolean }) {
      requireConfig(dependencies.config.appId, "META_INSTAGRAM_APP_ID");
      requireConfig(dependencies.config.appSecret, "META_INSTAGRAM_APP_SECRET");
      requireConfig(dependencies.config.redirectUri, "META_INSTAGRAM_REDIRECT_URI");

      const token = await exchangeCodeForLongLivedToken({
        authMode: dependencies.config.authMode,
        code: args.code,
        appId: dependencies.config.appId!,
        appSecret: dependencies.config.appSecret!,
        redirectUri: dependencies.config.redirectUri!,
        graphApiVersion: dependencies.config.graphApiVersion,
      });

      if (args.save ?? true) await store.save(token);

      return redactStoredToken(token);
    },

    async refreshToken(args: { accessToken?: string; save?: boolean } = {}) {
      const resolved = await resolveToken(args.accessToken);
      const token = await refreshLongLivedToken({
        authMode: resolved.authMode,
        accessToken: resolved.accessToken,
        appId: dependencies.config.appId,
        appSecret: dependencies.config.appSecret,
        userId: resolved.userId,
        pageId: resolved.pageId,
        graphApiVersion: dependencies.config.graphApiVersion,
      });

      if (args.save ?? true) await store.save({ ...resolved.stored, ...token });

      return redactStoredToken(token);
    },

    async getAccountInfo(args: { accessToken?: string; userId?: string; fields?: string[] } = {}) {
      const resolved = await resolveToken(args.accessToken);
      const userId = resolved.authMode === "facebook"
        ? requireInstagramUserId(args, resolved, dependencies.config)
        : "me";

      return makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(userId)}`, {
        fields: args.fields?.length
          ? args.fields
          : defaultAccountFields(resolved.authMode),
      });
    },

    async listMedia(args: { accessToken?: string; userId?: string; fields?: string[]; limit?: number; after?: string; before?: string } = {}) {
      const resolved = await resolveToken(args.accessToken);
      const userId = resolveInstagramUserId(args, resolved, dependencies.config);

      return makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(userId)}/media`, {
        fields: args.fields?.length
          ? args.fields
          : ["id", "caption", "media_type", "media_product_type", "media_url", "permalink", "thumbnail_url", "timestamp", "like_count", "comments_count"],
        limit: args.limit,
        after: args.after,
        before: args.before,
      });
    },

    async getMedia(args: { accessToken?: string; mediaId: string; fields?: string[] }) {
      const resolved = await resolveToken(args.accessToken);

      return makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(args.mediaId)}`, {
        fields: args.fields?.length
          ? args.fields
          : ["id", "caption", "media_type", "media_product_type", "media_url", "permalink", "thumbnail_url", "timestamp", "like_count", "comments_count", "username", "owner"],
      });
    },

    async listComments(args: { accessToken?: string; mediaId: string; fields?: string[]; limit?: number; after?: string; before?: string }) {
      const resolved = await resolveToken(args.accessToken);

      return makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(args.mediaId)}/comments`, {
        fields: args.fields?.length
          ? args.fields
          : ["id", "text", "timestamp", "username", "like_count"],
        limit: args.limit,
        after: args.after,
        before: args.before,
      });
    },

    async getCommentReplies(args: { accessToken?: string; commentId: string; fields?: string[]; limit?: number; after?: string; before?: string }) {
      const resolved = await resolveToken(args.accessToken);

      return makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(args.commentId)}/replies`, {
        fields: args.fields?.length
          ? args.fields
          : ["id", "text", "timestamp", "username", "like_count"],
        limit: args.limit,
        after: args.after,
        before: args.before,
      });
    },

    async getTopMedia(args: {
      accessToken?: string;
      userId?: string;
      limit?: number;
      after?: string;
      before?: string;
      sortBy?: "engagement" | "like_count" | "comments_count" | "timestamp";
    } = {}) {
      const resolved = await resolveToken(args.accessToken);
      const userId = resolveInstagramUserId(args, resolved, dependencies.config);
      const media = await makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(userId)}/media`, {
        fields: ["id", "caption", "media_type", "media_product_type", "permalink", "timestamp", "like_count", "comments_count"],
        limit: args.limit,
        after: args.after,
        before: args.before,
      });
      const sortBy = args.sortBy ?? "engagement";
      const data = extractDataArray(media)
        .map(toMediaSummary)
        .sort((a, b) => scoreMedia(b, sortBy) - scoreMedia(a, sortBy));

      return {
        sortBy,
        count: data.length,
        data,
        paging: isRecord(media) ? media.paging : undefined,
      };
    },

    async getUserInsights(args: {
      accessToken?: string;
      userId?: string;
      metric?: string;
      period?: string;
      metricType?: string;
      breakdown?: string;
      timeframe?: string;
      since?: string | number;
      until?: string | number;
    } = {}) {
      const resolved = await resolveToken(args.accessToken);
      const userId = resolveInstagramUserId(args, resolved, dependencies.config);

      return makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(userId)}/insights`, {
        metric: args.metric ?? "reach",
        period: args.period ?? "day",
        metricType: args.metricType,
        breakdown: args.breakdown,
        timeframe: args.timeframe,
        since: args.since,
        until: args.until,
      });
    },

    async getPostInsights(args: { accessToken?: string; mediaId: string; metric?: string; period?: string; metricType?: string }) {
      const resolved = await resolveToken(args.accessToken);

      return makeClient(resolved.accessToken, resolved.authMode).get(`/${encodeURIComponent(args.mediaId)}/insights`, {
        metric: args.metric ?? "views,reach,likes,comments,shares,saved,total_interactions",
        period: args.period,
        metricType: args.metricType,
      });
    },

    async listFacebookPages(args: { accessToken?: string; fields?: string[]; limit?: number; after?: string; before?: string } = {}) {
      const resolved = await resolveToken(args.accessToken);
      const client = makeClient(resolved.accessToken, "facebook");

      return client.get("/me/accounts", {
        fields: args.fields?.length
          ? args.fields
          : ["id", "name", "category", "tasks", "instagram_business_account{id,username,name,profile_picture_url}"],
        limit: args.limit,
        after: args.after,
        before: args.before,
      });
    },

    async resolveInstagramAccount(args: { accessToken?: string; pageId?: string; userId?: string; save?: boolean } = {}) {
      const resolved = await resolveToken(args.accessToken);
      const client = makeClient(resolved.accessToken, "facebook");

      if (args.userId) {
        const instagramAccount = requireRecord(await client.get(`/${encodeURIComponent(args.userId)}`, {
          fields: defaultAccountFields("facebook"),
        }), "Instagram account");
        const instagramUserId = toStringValue(instagramAccount.id);

        if (!instagramUserId) {
          throw new Error("Instagram account id was not returned by Meta.");
        }

        if (args.save ?? true) {
          await store.save({
            ...resolved.stored,
            accessToken: resolved.accessToken,
            tokenType: resolved.stored?.tokenType ?? "bearer",
            authMode: "facebook",
            userId: instagramUserId,
            username: toStringValue(instagramAccount.username),
            pageId: resolved.pageId ?? dependencies.config.pageId,
            expiresAt: resolved.stored?.expiresAt,
            permissions: resolved.stored?.permissions,
          });
        }

        return {
          authMode: "facebook",
          resolutionMode: "direct_user_id",
          instagramBusinessAccount: instagramAccount,
          saved: args.save ?? true,
        };
      }

      const selectedPageId = args.pageId ?? resolved.pageId ?? dependencies.config.pageId;
      const page = selectedPageId
        ? await client.get(`/${encodeURIComponent(selectedPageId)}`, {
            fields: ["id", "name", "instagram_business_account{id,username,name,profile_picture_url}"],
          })
        : findPageWithInstagram(await client.get("/me/accounts", {
            fields: ["id", "name", "instagram_business_account{id,username,name,profile_picture_url}"],
            limit: 100,
          }));

      const pageRecord = requireRecord(page, "Facebook Page");
      const instagramAccount = requireRecord(pageRecord.instagram_business_account, "instagram_business_account");
      const instagramUserId = toStringValue(instagramAccount.id);
      const pageId = toStringValue(pageRecord.id);

      if (!instagramUserId || !pageId) {
        throw new Error("Connected Instagram Business account was not found on the selected Facebook Page.");
      }

      if (args.save ?? true) {
        await store.save({
          ...resolved.stored,
          accessToken: resolved.accessToken,
          tokenType: resolved.stored?.tokenType ?? "bearer",
          authMode: "facebook",
          userId: instagramUserId,
          username: toStringValue(instagramAccount.username),
          pageId,
          expiresAt: resolved.stored?.expiresAt,
          permissions: resolved.stored?.permissions,
        });
      }

      return {
        authMode: "facebook",
        resolutionMode: "facebook_page",
        page: pageRecord,
        instagramBusinessAccount: instagramAccount,
        saved: args.save ?? true,
      };
    },

    async rawGet(args: { accessToken?: string; path: string; query?: Record<string, string | number | boolean | undefined> }) {
      const resolved = await resolveToken(args.accessToken);
      return makeClient(resolved.accessToken, resolved.authMode).get(args.path, { query: args.query });
    },
  };
}

function requireConfig(value: string | undefined, name: string): void {
  if (!value) throw new Error(`Missing required config: ${name}`);
}

function resolveScopes(
  scopes?: string[],
  scopePreset?: keyof typeof SCOPE_PRESETS,
  configuredScopes?: string[],
  authMode: AuthMode = "instagram",
): string[] {
  if (scopes?.length) return scopes;
  if (scopePreset) return [...getScopePresets(authMode)[scopePreset]];
  if (configuredScopes?.length) return configuredScopes;
  return defaultScopesForAuthMode(authMode);
}

function redactStoredToken(token: StoredToken) {
  return {
    accessToken: redactToken(token.accessToken),
    tokenType: token.tokenType,
    authMode: token.authMode,
    userId: token.userId,
    pageId: token.pageId,
    permissions: token.permissions,
    expiresAt: token.expiresAt,
  };
}

function graphBaseUrl(authMode: AuthMode): string {
  return authMode === "facebook" ? "https://graph.facebook.com" : "https://graph.instagram.com";
}

function defaultAccountFields(authMode: AuthMode): string[] {
  if (authMode === "facebook") {
    return [
      "id",
      "username",
      "name",
      "profile_picture_url",
      "followers_count",
      "follows_count",
      "media_count",
      "biography",
      "website",
    ];
  }

  return [
    "id",
    "user_id",
    "username",
    "name",
    "account_type",
    "profile_picture_url",
    "followers_count",
    "follows_count",
    "media_count",
  ];
}

function resolveInstagramUserId(
  args: { userId?: string },
  resolved: { authMode: AuthMode; userId?: string },
  config: AppConfig,
): string {
  if (args.userId) return args.userId;
  if (resolved.userId) return resolved.userId;
  if (config.userId) return config.userId;
  if (resolved.authMode === "instagram") return "me";

  throw new Error("Missing Instagram user id. Run meta_resolve_instagram_account after Facebook Login or set META_INSTAGRAM_USER_ID.");
}

function requireInstagramUserId(
  args: { userId?: string },
  resolved: { userId?: string },
  config: AppConfig,
): string {
  const userId = args.userId ?? resolved.userId ?? config.userId;
  if (!userId) {
    throw new Error("Missing Instagram user id. Run meta_resolve_instagram_account after Facebook Login or set META_INSTAGRAM_USER_ID.");
  }

  return userId;
}

function findPageWithInstagram(value: unknown): Record<string, unknown> {
  const page = extractDataArray(value).find((item) => isRecord(item.instagram_business_account));
  if (!page) {
    throw new Error("No connected Instagram Business account found in /me/accounts. Confirm the Instagram account is professional and connected to a Facebook Page.");
  }

  return page;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not returned by Meta.`);
  return value;
}

type MediaSummary = {
  id?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count: number;
  comments_count: number;
  engagement_score: number;
};

function extractDataArray(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.filter(isRecord);
}

function toMediaSummary(media: Record<string, unknown>): MediaSummary {
  const likeCount = toNumber(media.like_count);
  const commentsCount = toNumber(media.comments_count);

  return {
    id: toStringValue(media.id),
    caption: toStringValue(media.caption),
    media_type: toStringValue(media.media_type),
    media_product_type: toStringValue(media.media_product_type),
    permalink: toStringValue(media.permalink),
    timestamp: toStringValue(media.timestamp),
    like_count: likeCount,
    comments_count: commentsCount,
    engagement_score: likeCount + commentsCount,
  };
}

function scoreMedia(media: MediaSummary, sortBy: "engagement" | "like_count" | "comments_count" | "timestamp"): number {
  if (sortBy === "engagement") return media.engagement_score;
  if (sortBy === "like_count") return media.like_count;
  if (sortBy === "comments_count") return media.comments_count;
  return media.timestamp ? Date.parse(media.timestamp) || 0 : 0;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
