import { BrokerError, type Connection, type Credential, type Operation, type ProductConfig, type ReadInput } from "./types.js";
import type { MetaRequest } from "./meta-provider.js";
import type { DiscoveredAsset, ExchangedGrant, ProviderRead } from "./provider.js";

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const userInfoEndpoint = "https://openidconnect.googleapis.com/v1/userinfo";
const channelsEndpoint = "https://www.googleapis.com/youtube/v3/channels";
const requestedScopes = ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"];
const allowedScopes = new Set([...requestedScopes, "https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/userinfo.profile"]);
const maxChannelPages = 10;

type Json = Record<string, any>;

function record(value: unknown): value is Json { return value !== null && typeof value === "object" && !Array.isArray(value); }
function googleId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,255}$/.test(value)) throw new BrokerError("provider_response_invalid");
  return value;
}
function safeText(value: unknown, fallback = ""): string { return typeof value === "string" ? value.slice(0, 512) : fallback; }
type ChannelValidationReason = "youtube_channels_response_invalid" | "youtube_channel_row_invalid" | "youtube_channels_cursor_invalid";
function invalidChannels(reason: ChannelValidationReason): never { throw new BrokerError(reason, { stage: "asset_discovery" }); }
function channelRow(value: unknown): Json {
  if (!record(value)) return invalidChannels("youtube_channel_row_invalid");
  let channelId: string;
  try { channelId = googleId(value.id); } catch { return invalidChannels("youtube_channel_row_invalid"); }
  if (!record(value.snippet) || typeof value.snippet.title !== "string") return invalidChannels("youtube_channel_row_invalid");
  return { ...value, id: channelId };
}
function channelItems(body: unknown, priorCount: number): Json[] {
  if (!record(body) || Object.hasOwn(body, "kind") && body.kind !== "youtube#channelListResponse") return invalidChannels("youtube_channels_response_invalid");
  if (Object.hasOwn(body, "pageInfo")) {
    if (!record(body.pageInfo)) return invalidChannels("youtube_channels_response_invalid");
    for (const key of ["totalResults", "resultsPerPage"]) if (Object.hasOwn(body.pageInfo, key) && (!Number.isSafeInteger(body.pageInfo[key]) || body.pageInfo[key] < 0 || body.pageInfo[key] > 2_147_483_647)) return invalidChannels("youtube_channels_response_invalid");
  }
  // Discovery marks items optional and array-typed, not nullable. An omitted array
  // is accepted only with positive response-kind + zero-total proof; {} is never empty.
  const omitted = !Object.hasOwn(body, "items");
  if (omitted ? body.kind !== "youtube#channelListResponse" || !record(body.pageInfo) || body.pageInfo.totalResults !== 0 : !Array.isArray(body.items) || body.items.length > 50) return invalidChannels("youtube_channels_response_invalid");
  const items = omitted ? [] : body.items.map(channelRow);
  if (record(body.pageInfo) && body.pageInfo.totalResults === 0 && (items.length > 0 || priorCount > 0)) return invalidChannels("youtube_channels_response_invalid");
  return items;
}
function grantedScopes(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 4096) throw new BrokerError("grant_verification_failed");
  const raw = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (raw.some((scope) => !allowedScopes.has(scope))) throw new BrokerError("grant_verification_failed");
  const scopes = raw.map((scope) => scope === "https://www.googleapis.com/auth/userinfo.profile" ? "profile" : scope);
  if (requestedScopes.some((scope) => !scopes.includes(scope))) throw new BrokerError("permission_unavailable");
  return [...new Set(scopes)];
}
function expiresAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 31_536_000) throw new BrokerError("grant_verification_failed");
  return Math.floor(Date.now() / 1000) + value;
}

/** Direct Google OAuth and YouTube Data API access; no Meta or owner token fallback. */
export class YouTubeStudentProvider {
  constructor(private readonly request: MetaRequest) {}

