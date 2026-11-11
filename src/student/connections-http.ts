import { BrokerError } from "./types.js";
import { responseJson, type ProviderFetch } from "./provider-publishing-http.js";
const endpoints: Record<string, RegExp> = {
  "id.twitch.tv": /^\/oauth2\/(token|validate)$/,
  "api.twitch.tv": /^\/helix\/(users|videos)$/,
  "www.linkedin.com": /^\/oauth\/v2\/(accessToken)$/,
  "api.linkedin.com": /^\/(?:v2\/(userinfo|me)|rest\/(organizationAcls|organizations\/\d+|posts))$/,
  "oauth2.googleapis.com": /^\/token$/,
  "openidconnect.googleapis.com": /^\/v1\/userinfo$/,
  "mybusinessaccountmanagement.googleapis.com": /^\/v1\/accounts$/,
  "mybusinessbusinessinformation.googleapis.com": /^\/v1\/(?:accounts\/\d+\/locations|locations\/\d+)$/,
  "businessprofileperformance.googleapis.com": /^\/v1\/locations\/\d+:fetchMultiDailyMetricsTimeSeries$/,
  "mybusiness.googleapis.com": /^\/v4\/accounts\/\d+\/locations\/\d+\/localPosts$/,
  "api.x.com": /^\/2\/(?:oauth2\/token|users\/(?:me|\d+\/tweets))$/,
};
export function connectionProviderUrl(value: string): URL {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.hash || !endpoints[u.hostname]?.test(u.pathname)) throw new BrokerError("provider_host_rejected");
  return u;
}
/** Same bounded parser/timeout/no-redirect policy as publishing, separate read-only host surface. */
export class ConnectionsHttp {
  constructor(readonly fetcher: ProviderFetch = fetch) {}
  async json(value: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const url = connectionProviderUrl(value), method = (init.method ?? "GET").toUpperCase();
    const tokenEndpoint = url.hostname === "id.twitch.tv" && url.pathname === "/oauth2/token" || url.hostname === "www.linkedin.com" && url.pathname === "/oauth/v2/accessToken" || url.hostname === "oauth2.googleapis.com" && url.pathname === "/token" || url.hostname === "api.x.com" && url.pathname === "/2/oauth2/token";
    if (method !== (tokenEndpoint ? "POST" : "GET")) throw new BrokerError("provider_method_rejected");
    let response: Response;
    try { response = await this.fetcher(value, { ...init, redirect: "error", signal: AbortSignal.timeout(20000) }); }
    catch { throw new BrokerError("provider_unavailable"); }
    const body = await responseJson(response);
    if (tokenEndpoint && response.status === 400 && ["invalid_client", "unauthorized_client"].includes(body.error)) throw new BrokerError("provider_configuration_rejected");
    if (tokenEndpoint && response.status === 400 && (body.error === "invalid_grant" || body.error === "invalid_token" || body.error === "invalid_refresh_token" || init.body instanceof URLSearchParams && init.body.get("grant_type") === "refresh_token")) throw new BrokerError("reauth_required");
    if (tokenEndpoint && response.status === 400 && body.error === "invalid_scope") throw new BrokerError("permission_unavailable");
    if (response.ok && Array.isArray(body.errors) && body.errors.length) throw new BrokerError("provider_response_partial");
    if (!response.ok || body.error) throw new BrokerError(response.status === 401 ? "reauth_required" : response.status === 403 ? "permission_unavailable" : response.status === 429 ? "rate_limited" : response.status === 402 ? "billing_required" : "provider_unavailable");
    return body;
  }
}
