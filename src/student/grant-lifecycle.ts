import { BrokerError, type Grant } from "./types.js";
import { StudentVault } from "./vault.js";
import { configFingerprint, StudentRegistry } from "./registry.js";
import type { ProviderAdapter } from "./provider.js";
import { sweepStudentEvents } from "./retention.js";

export async function invalidateGrant(vault: StudentVault, grant: Grant, reason: string): Promise<void> {
  await vault.transaction((db) => {
    const current = db.grants.find((g) => g.id === grant.id);
    if (!current || current.status !== "active" || JSON.stringify(current.credential) !== JSON.stringify(grant.credential)) return;
    current.status = "reauth_required"; current.credential = vault.seal(current, { accessToken: "", assetTokens: {} });
    for (const c of db.connections) if (c.grantId === current.id && c.status === "connected") { c.status = "reauth_required"; c.reason = reason; c.updatedAt = new Date().toISOString(); }
  });
}
/** Only provider-documented refresh flows run here; unsupported grants expire closed. */
export class GrantLifecycle {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private readonly vault: StudentVault, private readonly registry: StudentRegistry, private readonly provider: ProviderAdapter, private readonly now = Date.now) {}
  start(intervalMs: number): void {
    if (this.timer || !Number.isInteger(intervalMs) || intervalMs < 1000) throw new BrokerError("invalid_refresh_interval");
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs); this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } await this.running; }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; }); return this.running;
  }
  private async run(): Promise<void> {
    await sweepStudentEvents(this.vault, this.now());
    for (const grant of (await this.vault.snapshot()).grants.filter((g) => g.status === "active")) {
      const config = this.registry.byKey(grant.configKey);
      if (!config || configFingerprint(config) !== grant.fingerprint) { await invalidateGrant(this.vault, grant, "configuration_changed"); continue; }
      if (grant.provider === "youtube") {
        if (!this.provider.refresh || grant.expiresAt === undefined || grant.expiresAt > this.now() / 1000 + 5 * 60) continue;
        await this.refreshGrant(config, grant);
        continue;
      }
      if (grant.expiresAt !== undefined && grant.expiresAt <= this.now() / 1000) { await invalidateGrant(this.vault, grant, "token_expired"); continue; }
      if (grant.provider !== "threads" || !this.provider.refresh || grant.expiresAt === undefined || grant.expiresAt > this.now() / 1000 + 7 * 86_400 || this.now() - (grant.refreshedAt ?? Date.parse(grant.createdAt)) < 86_400_000) continue;
      await this.refreshGrant(config, grant);
    }
  }
  private async refreshGrant(config: NonNullable<ReturnType<StudentRegistry["byKey"]>>, grant: Grant): Promise<void> {
    try {
      if (!this.provider.refresh) throw new BrokerError("refresh_unsupported");
      const credential = this.vault.credential(grant);
      const refreshed = await this.provider.refresh(config, credential, grant.providerUserId, grant.scopes);
      if (!refreshed.accessToken || !Number.isSafeInteger(refreshed.expiresAt) || refreshed.expiresAt <= this.now() / 1000) throw new BrokerError("reauth_required");
      if (refreshed.scopes && grant.scopes.some((scope) => !refreshed.scopes!.includes(scope))) throw new BrokerError("reauth_required");
      const bearer = refreshed.accessToken, refreshToken = refreshed.refreshToken ?? credential.refreshToken;
      await this.vault.transaction((db) => {
        const current = db.grants.find((g) => g.id === grant.id);
        if (!current || current.status !== "active" || JSON.stringify(current.credential) !== JSON.stringify(grant.credential) || !db.connections.some((c) => c.grantId === grant.id && c.status === "connected")) return;
        current.credential = this.vault.seal(current, { accessToken: bearer, assetTokens: refreshed.assetTokens, ...(refreshToken ? { refreshToken } : {}) }); current.expiresAt = refreshed.expiresAt; current.refreshedAt = this.now();
        if (refreshed.scopes) current.scopes = refreshed.scopes;
      });
    } catch (error) { await invalidateGrant(this.vault, grant, error instanceof BrokerError && ["reauth_required", "permission_unavailable", "grant_verification_failed", "provider_unavailable"].includes(error.code) ? "provider_authorization_revoked" : "refresh_outcome_unknown"); }
  }
}
