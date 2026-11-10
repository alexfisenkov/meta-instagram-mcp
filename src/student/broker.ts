import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authorizationUrl, configFingerprint, LABELS, StudentRegistry } from "./registry.js";
import type { ProviderAdapter } from "./provider.js";
import { StudentVault } from "./vault.js";
import { invalidateGrant } from "./grant-lifecycle.js";
import { eventWithinRetention } from "./retention.js";
import { BrokerError, PRODUCTS, sameSubject, type CallbackAuditEvent, type CallbackAuditSink, type CallbackAuditStage, type Connection, type Grant, type Product, type ProviderDiagnostic, type ReadAuditSink, type ReadInput, type Subject } from "./types.js";
function hash(state: string): string { return createHash("sha256").update(state).digest("hex"); }
function generationKey(subject: Subject, product: Product): string { return JSON.stringify([subject.tenantId, subject.sub, product]); }
function revokeUnusedGrant(vault: StudentVault, grant: Grant): void {
  grant.status = "revoked"; grant.credential = vault.seal(grant, { accessToken: "", assetTokens: {} });
  grant.providerUserId = ""; grant.scopes = []; delete grant.clientBusinessId; delete grant.expiresAt; delete grant.refreshedAt;
}
function safeConnection(c: Connection) { return { id: c.id, product: c.product, status: c.status, account: { id: c.providerId, label: c.label }, capabilities: c.status === "connected" ? c.capabilities : [], updatedAt: c.updatedAt, ...(c.reason ? { reason: c.reason } : {}) }; }
const AUDIT_STAGES = new Set<CallbackAuditStage>(["state_validation", "callback_validation", "token_exchange", "token_short_exchange", "token_long_exchange", "app_token_exchange", "token_refresh", "token_inspection", "account_identity", "asset_discovery", "api_request", "grant_validation", "grant_persist"]);
const AUDIT_REASONS = new Set(["state_rejected", "callback_rejected", "provider_unavailable", "provider_response_too_large", "provider_response_invalid", "provider_budget_exceeded", "provider_paging_cycle", "provider_host_rejected", "provider_path_rejected", "discovery_exceeds_limit", "reauth_required", "permission_unavailable", "grant_verification_failed", "instagram_short_identity_missing", "instagram_short_identity_invalid", "instagram_profile_response_invalid", "instagram_profile_identity_missing", "instagram_profile_identity_invalid", "instagram_short_response_invalid", "instagram_permissions_invalid", "instagram_permissions_unexpected", "instagram_long_response_invalid", "instagram_token_type_invalid", "instagram_token_expiry_invalid", "no_authorized_assets", "oauth_cancelled", "vault_capacity_exceeded", "vault_changed", "vault_closed", "vault_commit_uncertain", "vault_integrity_failed", "vault_too_large", "writer_locked", "review_required", "not_configured", "provider_cancelled", "connected", "callback_failed"]);
for (const reason of ["threads_app_binding_missing", "threads_app_token_invalid", "threads_inspection_response_invalid", "threads_inspection_not_valid", "threads_inspection_type_invalid", "threads_inspection_app_mismatch", "threads_inspection_scopes_invalid", "threads_inspection_identity_invalid", "threads_inspection_expiry_invalid", "threads_inspection_expired", "threads_account_identity_invalid", "threads_identity_mismatch", "threads_expected_identity_missing"]) AUDIT_REASONS.add(reason);
function safeDiagnostic(value: unknown): ProviderDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.stage !== "string" || !AUDIT_STAGES.has(candidate.stage as CallbackAuditStage)) return undefined;
  const result: ProviderDiagnostic = { stage: candidate.stage as CallbackAuditStage };
  for (const key of ["status", "metaCode", "metaSubcode"] as const) {
    const n = candidate[key];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 2_147_483_647 && (key !== "status" || (n >= 100 && n <= 599))) result[key] = n;
  }
  return result;
}
function safeAuditFailure(error: unknown): { reason: string; diagnostic?: ProviderDiagnostic } {
  try {
    if (!(error instanceof BrokerError)) return { reason: "callback_failed" };
    const code = error.code;
    const diagnostic = safeDiagnostic(error.diagnostic);
    return { reason: typeof code === "string" && AUDIT_REASONS.has(code) ? code : "callback_failed", ...(diagnostic ? { diagnostic } : {}) };
  } catch { return { reason: "callback_failed" }; }
}
export class StudentBroker {
  private readonly returnTarget: string;
  constructor(private readonly vault: StudentVault, private readonly registry: StudentRegistry, private readonly provider: ProviderAdapter, platformOrigin: string, private readonly now = Date.now, private readonly audit?: CallbackAuditSink, private readonly readAudit?: ReadAuditSink) {
    const origin = new URL(platformOrigin);
    if (origin.protocol !== "https:" || origin.origin !== platformOrigin || origin.username || origin.password) throw new BrokerError("invalid_platform_origin");
    this.returnTarget = `${origin.origin}/social`;
  }
  catalog(subject: Subject) { return { products: PRODUCTS.map((product) => { const status = this.registry.status(product, subject); return { product, label: LABELS[product], status, capabilities: [], ...(status !== "ready" ? { reason: status } : {}) }; }) }; }
  async list(subject: Subject) {
    const db = await this.vault.snapshot();
    return { connections: db.connections.filter((c) => sameSubject(c, subject)).map((c) => {
      const grant = db.grants.find((g) => g.id === c.grantId && sameSubject(g, subject)); const config = this.registry.get(c.product);
      if (c.status === "connected" && (!grant || grant.status !== "active" || !config || grant.fingerprint !== configFingerprint(config) || (grant.expiresAt !== undefined && grant.expiresAt <= this.now() / 1000))) return safeConnection({ ...c, status: "reauth_required", reason: "grant_unavailable" });
      return safeConnection(c);
    }) };
  }
  async begin(subject: Subject, product: Product) {
    const status = this.registry.status(product, subject); if (status !== "ready") throw new BrokerError(status);
    const config = this.registry.get(product)!; const state = randomBytes(32).toString("base64url"); const expiresAt = this.now() + 600_000;
    await this.vault.transaction((db) => {
      db.states = db.states.filter((s) => s.expiresAt > this.now() && (!sameSubject(s, subject) || s.product !== product));
      if (db.states.filter((s) => sameSubject(s, subject)).length >= 10) throw new BrokerError("too_many_oauth_flows");
      const key = generationKey(subject, product); db.generations[key] = (db.generations[key] ?? 0) + 1;
      db.states.push({ ...subject, hash: hash(state), product, provider: config.provider, configKey: config.key, fingerprint: configFingerprint(config), expiresAt, returnTarget: this.returnTarget, generation: db.generations[key] });
    });
    return { authorizationUrl: authorizationUrl(config, state), expiresAt: new Date(expiresAt).toISOString() };
  }
  async callback(input: { state?: string; code?: string; error?: string }): Promise<string> {
    let outcome: CallbackAuditEvent["outcome"] = "error", recognized: { product: Product } | undefined, stage: CallbackAuditStage = "state_validation", reason = "callback_failed", diagnostic: ProviderDiagnostic | undefined;
    try {
      if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw new BrokerError("state_rejected");
      const state = await this.vault.transaction((db) => { const index = db.states.findIndex((s) => s.hash === hash(input.state!)); if (index < 0) throw new BrokerError("state_rejected"); return db.states.splice(index, 1)[0]; });
      recognized = state;
      stage = "callback_validation";
      const config = this.registry.get(state.product);
      if (state.expiresAt <= this.now() || state.returnTarget !== this.returnTarget || !config || config.key !== state.configKey || config.provider !== state.provider || configFingerprint(config) !== state.fingerprint || this.registry.status(state.product, state) !== "ready") throw new BrokerError("state_rejected");
      if (input.error && !input.code) { outcome = "cancelled"; reason = "provider_cancelled"; }
      else {
        if (!input.code || input.error || input.code.length > 4096) throw new BrokerError("callback_rejected");
        stage = "token_exchange";
        const result = await this.provider.exchange(config, input.code);
        stage = "grant_validation";
        if (!result.accessToken || !result.providerUserId || !result.assets.length || result.assets.some((asset) => asset.product !== state.product || !asset.providerId || !asset.capabilities.includes("account"))) throw new BrokerError("no_authorized_assets");
        const id = randomUUID(), updatedAt = new Date(this.now()).toISOString();
        const binding = { tenantId: state.tenantId, sub: state.sub, id, provider: config.provider };
        const grant: Grant = { ...binding, configKey: config.key, fingerprint: state.fingerprint, providerUserId: result.providerUserId, clientBusinessId: result.clientBusinessId, scopes: result.scopes, expiresAt: result.expiresAt, status: "active", credential: this.vault.seal(binding, { accessToken: result.accessToken, assetTokens: result.assetTokens }), createdAt: updatedAt };
        stage = "grant_persist";
        await this.vault.transaction((db) => {
          if ((db.generations[generationKey(state, state.product)] ?? 0) !== state.generation) throw new BrokerError("oauth_cancelled");
          db.grants.push(grant);
          const confirmed = new Set(result.assets.map((asset) => asset.providerId)); const retiredIds = new Set<string>();
          // Direct Instagram Login grants one account at a time; a separate login must retain the user's other accounts.
          for (const previous of db.connections.filter((c) => config.provider !== "instagram_login" && sameSubject(c, state) && c.product === state.product && !confirmed.has(c.providerId))) {
            previous.status = "disconnected"; previous.capabilities = []; previous.reason = "consent_asset_removed"; previous.updatedAt = updatedAt; retiredIds.add(previous.id);
          }
          db.events = db.events.filter((event) => !retiredIds.has(event.connectionId));
          for (const asset of result.assets) {
            const previous = db.connections.find((c) => sameSubject(c, state) && c.product === asset.product && c.providerId === asset.providerId);
            const connection: Connection = { tenantId: state.tenantId, sub: state.sub, id: previous?.id ?? randomUUID(), grantId: id, ...asset, status: "connected", updatedAt };
            if (previous) Object.assign(previous, connection, { reason: undefined }); else db.connections.push(connection);
          }
          for (const old of db.grants.filter((g) => sameSubject(g, state) && g.id !== id && g.status === "active")) if (!db.connections.some((c) => c.grantId === old.id && c.status === "connected")) revokeUnusedGrant(this.vault, old);
        }); outcome = "connected"; reason = "connected";
      }
    } catch (error) {
      const failure = safeAuditFailure(error); reason = failure.reason; diagnostic = failure.diagnostic; if (diagnostic) stage = diagnostic.stage;
      /* OAuth codes, states, provider payloads and exception messages never leave the boundary. */
    }
    if (recognized && this.audit) {
      const details = outcome === "error" ? diagnostic : undefined;
      try {
        const product = recognized.product;
        if (PRODUCTS.includes(product)) this.audit({ event: "student_oauth_callback", stage: details?.stage ?? stage, product, outcome, reason: AUDIT_REASONS.has(reason) ? reason : "callback_failed", hasCode: typeof input.code === "string" && input.code.length > 0, hasProviderError: typeof input.error === "string" && input.error.length > 0, ...(details?.status !== undefined ? { status: details.status } : {}), ...(details?.metaCode !== undefined ? { metaCode: details.metaCode } : {}), ...(details?.metaSubcode !== undefined ? { metaSubcode: details.metaSubcode } : {}) });
      } catch { /* Audit output must not affect callback behavior. */ }
    }
    return `${this.returnTarget}?meta=${outcome}`;
  }
  async disconnect(subject: Subject, connectionId: string) {
    return this.vault.transaction((db) => {
      const c = db.connections.find((candidate) => candidate.id === connectionId && sameSubject(candidate, subject)); if (!c) throw new BrokerError("connection_not_found");
      c.status = "disconnected"; c.capabilities = []; c.updatedAt = new Date(this.now()).toISOString(); c.reason = "user_disconnected"; db.events = db.events.filter((e) => e.connectionId !== c.id);
      const key = generationKey(subject, c.product); db.generations[key] = (db.generations[key] ?? 0) + 1;
      db.states = db.states.filter((s) => !sameSubject(s, subject) || s.product !== c.product);
      const grant = db.grants.find((g) => g.id === c.grantId && sameSubject(g, subject));
      if (grant && !db.connections.some((other) => other.grantId === grant.id && other.status === "connected")) revokeUnusedGrant(this.vault, grant);
      return { connection: safeConnection(c) };
    }, { allowUncertain: true });
  }
  async read(subject: Subject, input: ReadInput) {
    const db = await this.vault.snapshot(); const c = db.connections.find((candidate) => candidate.id === input.connectionId && sameSubject(candidate, subject)); if (!c) throw new BrokerError("connection_not_found");
    const grant = db.grants.find((g) => g.id === c.grantId && sameSubject(g, subject)); const config = this.registry.get(c.product);
    if (c.status !== "connected" || !grant || grant.status !== "active" || !config || this.registry.status(c.product, subject) !== "ready" || configFingerprint(config) !== grant.fingerprint || (grant.expiresAt !== undefined && grant.expiresAt <= this.now() / 1000)) throw new BrokerError("connection_unavailable");
    if (!c.capabilities.includes(input.operation)) throw new BrokerError("operation_unavailable");
    let result;
    try { result = c.product === "whatsapp" && input.operation === "inbox"
      ? { data: { items: db.events.filter((e) => e.connectionId === c.id && eventWithinRetention(e, this.now())).slice(-(input.limit ?? 20)).map((e) => ({ ...e.data, receivedAt: e.receivedAt })) }, coverage: "partial", limitations: ["webhook_events_since_connection_only", "no_whatsapp_history_api"] }
      : await this.provider.read(config, c, this.vault.credential(grant), input);
    } catch (error) {
      if (this.readAudit && PRODUCTS.includes(c.product) && ["account", "posts", "metrics", "comments", "inbox"].includes(input.operation)) {
        const failure = safeAuditFailure(error), details = failure.diagnostic;
        try { this.readAudit({ event: "student_connection_read_error", product: c.product, operation: input.operation, reason: failure.reason === "callback_failed" ? "read_failed" : failure.reason, ...(details?.status !== undefined ? { status: details.status } : {}), ...(details?.metaCode !== undefined ? { metaCode: details.metaCode } : {}), ...(details?.metaSubcode !== undefined ? { metaSubcode: details.metaSubcode } : {}) }); } catch { /* Диагностика не меняет результат чтения. */ }
      }
      if (error instanceof BrokerError && error.code === "permission_unavailable") {
        // 10/200 — отказ конкретной операции, не доказательство отзыва всего grant.
        await this.vault.transaction((db) => {
          const currentGrant = db.grants.find((g) => g.id === grant.id);
          const selected = db.connections.find((candidate) => candidate.id === c.id && sameSubject(candidate, subject));
          if (!selected || selected.status !== "connected" || selected.grantId !== grant.id || !currentGrant || currentGrant.status !== "active" || JSON.stringify(currentGrant.credential) !== JSON.stringify(grant.credential)) return;
          if (input.operation === "account") { selected.status = "reauth_required"; selected.capabilities = []; selected.reason = "identity_verification_unavailable"; }
          else { selected.capabilities = selected.capabilities.filter((capability) => capability !== input.operation); selected.reason = "operation_permission_unavailable"; }
          selected.updatedAt = new Date(this.now()).toISOString();
        });
      } else if (error instanceof BrokerError && ["reauth_required", "grant_verification_failed"].includes(error.code)) await invalidateGrant(this.vault, grant, "provider_authorization_revoked");
      throw error;
    }
    // A concurrent disconnect invalidates an already-running read before disclosure.
    const current = (await this.vault.snapshot()).connections.find((candidate) => candidate.id === c.id);
    if (!current || current.status !== "connected" || current.grantId !== c.grantId) throw new BrokerError("connection_unavailable");
    return { ...result, source: c.product === "whatsapp" && input.operation === "inbox" ? "meta_webhook" : "meta_graph_api", updatedAt: new Date(this.now()).toISOString() };
  }
}
