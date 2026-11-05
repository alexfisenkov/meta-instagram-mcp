import { getScopePresets, type AuthMode } from "./oauth.js";
import { requestJsonHttp } from "./http-json.js";

const SUPPORTED_SCOPES = new Set([...Object.values(getScopePresets("facebook")).flat(), "public_profile", "email"]);

export function isSupportedScopeName(scope: unknown): scope is string {
  return typeof scope === "string" && SUPPORTED_SCOPES.has(scope) && !/^[a-f\d]{32}$/i.test(scope);
}

type Truth = boolean | "unknown";
export interface ExpiryStatus { state: "expires_at" | "no_expiry_reported" | "unknown"; expiresAt?: string }
type Reason = "verification_not_requested" | "no_token" | "unsupported_auth_mode" | "missing_app_credentials" | "token_store_unavailable"
  | "verification_failed" | "verification_timeout" | "malformed_response" | "token_invalid" | "app_mismatch" | "verified";
export interface AuthorizationStatus {
  verification: "not_requested" | "live" | "cached" | "unavailable";
  source: "meta_debug_token" | "none";
  credentialSource: "environment" | "stored" | "none";
  reason: Reason;
  tokenValid: Truth;
  appMatches: Truth;
  scopes: string[];
  tokenExpiry: ExpiryStatus;
  dataAccessExpiry: ExpiryStatus;
  checkedAt?: string;
  freshness?: "fresh" | "cached" | "stale";
}
export interface StatusCredential {
  accessToken?: string;
  appId?: string;
  appSecret?: string;
  authMode: AuthMode;
  graphApiVersion: string;
  credentialSource: AuthorizationStatus["credentialSource"];
  storeUnavailable?: boolean;
}

/** Holds one sanitized proof, bound privately to the credential actually selected for this call. */
export function createAuthorizationStatus() {
  let cached: { credential: StatusCredential; status: AuthorizationStatus; checkedAtMs: number } | undefined;
  let generation = 0;
  return async (credential: StatusCredential, verify = false): Promise<AuthorizationStatus> => {
    if (cached && !sameCredential(cached.credential, credential)) { cached = undefined; generation += 1; }
    const unknown = (reason: Reason, verification: AuthorizationStatus["verification"] = "unavailable"): AuthorizationStatus => ({
      verification, source: "none", credentialSource: credential.credentialSource, reason, tokenValid: "unknown", appMatches: "unknown", scopes: [],
      tokenExpiry: { state: "unknown" }, dataAccessExpiry: { state: "unknown" }
    });
    if (!verify) {
      return cached ? { ...structuredClone(cached.status), verification: "cached", freshness: Date.now() - cached.checkedAtMs > 300_000 ? "stale" : "cached" }
        : unknown("verification_not_requested", "not_requested");
    }
    // A failed new attempt must not leave an older successful proof looking current.
    cached = undefined;
    const attempt = ++generation;
    if (!credential.accessToken) return unknown(credential.storeUnavailable ? "token_store_unavailable" : "no_token");
    if (credential.authMode !== "facebook") return unknown("unsupported_auth_mode");
    if (!credential.appId || !credential.appSecret) return unknown("missing_app_credentials");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const version = /^v\d+\.\d+$/.test(credential.graphApiVersion) ? credential.graphApiVersion : undefined;
      if (!version) return unknown("verification_failed");
      const url = new URL(`https://graph.facebook.com/${version}/debug_token`);
      url.searchParams.set("input_token", credential.accessToken);
      url.searchParams.set("access_token", `${credential.appId}|${credential.appSecret}`);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("verification_timeout")); }, 5000);
      });
      const response = await Promise.race([requestJsonHttp(url, { method: "GET", headers: { accept: "application/json" },
        timeoutMs: 5000, allowRouteRetry: false, signal: controller.signal }), timeout]);
      if (!response.ok) return unknown("verification_failed");
      const data = isRecord(response.body) ? response.body.data : undefined;
      if (!isRecord(data) || typeof data.is_valid !== "boolean") return unknown("malformed_response");
      const hasAppId = typeof data.app_id === "string" && data.app_id.length > 0;
      if (data.is_valid && !hasAppId) return unknown("malformed_response");
      if (data.is_valid && (!Array.isArray(data.scopes) || !data.scopes.every((scope) => isSupportedScopeName(scope)
        && scope !== credential.accessToken && scope !== credential.appSecret))) {
        return unknown("malformed_response");
      }
      const tokenValid = data.is_valid;
      const appMatches = hasAppId ? data.app_id === credential.appId : "unknown";
      const checkedAtMs = Date.now();
      const status: AuthorizationStatus = {
        verification: "live", source: "meta_debug_token", credentialSource: credential.credentialSource,
        reason: !tokenValid ? "token_invalid" : !appMatches ? "app_mismatch" : "verified", tokenValid, appMatches,
        scopes: data.is_valid ? [...new Set(data.scopes as string[])] : [],
        tokenExpiry: expiry(data.expires_at), dataAccessExpiry: expiry(data.data_access_expires_at),
        checkedAt: new Date(checkedAtMs).toISOString(), freshness: "fresh"
      };
      if (attempt === generation) cached = { credential: { ...credential }, status: structuredClone(status), checkedAtMs };
      return status;
    } catch { return unknown(controller.signal.aborted ? "verification_timeout" : "verification_failed"); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
}

function sameCredential(a: StatusCredential, b: StatusCredential): boolean {
  return a.accessToken === b.accessToken && a.appId === b.appId && a.appSecret === b.appSecret && a.authMode === b.authMode
    && a.credentialSource === b.credentialSource && a.graphApiVersion === b.graphApiVersion;
}
function expiry(value: unknown): ExpiryStatus {
  if (value === 0) return { state: "no_expiry_reported" };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000) return { state: "unknown" };
  return { state: "expires_at", expiresAt: new Date(value * 1000).toISOString() };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