  async exchange(config: ProductConfig, code: string, codeVerifier?: string): Promise<ExchangedGrant> {
    if (config.product !== "youtube" || config.provider !== "youtube" || !codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new BrokerError("invalid_provider_config");
    const form = new URLSearchParams({
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: config.callbackUrl,
    });
    const token = await this.request(new URL(tokenEndpoint), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 8192 || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") throw new BrokerError("grant_verification_failed");
    const tokenExpiry = expiresAt(token.expires_in);
    const scopes = grantedScopes(token.scope);
    if (typeof token.refresh_token !== "string" || !token.refresh_token || token.refresh_token.length > 4096) throw new BrokerError("youtube_refresh_token_missing");
    const providerUserId = await this.subject(token.access_token);
    const channels = await this.ownedChannels(token.access_token);
    if (!channels.length) throw new BrokerError("no_authorized_assets");
    const assets: DiscoveredAsset[] = channels.map((channel) => ({ product: "youtube", providerId: channel.id, label: safeText(channel.snippet.title, channel.id), capabilities: ["account"] }));
    return { accessToken: token.access_token, refreshToken: token.refresh_token, assetTokens: {}, providerUserId, scopes, expiresAt: tokenExpiry, assets };
  }

  async refresh(config: ProductConfig, credential: Credential, expectedUserId?: string, expectedScopes?: string[]): Promise<Credential & { expiresAt: number; scopes: string[] }> {
    if (config.product !== "youtube" || config.provider !== "youtube") throw new BrokerError("invalid_provider_config");
    if (!credential.refreshToken) throw new BrokerError("reauth_required");
    if (!expectedUserId || !expectedScopes) throw new BrokerError("grant_verification_failed");
    const form = new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, refresh_token: credential.refreshToken, grant_type: "refresh_token" });
    const token = await this.request(new URL(tokenEndpoint), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 8192 || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") throw new BrokerError("reauth_required");
    const expiry = expiresAt(token.expires_in);
    if (token.scope !== undefined) {
      const scopes = grantedScopes(token.scope);
      if (expectedScopes.some((scope) => !scopes.includes(scope))) throw new BrokerError("reauth_required");
    } else if (requestedScopes.some((scope) => !expectedScopes.includes(scope))) throw new BrokerError("reauth_required");
    const providerUserId = await this.subject(token.access_token);
    if (providerUserId !== expectedUserId) throw new BrokerError("grant_verification_failed");
    if (!(await this.ownedChannels(token.access_token)).length) throw new BrokerError("grant_verification_failed");
    return { accessToken: token.access_token, refreshToken: typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : credential.refreshToken, assetTokens: {}, expiresAt: expiry, scopes: expectedScopes };
  }

  async read(config: ProductConfig, connection: Connection, credential: Credential, input: ReadInput): Promise<ProviderRead> {
    if (config.product !== "youtube" || config.provider !== "youtube" || connection.product !== "youtube") throw new BrokerError("invalid_provider_config");
    if (input.operation !== "account") throw new BrokerError("operation_unavailable");
    if (!credential.accessToken) throw new BrokerError("reauth_required");
    const channel = (await this.ownedChannels(credential.accessToken)).find((item) => item.id === connection.providerId);
    if (!channel) throw new BrokerError("grant_verification_failed");
    const snippet = channel.snippet, statistics = record(channel.statistics) ? channel.statistics : {};
    const data = {
      id: channel.id,
      title: safeText(snippet.title, channel.id),
      ...(typeof snippet.customUrl === "string" ? { customUrl: safeText(snippet.customUrl) } : {}),
      ...(typeof statistics.viewCount === "string" && /^\d{1,24}$/.test(statistics.viewCount) ? { viewCount: statistics.viewCount } : {}),
      ...(typeof statistics.subscriberCount === "string" && /^\d{1,24}$/.test(statistics.subscriberCount) ? { subscriberCount: statistics.subscriberCount } : {}),
      ...(typeof statistics.hiddenSubscriberCount === "boolean" ? { subscriberCountHidden: statistics.hiddenSubscriberCount } : {}),
      ...(typeof statistics.videoCount === "string" && /^\d{1,24}$/.test(statistics.videoCount) ? { videoCount: statistics.videoCount } : {}),
    };
    return { data, coverage: "partial", limitations: ["selected_channel_fields_only"] };
  }

  private async subject(accessToken: string): Promise<string> {
    const response = await this.request(new URL(userInfoEndpoint), { headers: { Authorization: `Bearer ${accessToken}` } });
    return googleId(response.sub);
  }

  private async ownedChannels(accessToken: string): Promise<Json[]> {
    const result: Json[] = [], cursors = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < maxChannelPages; page++) {
      const url = new URL(channelsEndpoint);
      url.searchParams.set("part", "snippet,statistics,contentDetails"); url.searchParams.set("mine", "true"); url.searchParams.set("maxResults", "50");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await this.request(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const rows = channelItems(body, result.length);
      result.push(...rows);
      const next = body.nextPageToken;
      if (next === undefined || next === "") return result;
      if (typeof next !== "string" || !next || next.length > 2048 || /[\u0000-\u001f\u007f]/.test(next)) return invalidChannels("youtube_channels_cursor_invalid");
      if (record(body.pageInfo) && body.pageInfo.totalResults === 0) return invalidChannels("youtube_channels_response_invalid");
      if (cursors.has(next)) return invalidChannels("youtube_channels_cursor_invalid");
      cursors.add(next); pageToken = next;
    }
    throw new BrokerError("discovery_exceeds_limit");
  }
}
