import type { MetaInstagramConfig } from "./config.js";
import { MetaClient, type FacebookPageClient } from "./meta-client.js";
import { defaultScopesForAuthMode, type AuthMode } from "./oauth.js";
import { loadStoredToken, type StoredInstagramToken } from "./token-store.js";

export interface AccountContextTokenStore {
  load(): Promise<StoredInstagramToken | undefined>;
}

export interface ApiAccountContext {
  authMode: AuthMode;
  accountBinding: string;
  instagramUserId: string;
  facebookPageId?: string;
  requestedScopes: string[];
  confirmedScopes?: string[];
  scopeStatus: "confirmed" | "unknown";
  userClient: MetaClient;
  /** Present only for Facebook Login with a resolved Page; its access token stays private in MetaClient. */
  pageClient?: FacebookPageClient["client"];
  pageTasks?: string[];
}

export interface AccountContextResolverOptions {
  config: MetaInstagramConfig;
  tokenStore?: AccountContextTokenStore;
  clientFactory?: (accessToken: string, authMode: AuthMode) => MetaClient;
}

export type AccountContextResolver = () => Promise<ApiAccountContext>;

/** Resolves the active account without returning bearer credentials in metadata. */
export function createAccountContextResolver(options: AccountContextResolverOptions): AccountContextResolver {
  const store = options.tokenStore ?? { load: () => loadStoredToken(options.config.tokenStorePath) };
  const makeClient = options.clientFactory ?? ((accessToken: string, authMode: AuthMode) => new MetaClient({
    accessToken,
    apiVersion: options.config.graphApiVersion,
    baseUrl: authMode === "facebook" ? "https://graph.facebook.com" : "https://graph.instagram.com"
  }));

  return async () => {
    const stored = await store.load();
    const useEnvironmentToken = Boolean(options.config.accessToken);
    const accessToken = options.config.accessToken ?? stored?.accessToken;
    if (!accessToken) throw new Error("No Instagram access token is configured.");
    const authMode = useEnvironmentToken ? options.config.authMode : stored?.authMode ?? options.config.authMode;
    const instagramUserId = options.config.userId ?? (useEnvironmentToken ? undefined : stored?.userId);
    if (!instagramUserId) throw new Error("Instagram account identity is not resolved.");
    const facebookPageId = options.config.pageId ?? (useEnvironmentToken ? undefined : stored?.pageId);
    const userClient = makeClient(accessToken, authMode);
    let pageClient: MetaClient | undefined;
    let pageTasks: string[] | undefined;
    if (authMode === "facebook" && facebookPageId) {
      const page = await userClient.forFacebookPage(facebookPageId);
      if (page.instagramUserId && page.instagramUserId !== instagramUserId) {
        throw new Error("Resolved Facebook Page belongs to a different Instagram account.");
      }
      pageClient = page.client;
      pageTasks = page.tasks;
    }
    let confirmedScopes = !useEnvironmentToken && Array.isArray(stored?.permissions)
      ? stored.permissions.filter((item): item is string => typeof item === "string")
      : undefined;
    if (!confirmedScopes && authMode === "facebook") {
      try { confirmedScopes = await readGrantedPermissions(userClient); }
      catch { confirmedScopes = undefined; }
    }
    return {
      authMode,
      accountBinding: `instagram:${instagramUserId}`,
      instagramUserId,
      ...(facebookPageId ? { facebookPageId } : {}),
      requestedScopes: [...(options.config.defaultScopes ?? defaultScopesForAuthMode(authMode))],
      ...(confirmedScopes ? { confirmedScopes } : {}),
      scopeStatus: confirmedScopes ? "confirmed" : "unknown",
      userClient,
      ...(pageClient ? { pageClient, pageTasks } : {})
    };
  };
}

async function readGrantedPermissions(client: MetaClient): Promise<string[] | undefined> {
  const response: unknown = await client.get("/me/permissions");
  if (!isRecord(response) || !Array.isArray(response.data)) return undefined;
  const rows = response.data;
  if (!rows.length || rows.some((item) => !isRecord(item) || typeof item.permission !== "string" ||
      !["granted", "declined", "expired"].includes(String(item.status)))) return undefined;
  return rows.filter((item): item is Record<string, unknown> => isRecord(item) && item.status === "granted")
    .map((item) => item.permission as string);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
