import type { MetaInstagramConfig } from "./config.js";
import { isOAuthConfigurationId } from "./oauth.js";

/** Only fixed setup diagnostics are exposed. No credentials, callback URLs or provider errors. */
export function oauthSetupStatus(config: MetaInstagramConfig): { ready: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!config.appId) issues.push("app_id_required");
  if (!config.appSecret) issues.push("app_secret_required");
  if (!config.redirectUri) issues.push("redirect_uri_required");
  if (config.authMode === "unified") {
    if (config.appId && !isOAuthConfigurationId(config.appId)) issues.push("unified_app_id_invalid");
    if (!isOAuthConfigurationId(config.configId)) issues.push("unified_config_id_required");
    let validRedirect = false;
    try { const url = new URL(config.redirectUri ?? ""); validRedirect = url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { /* Fixed diagnostic below. */ }
    if (!validRedirect) issues.push("unified_https_redirect_required");
  }
  return { ready: issues.length === 0, issues };
}

export function assertOAuthSetup(config: MetaInstagramConfig): void {
  const status = oauthSetupStatus(config);
  if (!status.ready) throw new Error(`OAUTH_SETUP_REQUIRED: ${status.issues.join(",")}`);
}
