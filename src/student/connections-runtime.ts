import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import { StudentVault } from "./vault.js";
import { ConnectionsStore } from "./connections-store.js";
import { ConnectionsProviders } from "./connections-providers.js";
import { connectionFingerprint, loadConnectionsConfig, baseConnectionScopes } from "./connections-config.js";
import { connectionProducts, connectionReadSchema, type ConnectionConfig, type ConnectionGrant, type ConnectionProduct, type ConnectionResource, type DiscoveredResource } from "./connections-types.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const oauth: Record<ConnectionProduct, { authorize: string; token: string; issuer: string }> = {
  twitch: { authorize: "https://id.twitch.tv/oauth2/authorize", token: "https://id.twitch.tv/oauth2/token", issuer: "https://id.twitch.tv/oauth2" },
  linkedin: { authorize: "https://www.linkedin.com/oauth/v2/authorization", token: "https://www.linkedin.com/oauth/v2/accessToken", issuer: "https://www.linkedin.com" },
  google_business_profile: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", issuer: "https://accounts.google.com" },
  x: { authorize: "https://x.com/i/oauth2/authorize", token: "https://api.x.com/2/oauth2/token", issuer: "https://x.com" },
};
const labels = { twitch: "Twitch", linkedin: "LinkedIn", google_business_profile: "Google Business Profile", x: "X" };
const tokenValue = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192 && !/[\x00-\x20\x7f]/.test(v);
const generationKey = (s: Subject, p: ConnectionProduct) => JSON.stringify([s.tenantId, s.sub, p]);
export class ConnectionsRuntime {
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private tickRun?: Promise<void>;
  constructor(readonly store: ConnectionsStore, readonly configs: ConnectionConfig[], readonly providers = new ConnectionsProviders(), readonly platformOrigin = "https://learn.fisenkov.com") {
    const url = new URL(platformOrigin); if (url.origin !== platformOrigin || url.protocol !== "https:") throw new BrokerError("invalid_platform_origin");
  }
  private config(product: ConnectionProduct, subject: Subject): ConnectionConfig {
    const c = this.configs.find(c => c.product === product);
    if (!c) throw new BrokerError("not_configured");
    if (c.product === "x" && !c.billingApproved) throw new BrokerError("billing_unverified");
    if (c.admission !== "live" && !(c.admission === "test" && c.testSubjects.includes(subject.sub))) throw new BrokerError("review_required");
    return c;
  }
  catalog(subject: Subject) {
    return { products: connectionProducts.map(product => {
      let status = "ready"; try { this.config(product, subject); } catch (e) { status = e instanceof BrokerError ? e.code : "not_configured"; }
      return { product, label: labels[product], status, capabilities: [], ...(status !== "ready" ? { reason: status } : {}) };
    }) };
  }
  private projection(resource: ConnectionResource, grant?: ConnectionGrant) {
    let status: string = resource.status, reason = resource.reason;
    try { const c = this.config(resource.product, resource); if (!grant || grant.status !== "active" || grant.fingerprint !== connectionFingerprint(c) || grant.expiresAt <= Date.now() && !grant.refreshToken) { status = "reauth_required"; reason = "reauth_required"; } }
    catch (e) { status = e instanceof BrokerError ? e.code : "not_configured"; reason = status; }
    if (resource.status === "disconnected") { status = "disconnected"; reason = undefined; }
    return { id: resource.id, product: resource.product, status, account: { id: resource.providerId, label: resource.label, kind: resource.kind, ...(resource.parentId ? { parentId: resource.parentId } : {}) }, capabilities: status === "connected" ? resource.capabilities : [], lastSuccessAt: resource.lastSuccessAt, ...(grant ? { expiresAt: new Date(grant.expiresAt).toISOString(), refreshAvailable: Boolean(grant.refreshToken && (grant.refreshExpiresAt === undefined || grant.refreshExpiresAt > Date.now())) } : {}), ...(reason ? { reason } : {}), nextAction: status === "connected" && !reason ? "none" : status === "disconnected" || status === "reauth_required" ? "reconnect" : "contact_operator" };
  }
  async list(subject: Subject) { const db = await this.store.snapshot(); return { connections: db.resources.filter(r => sameSubject(r, subject)).map(r => this.projection(r, db.grants.find(g => g.id === r.grantId && sameSubject(g, subject)))) }; }
  async begin(subject: Subject, product: ConnectionProduct, connectionId?: string) {
    const c = this.config(product, subject), state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 600000;
    await this.store.transaction(d => {
      d.states = d.states.filter(s => s.expiresAt > Date.now());
      if (d.states.filter(s => sameSubject(s, subject)).length >= 10) throw new BrokerError("too_many_oauth_flows");
      const resource = connectionId ? d.resources.find(r => r.id === connectionId && r.product === product && sameSubject(r, subject)) : undefined;
      if (connectionId && !resource) throw new BrokerError("connection_not_found");
      const grant = resource ? d.grants.find(g => g.id === resource.grantId && sameSubject(g, subject)) : undefined;
      if (resource && !grant) throw new BrokerError("connection_not_found");
      d.states.push({ ...subject, product, hash: digest(state), expiresAt, codeVerifier: verifier, fingerprint: connectionFingerprint(c), generation: d.generations[generationKey(subject, product)] ?? 0, ...(resource && grant ? { connectionId: resource.id, expectedProviderId: resource.providerId, expectedActorId: grant.actorId } : {}) });
    });
    const u = new URL(oauth[product].authorize);
    for (const [k, v] of Object.entries({ client_id: c.clientId, redirect_uri: c.callbackUrl, response_type: "code", state, scope: c.scopes.join(" ") })) u.searchParams.set(k, v);
    // Only providers with a documented server-side PKCE exchange receive these parameters.
    if (product === "x" || product === "google_business_profile") { u.searchParams.set("code_challenge", digestBase64(verifier)); u.searchParams.set("code_challenge_method", "S256"); }
    if (product === "google_business_profile") { u.searchParams.set("access_type", "offline"); u.searchParams.set("prompt", "select_account consent"); }
    return { authorizationUrl: u.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }
  async callback(product: ConnectionProduct, input: { state?: string; code?: string; error?: string; issuer?: string }) {
    const target = new URL("/social", this.platformOrigin);
    try {
      if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw new BrokerError("state_rejected");
      const state = await this.store.transaction(d => { const i = d.states.findIndex(s => s.hash === digest(input.state!)); if (i < 0) throw new BrokerError("state_rejected"); return d.states.splice(i, 1)[0]; });
      if (state.product !== product || state.expiresAt <= Date.now()) throw new BrokerError("state_rejected");
      const c = this.config(product, state);
      if (state.fingerprint !== connectionFingerprint(c) || input.issuer !== undefined && input.issuer !== oauth[product].issuer) throw new BrokerError("callback_rejected");
      if (input.error) { target.searchParams.set("social", "cancelled"); return target.toString(); }
      if (!input.code || input.code.length > 4096 || /[\x00-\x1f]/.test(input.code)) throw new BrokerError("callback_rejected");
      const fresh = await this.exchange(c, { grant_type: "authorization_code", code: input.code, redirect_uri: c.callbackUrl, ...(product === "x" || product === "google_business_profile" ? { code_verifier: state.codeVerifier } : {}) });
      if (state.expectedActorId && state.expectedActorId !== fresh.actorId || state.expectedProviderId && !fresh.resources.some(r => r.providerId === state.expectedProviderId)) throw new BrokerError("grant_verification_failed");
      await this.store.transaction(d => {
        if ((d.generations[generationKey(state, product)] ?? 0) !== state.generation) throw new BrokerError("oauth_cancelled");
        const existing = d.grants.find(g => sameSubject(g, state) && g.product === product && g.actorId === fresh.actorId);
        const id = existing?.id ?? randomUUID(), { resources, ...credentials } = fresh;
        const grant: ConnectionGrant = { tenantId: state.tenantId, sub: state.sub, id, product, ...credentials, status: "active" };
        if (existing) Object.assign(existing, grant); else d.grants.push(grant);
        for (const old of d.resources.filter(r => sameSubject(r, state) && r.grantId === id && !resources.some(n => n.providerId === r.providerId))) { old.status = "reauth_required"; old.reason = "resource_access_lost"; old.capabilities = []; }
        for (const resource of resources) {
          const old = d.resources.find(r => sameSubject(r, state) && r.grantId === id && r.providerId === resource.providerId);
          if (state.connectionId && (!old || old.id !== state.connectionId && old.status === "disconnected")) continue;
          const next: ConnectionResource = { tenantId: state.tenantId, sub: state.sub, id: old?.id ?? randomUUID(), grantId: id, product, ...resource, status: "connected", lastSuccessAt: new Date().toISOString() };
          if (old) Object.assign(old, next, { reason: undefined, blockedOperations: undefined }); else d.resources.push(next);
        }
      });
      target.searchParams.set("social", fresh.resources.length ? "connected" : "no_resources");
    } catch (e) { target.searchParams.set("social", "error"); target.searchParams.set("reason", e instanceof BrokerError ? e.code : "operation_failed"); }
    return target.toString();
  }
  private async exchange(c: ConnectionConfig, fields: Record<string, string>, previous?: ConnectionGrant) {
    const form = new URLSearchParams(fields), headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (c.product === "x") headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString("base64")}`;
    else { form.set("client_id", c.clientId); form.set("client_secret", c.clientSecret); }
    const token = await this.providers.http.json(oauth[c.product].token, { method: "POST", headers, body: form });
    if (!tokenValue(token.access_token) || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0 || token.expires_in > 31536000 || token.token_type !== undefined && String(token.token_type).toLowerCase() !== "bearer" || token.token_type === undefined && c.product !== "linkedin") throw new BrokerError("grant_verification_failed");
    let scopes: string[];
    if (typeof token.scope === "string" && token.scope.length <= 4096) scopes = token.scope.split(/[ ,]+/).filter(Boolean);
    else if (c.product === "twitch" && Array.isArray(token.scope)) scopes = token.scope;
    else if (token.scope === undefined && previous) scopes = previous.scopes;
    else if (c.product === "twitch" && token.scope === undefined) scopes = [];
    else throw new BrokerError("grant_verification_failed");
    if (scopes.length > 64 || scopes.some(s => typeof s !== "string" || !/^[-A-Za-z0-9_:/\.]{1,255}$/.test(s))) throw new BrokerError("grant_verification_failed");
    const identity = await this.providers.identity(c, token.access_token, scopes);
    scopes = identity.validatedScopes ?? scopes;
    const required = baseConnectionScopes[c.product].filter(s => s !== "offline.access");
    if (required.some(s => !scopes.includes(s))) throw new BrokerError("permission_unavailable");
    if (previous && identity.actorId !== previous.actorId) throw new BrokerError("grant_verification_failed");
    const refreshToken = token.refresh_token ?? previous?.refreshToken;
    if (refreshToken !== undefined && !tokenValue(refreshToken)) throw new BrokerError("grant_verification_failed");
    if (token.refresh_token_expires_in !== undefined && (!Number.isSafeInteger(token.refresh_token_expires_in) || token.refresh_token_expires_in <= 0 || token.refresh_token_expires_in > 315360000)) throw new BrokerError("grant_verification_failed");
    return { actorId: identity.actorId, resources: identity.resources, accessToken: token.access_token as string, refreshToken, scopes, expiresAt: Date.now() + Math.min(token.expires_in, identity.expiresIn ?? token.expires_in) * 1000, refreshExpiresAt: token.refresh_token_expires_in ? Date.now() + token.refresh_token_expires_in * 1000 : previous?.refreshExpiresAt, fingerprint: connectionFingerprint(c), validatedAt: Date.now() };
  }
  private serial<T>(run: () => Promise<T>): Promise<T> { const result = this.tail.then(run); this.tail = result.catch(() => undefined); return result; }
  /** A stale request may not change a replaced credential, configuration or grant. */
  private unchangedGrant(live: ConnectionGrant | undefined, expected: ConnectionGrant): live is ConnectionGrant {
    if (!live || !sameSubject(live, expected) || live.id !== expected.id || live.product !== expected.product || live.status !== "active" || live.actorId !== expected.actorId || live.accessToken !== expected.accessToken || live.refreshToken !== expected.refreshToken || live.fingerprint !== expected.fingerprint || live.expiresAt !== expected.expiresAt || live.refreshExpiresAt !== expected.refreshExpiresAt || JSON.stringify(live.scopes) !== JSON.stringify(expected.scopes)) return false;
    try { return connectionFingerprint(this.config(expected.product, expected)) === expected.fingerprint; } catch { return false; }
  }
  private async access(subject: Subject, connectionId: string, forceRefresh = false) {
    return this.serial(async () => {
      const db = await this.store.snapshot(), resource = db.resources.find(r => r.id === connectionId && sameSubject(r, subject)), grant = resource ? db.grants.find(g => g.id === resource.grantId && sameSubject(g, subject)) : undefined;
      if (!resource || !grant) throw new BrokerError("connection_not_found");
      const c = this.config(resource.product, subject);
      if (resource.status !== "connected" || grant.status !== "active" || grant.fingerprint !== connectionFingerprint(c)) throw new BrokerError("reauth_required");
      if (forceRefresh && !grant.refreshToken && grant.expiresAt > Date.now()) throw new BrokerError("refresh_unavailable");
      let credentials = grant, resources: DiscoveredResource[];
      // Only provider verification failures can invalidate a shared grant. Local CAS conflicts cannot.
      try {
        if (forceRefresh || grant.expiresAt <= Date.now() || grant.refreshToken && grant.expiresAt <= Date.now() + 60000) {
          if (!grant.refreshToken || grant.refreshExpiresAt !== undefined && grant.refreshExpiresAt <= Date.now()) throw new BrokerError("reauth_required");
          const fresh = await this.exchange(c, { grant_type: "refresh_token", refresh_token: grant.refreshToken }, grant);
          const { resources: discovered, ...fields } = fresh; resources = discovered; credentials = { ...grant, ...fields };
        } else {
          const identity = await this.providers.identity(c, grant.accessToken, grant.scopes);
          if (identity.actorId !== grant.actorId || identity.validatedScopes && !grant.scopes.every(s => identity.validatedScopes!.includes(s))) throw new BrokerError("grant_verification_failed");
          resources = identity.resources; credentials = { ...grant, validatedAt: Date.now() };
        }
      } catch (e) {
        if (e instanceof BrokerError && ["reauth_required", "grant_verification_failed", "permission_unavailable"].includes(e.code)) await this.store.transaction(d => {
          const live = d.grants.find(g => g.id === grant.id && sameSubject(g, subject));
          if (!this.unchangedGrant(live, grant)) return;
          live.status = "reauth_required";
          for (const r of d.resources.filter(r => r.grantId === grant.id && sameSubject(r, subject) && r.status === "connected")) { r.status = "reauth_required"; r.reason = e.code; }
        });
        throw e;
      }
      const outcome = await this.store.transaction(d => {
        const live = d.grants.find(g => g.id === grant.id && sameSubject(g, subject));
        if (!this.unchangedGrant(live, grant)) throw new BrokerError("reauth_required");
        const current = d.resources.find(r => r.id === resource.id && r.grantId === grant.id && r.providerId === resource.providerId && sameSubject(r, subject));
        const requestedConnected = current?.status === "connected";
        let surviving = 0;
        for (const r of d.resources.filter(r => r.grantId === grant.id && sameSubject(r, subject) && r.status === "connected")) {
          const owned = resources.find(found => found.providerId === r.providerId);
          if (!owned) { r.status = "reauth_required"; r.reason = "resource_access_lost"; r.capabilities = []; continue; }
          const resetOptional = forceRefresh && r.id === connectionId;
          Object.assign(r, owned, { capabilities: owned.capabilities.filter(capability => resetOptional || !r.blockedOperations?.includes(capability)) });
          if (resetOptional) { r.blockedOperations = undefined; r.reason = undefined; }
          surviving++;
        }
        // Commit a verified same-actor rotation for still-connected owned siblings even if A vanished.
        // Never revive a locally disconnected resource or retain new credentials without an owned survivor.
        if (surviving) Object.assign(live, credentials);
        else { live.status = "reauth_required"; live.accessToken = ""; live.refreshToken = undefined; }
        return { resource: requestedConnected && current?.status === "connected" ? structuredClone(current) : undefined, reason: requestedConnected ? "resource_access_lost" : "reauth_required" };
      });
      // Throw after the successful sibling credential commit; this is not a provider auth failure.
      if (!outcome.resource) throw new BrokerError(outcome.reason);
      return { c, grant: credentials, resource: outcome.resource };
    });
  }

  async read(subject: Subject, input: unknown) {
    const parsed = connectionReadSchema.parse(input), access = await this.access(subject, parsed.connectionId);
    let data: Record<string, unknown>;
    try { data = await this.providers.read(access.c, access.grant, access.resource, parsed); }
    catch (e) {
      if (e instanceof BrokerError && ["reauth_required", "permission_unavailable", "rate_limited", "billing_required", "provider_unavailable", "provider_response_partial", "resource_not_owned"].includes(e.code)) await this.store.transaction(d => {
        const r = d.resources.find(r => r.id === parsed.connectionId && sameSubject(r, subject)), live = d.grants.find(g => g.id === access.grant.id && sameSubject(g, subject));
        if (!this.unchangedGrant(live, access.grant)) return;
        if (r?.status === "connected") {
          r.reason = e.code;
          if (e.code === "permission_unavailable" && parsed.operation !== "account") { r.blockedOperations = [...new Set([...(r.blockedOperations ?? []), parsed.operation])]; r.capabilities = r.capabilities.filter(capability => capability !== parsed.operation); }
          else if (["reauth_required", "permission_unavailable", "resource_not_owned"].includes(e.code)) r.status = "reauth_required";
        }
      });
      throw e;
    }
    await this.store.transaction(d => { const r = d.resources.find(r => r.id === parsed.connectionId && sameSubject(r, subject)), live = d.grants.find(g => g.id === access.grant.id && sameSubject(g, subject)); if (!r || r.status !== "connected" || !this.unchangedGrant(live, access.grant)) throw new BrokerError("reauth_required"); r.lastSuccessAt = new Date().toISOString(); if (!r.blockedOperations?.length) r.reason = undefined; });
    return data;
  }
  async refresh(subject: Subject, connectionId: string) { await this.access(subject, connectionId, true); return { connection: (await this.list(subject)).connections.find(r => r.id === connectionId) }; }
  async disconnect(subject: Subject, connectionId: string) {
    await this.store.transaction(d => {
      const r = d.resources.find(r => r.id === connectionId && sameSubject(r, subject)); if (!r) throw new BrokerError("connection_not_found");
      r.status = "disconnected"; r.capabilities = []; r.reason = undefined;
      d.generations[generationKey(subject, r.product)] = (d.generations[generationKey(subject, r.product)] ?? 0) + 1;
      if (!d.resources.some(x => x.grantId === r.grantId && x.status === "connected" && sameSubject(x, subject))) { const g = d.grants.find(g => g.id === r.grantId && sameSubject(g, subject)); if (g) { g.status = "disconnected"; g.accessToken = ""; g.refreshToken = undefined; } }
    });
    return { connection: (await this.list(subject)).connections.find(r => r.id === connectionId), providerRevocation: "not_attempted", nextAction: "Provider account settings can revoke this application's shared authorization." };
  }
  /** Twitch requires validation at startup and at least hourly, including idle sessions. */
  async tick() {
    const db = await this.store.snapshot();
    for (const grant of db.grants.filter(g => g.product === "twitch" && g.status === "active")) {
      const resource = db.resources.find(r => r.grantId === grant.id && r.status === "connected" && sameSubject(r, grant));
      if (resource) await this.access(grant, resource.id).catch(() => undefined);
    }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { if (!this.tickRun) this.tickRun = this.tick().catch(() => undefined).finally(() => { this.tickRun = undefined; }); }, 45 * 60000); this.timer.unref(); } }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.tickRun; await this.tail; }
}
function digestBase64(s: string) { return createHash("sha256").update(s).digest("base64url"); }
export async function createConnectionsRuntime(env: NodeJS.ProcessEnv, config: { directory: string; vaultKey: Buffer; platformOrigin: string }) {
  if (!env.META_BROKER_CONNECTIONS_CONFIG_FILE) return undefined;
  const configs = await loadConnectionsConfig(env.META_BROKER_CONNECTIONS_CONFIG_FILE, env, env.META_BROKER_CALLBACK_URL ?? config.platformOrigin);
  const vault = await StudentVault.open(join(config.directory, "connections"), config.vaultKey);
  try { const runtime = new ConnectionsRuntime(new ConnectionsStore(vault), configs, undefined, config.platformOrigin); await runtime.tick(); runtime.start(); return { runtime, close: async () => { await runtime.stop(); await vault.close(); } }; }
  catch (e) { await vault.close(); throw e; }
}
