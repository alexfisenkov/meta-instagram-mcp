import { BrokerError, type CallbackAuditStage, type Connection, type Credential, type Operation, type ProductConfig, type ProviderDiagnostic, type ReadInput } from "./types.js";
import type { DiscoveredAsset, ExchangedGrant, ProviderAdapter, ProviderRead } from "./provider.js";

type Json = Record<string, any>;
export type MetaRequest = (url: URL, init?: RequestInit) => Promise<Json>;
function endpointStage(path: string): CallbackAuditStage {
  if (/\/(?:oauth\/)?access_token$/.test(path)) return "token_exchange";
  if (path.endsWith("/debug_token")) return "token_inspection";
  if (/\/me$/.test(path) || /^\/v[0-9.]+\/[A-Za-z0-9_-]+$/.test(path)) return "account_identity";
  if (/\/assigned_[A-Za-z0-9_]+$/.test(path) || /\/(?:accounts|adaccounts|phone_numbers)$/.test(path)) return "asset_discovery";
  return "api_request";
}
function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined; }
function providerDiagnostic(stage: CallbackAuditStage, status?: unknown, error?: Json): ProviderDiagnostic {
  const result: ProviderDiagnostic = { stage };
  const safeStatus = numeric(status); if (safeStatus !== undefined && safeStatus >= 100 && safeStatus <= 599) result.status = safeStatus;
  const metaCode = numeric(error?.code); if (metaCode !== undefined) result.metaCode = metaCode;
  const metaSubcode = numeric(error?.error_subcode); if (metaSubcode !== undefined) result.metaSubcode = metaSubcode;
  return result;
}
/** No redirects, caller URLs, retry, provider payload errors or environment token fallback. */
export const requestMeta: MetaRequest = async (url, init = {}) => {
  if (url.protocol !== "https:" || !["graph.facebook.com", "graph.threads.com"].includes(url.hostname) || url.port || url.username || url.password) throw new BrokerError("provider_host_rejected");
  const stage = endpointStage(url.pathname);
  let status: number | undefined;
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
    status = response.status;
    if (!response.body) throw new BrokerError("provider_unavailable");
    let size = 0; const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 1_048_576) { await response.body.cancel().catch(() => undefined); throw new BrokerError("provider_response_too_large"); } chunks.push(chunk); }
    let body: Json;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new BrokerError("provider_unavailable", providerDiagnostic(stage, status)); }
    if (!response.ok || body.error) throw new BrokerError(body.error?.code === 190 ? "reauth_required" : [10, 200].includes(body.error?.code) ? "permission_unavailable" : "provider_unavailable", providerDiagnostic(stage, status, record(body.error) ? body.error : undefined));
    if (!record(body)) throw new BrokerError("provider_response_invalid", providerDiagnostic(stage, status)); return body;
  } catch (error) { if (error instanceof BrokerError) { if (!error.diagnostic) throw new BrokerError(error.code, providerDiagnostic(stage, status)); throw error; } throw new BrokerError("provider_unavailable", providerDiagnostic(stage, status)); }
};
function record(x: unknown): x is Json { return x !== null && typeof x === "object" && !Array.isArray(x); }
function id(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new BrokerError("provider_response_invalid"); return value; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value.slice(0, 16_384) : fallback; }
function rows(body: Json): Json[] { if (!Array.isArray(body.data) || body.data.length > 100 || body.data.some((x: unknown) => !record(x))) throw new BrokerError("provider_response_invalid"); return body.data; }
function cursor(body: Json): string | undefined { const after = body.paging?.cursors?.after; return typeof after === "string" && /^[A-Za-z0-9_=-]{1,2048}$/.test(after) ? after : undefined; }
function scalarProjection(row: Json, fields: string[]): Json {
  const result: Json = {}; for (const field of fields) { const value = row[field]; if (typeof value === "string") result[field] = text(value); else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") result[field] = value; } return result;
}
const postFields = { instagram: "id,caption,media_type,permalink,timestamp,like_count,comments_count", facebook: "id,message,created_time,permalink_url", threads: "id,text,media_type,permalink,timestamp" };
function bounded(request: MetaRequest, beforeRequest?: (url: URL) => void): MetaRequest {
  const deadline = Date.now() + 30_000; let remaining = 32;
  return async (url, init = {}) => {
    beforeRequest?.(url);
    if (--remaining < 0 || Date.now() >= deadline) throw new BrokerError("provider_budget_exceeded");
    const result = await request(url, { ...init, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    if (Date.now() >= deadline) throw new BrokerError("provider_budget_exceeded"); return result;
  };
}

export class MetaStudentProvider implements ProviderAdapter {
  constructor(private readonly request: MetaRequest = requestMeta) {}
  private url(config: ProductConfig, path: string, query: Record<string, string> = {}): URL {
    if (!/^\/[A-Za-z0-9_/-]+$/.test(path) || path.includes("..")) throw new BrokerError("provider_path_rejected");
    const url = new URL(`${config.provider === "threads" ? "https://graph.threads.com" : "https://graph.facebook.com"}/${config.apiVersion}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value); return url;
  }
  private get(config: ProductConfig, token: string, path: string, query: Record<string, string> = {}): Promise<Json> {
    return this.request(this.url(config, path, query), { headers: { Authorization: `Bearer ${token}` } });
  }
  async exchange(config: ProductConfig, code: string): Promise<ExchangedGrant> {
    let stage: CallbackAuditStage = "token_exchange";
    try { return await new MetaStudentProvider(bounded(this.request, (url) => { stage = endpointStage(url.pathname); })).exchangeOnce(config, code); }
    catch (error) {
      let codeValue: string | undefined, hasValidDiagnostic = false;
      try {
        if (error instanceof BrokerError) {
          codeValue = error.code;
          const diagnostic = error.diagnostic;
          hasValidDiagnostic = !!diagnostic && typeof diagnostic.stage === "string" && ["state_validation", "callback_validation", "token_exchange", "token_inspection", "account_identity", "asset_discovery", "api_request", "grant_validation", "grant_persist"].includes(diagnostic.stage);
        }
      } catch { throw error; }
      if (codeValue && !hasValidDiagnostic) throw new BrokerError(codeValue, { stage });
      throw error;
    }
  }
  private async exchangeOnce(config: ProductConfig, code: string): Promise<ExchangedGrant> {
    const appKey = config.appSecret;
    let bearer: string, tokenResponse: Json;
    if (config.provider === "threads") {
      const url = new URL("https://graph.threads.com/oauth/access_token");
      tokenResponse = await this.request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.appId, client_secret: appKey, grant_type: "authorization_code", redirect_uri: config.callbackUrl, code }) });
    } else {
      const query = { client_id: config.appId, client_secret: appKey, code, redirect_uri: config.callbackUrl };
      tokenResponse = await this.request(this.url(config, "/oauth/access_token", query));
    }
    if (typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token || tokenResponse.access_token.length > 8192) throw new BrokerError("grant_verification_failed");
    bearer = tokenResponse.access_token;
    if (config.provider === "threads") {
      // Exchange the short-lived Threads grant before saving; no Facebook exchange for BISU.
      const longUrl = new URL("https://graph.threads.com/access_token"); longUrl.searchParams.set("grant_type", "th_exchange_token"); longUrl.searchParams.set("client_secret", config.appSecret);
      tokenResponse = await this.request(longUrl, { headers: { Authorization: `Bearer ${bearer}` } });
      if (typeof tokenResponse.access_token !== "string" || !Number.isSafeInteger(tokenResponse.expires_in) || tokenResponse.expires_in <= 0) throw new BrokerError("grant_verification_failed");
      bearer = tokenResponse.access_token;
    }
    // Both Meta and Threads officially expose token inspection. Actual grants only.
    let appAuth: string;
    if (config.provider === "threads") {
      const appUrl = new URL("https://graph.threads.com/oauth/access_token"); appUrl.searchParams.set("grant_type", "client_credentials"); appUrl.searchParams.set("client_id", config.appId); appUrl.searchParams.set("client_secret", config.appSecret);
      const app = await this.request(appUrl); if (typeof app.access_token !== "string" || !app.access_token) throw new BrokerError("grant_verification_failed"); appAuth = app.access_token;
    } else appAuth = `${config.appId}|${appKey}`;
    let proof = await this.get(config, appAuth, "/debug_token", { input_token: bearer });
    if (config.provider === "facebook_business" && record(proof.data) && proof.data.is_valid === true && String(proof.data.app_id) === config.appId && proof.data.type === "USER") {
      const originalUserId = proof.data.user_id;
      tokenResponse = await this.request(this.url(config, "/oauth/access_token", { grant_type: "fb_exchange_token", client_id: config.appId, client_secret: appKey, fb_exchange_token: bearer }));
      if (typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token) throw new BrokerError("grant_verification_failed");
      bearer = tokenResponse.access_token;
      proof = await this.get(config, appAuth, "/debug_token", { input_token: bearer });
      if (!record(proof.data) || proof.data.type !== "USER" || proof.data.user_id !== originalUserId) throw new BrokerError("grant_verification_failed");
    }
    const p = proof.data;
    if (!record(p) || p.is_valid !== true || String(p.app_id) !== config.appId || !Array.isArray(p.scopes) || p.scopes.some((s: unknown) => typeof s !== "string" || !/^[a-z][a-z0-9_]{1,100}$/.test(s))) throw new BrokerError("grant_verification_failed");
    if ((config.provider === "instagram_unified" && p.type !== "SYSTEM_USER") || (config.provider === "facebook_business" && !["USER", "SYSTEM_USER"].includes(p.type)) || [p.expires_at, p.data_access_expires_at].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0)) || (p.granular_scopes !== undefined && (!Array.isArray(p.granular_scopes) || p.granular_scopes.some((g: unknown) => !record(g) || typeof g.scope !== "string" || (g.target_ids !== undefined && (!Array.isArray(g.target_ids) || g.target_ids.some((target: unknown) => typeof target !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(target)))))))) throw new BrokerError("grant_verification_failed");
    const scopes = [...new Set(p.scopes as string[])]; const assetTokens: Record<string, string> = {}; let assets: DiscoveredAsset[] = [];
    const expiry = [p.expires_at, p.data_access_expires_at].filter((x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0);
    if (Number.isSafeInteger(tokenResponse.expires_in) && tokenResponse.expires_in > 0) expiry.push(Math.floor(Date.now() / 1000) + tokenResponse.expires_in);
    const expiresAt = expiry.length ? Math.min(...expiry) : undefined;
    if (expiresAt !== undefined && expiresAt <= Date.now() / 1000) throw new BrokerError("reauth_required");
    const me = await this.get(config, bearer, "/me", { fields: config.provider === "instagram_unified" ? "id,client_business_id" : config.provider === "threads" ? "id,username" : "id,name" });
    const providerUserId = id(me.id); let clientBusinessId: string | undefined;
    if (p.user_id !== undefined && String(p.user_id) !== providerUserId) throw new BrokerError("grant_verification_failed");
    const has = (scope: string, target?: string) => {
      if (!scopes.includes(scope)) return false;
      const granular = Array.isArray(p.granular_scopes) ? p.granular_scopes.filter((g: Json) => record(g) && g.scope === scope) : [];
      return !target || !granular.length || granular.some((g: Json) => !g.target_ids || (Array.isArray(g.target_ids) && g.target_ids.map(String).includes(target)));
    };
    if (config.provider === "instagram_unified") {
      clientBusinessId = id(me.client_business_id);
      const accounts = await this.all(config, bearer, "/me/assigned_instagram_accounts", { fields: "id,username" });
      assets = accounts.filter((a) => has("instagram_basic", id(a.id))).map((a) => ({ product: "instagram", providerId: id(a.id), label: text(a.username, id(a.id)), capabilities: ["account", "posts", ...(has("instagram_manage_insights", a.id) ? ["metrics" as const] : []), ...(has("instagram_manage_comments", a.id) ? ["comments" as const] : []), ...(has("instagram_manage_messages", a.id) ? ["inbox" as const] : [])] }));
    } else if (config.product === "threads") {
      if (has("threads_basic")) assets = [{ product: "threads", providerId: providerUserId, label: text(me.username, providerUserId), capabilities: ["account", "posts", ...(has("threads_manage_insights") ? ["metrics" as const] : []), ...(has("threads_read_replies") ? ["comments" as const] : [])] }];
    } else if (config.product === "facebook" || config.product === "messenger") {
      const systemUser = p.type === "SYSTEM_USER";
      const pages = await this.all(config, bearer, systemUser ? "/me/assigned_pages" : "/me/accounts", { fields: systemUser ? "id,name,tasks" : "id,name,access_token,tasks" });
      for (const page of pages) {
        const pageId = id(page.id), pageToken = systemUser ? bearer : page.access_token;
        if (typeof pageToken !== "string" || !pageToken || !has("pages_read_engagement", pageId)) continue;
        const capabilities: Operation[] = ["account"];
        if (config.product === "facebook") { capabilities.push("posts"); if (has("pages_read_user_content", pageId)) capabilities.push("comments"); }
        else if (has("pages_messaging", pageId) && has("pages_manage_metadata", pageId)) capabilities.push("inbox");
        const verified = await this.get(config, pageToken, `/${pageId}`, { fields: "id,name" });
        if (id(verified.id) !== pageId) throw new BrokerError("grant_verification_failed");
        assetTokens[pageId] = pageToken; assets.push({ product: config.product, providerId: pageId, label: text(verified.name, pageId), capabilities });
      }
    } else if (config.product === "ads") {
      const accounts = await this.all(config, bearer, "/me/adaccounts", { fields: "id,name,account_id,account_status" });
      assets = accounts.filter((a) => has("ads_read", String(a.account_id)) || has("ads_management", String(a.account_id))).map((a) => ({ product: "ads", providerId: id(a.id), label: text(a.name, id(a.id)), capabilities: ["account", "metrics"] }));
    } else if (config.product === "whatsapp") {
      if (!has("whatsapp_business_management")) throw new BrokerError("permission_unavailable");
      const wabas = await this.all(config, bearer, "/me/assigned_whatsapp_business_accounts", { fields: "id,name" });
      for (const waba of wabas) {
        const wabaId = id(waba.id); if (!has("whatsapp_business_management", wabaId)) continue;
        const phones = await this.all(config, bearer, `/${wabaId}/phone_numbers`, { fields: "id,verified_name,display_phone_number" });
        for (const phone of phones) assets.push({ product: "whatsapp", providerId: id(phone.id), parentId: wabaId, label: text(phone.verified_name, id(phone.id)), capabilities: ["account", ...(has("whatsapp_business_messaging", wabaId) ? ["inbox" as const] : [])] });
      }
    }
    if (!assets.length) throw new BrokerError("no_authorized_assets");
    return { accessToken: bearer, assetTokens, providerUserId, clientBusinessId, scopes, expiresAt, assets };
  }
  async refresh(config: ProductConfig, credential: Credential, expectedUserId?: string): Promise<Credential & { expiresAt: number; scopes: string[] }> {
    return new MetaStudentProvider(bounded(this.request)).refreshOnce(config, credential, expectedUserId);
  }
  private async refreshOnce(config: ProductConfig, credential: Credential, expectedUserId?: string): Promise<Credential & { expiresAt: number; scopes: string[] }> {
    if (config.provider !== "threads" || !credential.accessToken) throw new BrokerError("refresh_unsupported");
    if (!expectedUserId) throw new BrokerError("grant_verification_failed");
    const url = new URL("https://graph.threads.com/refresh_access_token"); url.searchParams.set("grant_type", "th_refresh_token");
    const result = await this.request(url, { headers: { Authorization: `Bearer ${credential.accessToken}` } });
    if (typeof result.access_token !== "string" || !result.access_token || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0) throw new BrokerError("reauth_required");
    const bearer = result.access_token;
    const appUrl = new URL("https://graph.threads.com/oauth/access_token"); appUrl.searchParams.set("grant_type", "client_credentials"); appUrl.searchParams.set("client_id", config.appId); appUrl.searchParams.set("client_secret", config.appSecret);
    const app = await this.request(appUrl); if (typeof app.access_token !== "string" || !app.access_token) throw new BrokerError("grant_verification_failed");
    const proof = await this.get(config, app.access_token, "/debug_token", { input_token: bearer }), p = proof.data;
    if (!record(p) || p.is_valid !== true || String(p.app_id) !== config.appId || p.user_id !== expectedUserId || !Array.isArray(p.scopes) || !p.scopes.includes("threads_basic") || p.scopes.some((s: unknown) => typeof s !== "string" || !/^[a-z][a-z0-9_]{1,100}$/.test(s)) || [p.expires_at, p.data_access_expires_at].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0))) throw new BrokerError("grant_verification_failed");
    const expiry: number[] = [Math.floor(Date.now() / 1000) + result.expires_in, ...[p.expires_at, p.data_access_expires_at].filter((v) => typeof v === "number" && v > 0)];
    return { accessToken: bearer, assetTokens: {}, expiresAt: Math.min(...expiry), scopes: p.scopes };
  }
  private async all(config: ProductConfig, token: string, path: string, query: Record<string, string>): Promise<Json[]> {
    const result: Json[] = []; let after: string | undefined;
    for (let page = 0; page < 10; page++) { const body = await this.get(config, token, path, { ...query, limit: "100", ...(after ? { after } : {}) }); const chunk = rows(body); result.push(...chunk); const next = cursor(body); if (!next) return result; if (next === after) throw new BrokerError("provider_paging_cycle"); after = next; }
    throw new BrokerError("discovery_exceeds_limit");
  }
  async read(config: ProductConfig, connection: Connection, credential: Credential, input: ReadInput): Promise<ProviderRead> {
    return new MetaStudentProvider(bounded(this.request)).readOnce(config, connection, credential, input);
  }
  private async readOnce(config: ProductConfig, connection: Connection, credential: Credential, input: ReadInput): Promise<ProviderRead> {
    const bearer = credential.assetTokens[connection.providerId] ?? credential.accessToken;
    if (!bearer) throw new BrokerError("reauth_required");
    const root = `/${id(connection.providerId)}`, limit = String(input.limit ?? 20);
    const query = { limit, ...(input.cursor ? { after: input.cursor } : {}) };
    if (input.operation === "account") {
      const fields = connection.product === "instagram" ? "id,username,name,followers_count,media_count" : connection.product === "threads" ? "id,username,name" : connection.product === "ads" ? "id,name,account_id,account_status,currency" : connection.product === "whatsapp" ? "id,verified_name,display_phone_number,quality_rating" : "id,name,fan_count,followers_count";
      const result = await this.get(config, bearer, root, { fields });
      if (id(result.id) !== connection.providerId) throw new BrokerError("grant_verification_failed");
      return { data: scalarProjection(result, fields.split(",")), coverage: "partial", limitations: ["selected_profile_fields_only"] };
    }
    if (input.operation === "posts" || input.operation === "comments") {
      if (!["instagram", "facebook", "threads"].includes(connection.product)) throw new BrokerError("operation_unavailable");
      const product = connection.product as keyof typeof postFields;
      const edge = product === "instagram" ? "media" : product === "threads" ? "threads" : "posts";
      if (input.operation === "comments") {
        if (!input.mediaId || !/^[A-Za-z0-9_-]{1,128}$/.test(input.mediaId)) throw new BrokerError("media_id_required");
        // Membership is proven through this asset's own edge, not by trusting arbitrary object ids.
        const owned = await this.all(config, bearer, `${root}/${edge}`, { fields: "id" });
        if (!owned.some((post) => post.id === input.mediaId)) throw new BrokerError("media_not_owned_or_outside_window");
        const fields = product === "threads" ? "id,text,timestamp,username" : product === "instagram" ? "id,text,timestamp,username,like_count" : "id,message,created_time,like_count";
        const body = await this.get(config, bearer, `/${input.mediaId}/${product === "threads" ? "replies" : "comments"}`, { ...query, fields });
        return this.page(body, fields.split(","), "api_visible_comments_only");
      }
      const body = await this.get(config, bearer, `${root}/${edge}`, { ...query, fields: postFields[product] });
      return this.page(body, postFields[product].split(","), "api_visible_posts_only");
    }
    if (input.operation === "metrics") {
      let params: Record<string, string>;
      if (connection.product === "instagram") params = { metric: "reach", period: "day" };
      else if (connection.product === "threads") params = { metric: "views,likes,replies,reposts,quotes,followers_count" };
      else if (connection.product === "ads") params = { fields: "account_id,account_name,impressions,clicks,reach,spend,account_currency,date_start,date_stop", date_preset: "last_30d", level: "account" };
      else throw new BrokerError("operation_unavailable");
      const body = await this.get(config, bearer, `${root}/${connection.product === "threads" ? "threads_insights" : "insights"}`, { ...query, ...params });
      const items = rows(body).map((r) => ({ ...scalarProjection(r, ["name", "period", "title", "description", "account_id", "account_name", "impressions", "clicks", "reach", "spend", "account_currency", "date_start", "date_stop"]), ...(Array.isArray(r.values) ? { values: r.values.slice(0, 100).map((v: Json) => scalarProjection(v, ["value", "end_time"])) } : {}), ...(record(r.total_value) ? { totalValue: scalarProjection(r.total_value, ["value"]) } : {}) }));
      return { data: { items, ...(cursor(body) ? { nextCursor: cursor(body) } : {}) }, coverage: "partial", limitations: ["fixed_metric_set_and_provider_default_period", "api_metrics_may_differ_from_native_app"] };
    }
    if (input.operation === "inbox" && ["instagram", "messenger"].includes(connection.product)) {
      const body = await this.get(config, bearer, `${root}/conversations`, { ...query, fields: "id,updated_time,message_count", platform: connection.product === "instagram" ? "instagram" : "messenger" });
      return this.page(body, ["id", "updated_time", "message_count"], "conversation_metadata_only_no_message_history");
    }
    throw new BrokerError("operation_unavailable");
  }
  private page(body: Json, fields: string[], limitation: string): ProviderRead { return { data: { items: rows(body).map((r) => scalarProjection(r, fields)), ...(cursor(body) ? { nextCursor: cursor(body) } : {}) }, coverage: "partial", limitations: [limitation] }; }
}
