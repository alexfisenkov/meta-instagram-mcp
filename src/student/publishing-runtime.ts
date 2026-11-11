import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { StudentVault } from "./vault.js";
import { StudentRegistry, configFingerprint } from "./registry.js";
import { PublishingStore } from "./publishing-store.js";
import { PublishingOAuth, loadPublishingOAuthConfig } from "./provider-publishing-oauth.js";
import { PublishingBroker } from "./publishing-broker.js";
import { PublishingProviders } from "./provider-publishing.js";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import type { Access, PublishProduct } from "./publishing-types.js";
export class PublishingRuntime {
    constructor(readonly broker: PublishingBroker, readonly oauth: PublishingOAuth, readonly legacyVault: StudentVault, readonly registry: StudentRegistry, readonly youtubeVault?: StudentVault) {
    }
    private async legacy(subject: Subject) {
        const rows: {
            connectionId: string;
            product: PublishProduct;
            providerId: string;
            label: string;
            status: string;
            scopes: string[];
        }[] = [];
        for (const vault of [this.legacyVault, this.youtubeVault].filter((x): x is StudentVault => Boolean(x))) {
            const db = await vault.snapshot();
            for (const c of db.connections.filter(c => sameSubject(c, subject) && ["instagram", "youtube"].includes(c.product))) {
                const g = db.grants.find(g => g.id === c.grantId && sameSubject(g, subject));
                const cfg = this.registry.get(c.product);
                const available = g?.status === "active" && cfg && g.fingerprint === configFingerprint(cfg) && this.registry.status(c.product, subject) === "ready" && (g.expiresAt === undefined || g.expiresAt * 1000 > Date.now());
                rows.push({ connectionId: c.id, product: c.product as PublishProduct, providerId: c.providerId, label: c.label, status: c.status === "connected" && !available ? "reauth_required" : c.status, scopes: g?.scopes ?? [] });
            }
        }
        return rows;
    }
    private async connectionRows(subject: Subject) {
        const old = await this.legacy(subject), newer = (await this.oauth.list(subject)).connections;
        const merged = old.map(c => {
            const n = newer.find(n => n.product === c.product && n.providerId === c.providerId && n.status === "connected");
            return { id: c.connectionId, product: c.product, providerId: c.providerId, label: c.label, ...(n ? { status: n.status, scopes: n.scopes } : { status: c.status, scopes: c.scopes }), capabilities: n ? n.capabilities : ["account", ...(c.scopes.includes(c.product === "youtube" ? "https://www.googleapis.com/auth/youtube.upload" : "instagram_business_content_publish") || c.product === "instagram" && c.scopes.includes("instagram_content_publish") ? ["publish"] : [])] };
        });
        for (const n of newer)
            if (!old.some(c => c.product === n.product && c.providerId === n.providerId))
                merged.push({ ...n, capabilities: n.capabilities });
        return { connections: merged };
    }
    async list(subject: Subject) {
        const { connections } = await this.connectionRows(subject);
        return { connections: connections.map(c => ({ id: c.id, product: c.product, status: c.status, account: { id: c.providerId, label: c.label }, capabilities: c.status === "connected" ? c.capabilities : [] })) };
    }
    catalog(subject: Subject) {
        const status = this.registry.status("instagram", subject);
        return { products: [{ product: "instagram", label: "Instagram", status, capabilities: [], ...(status !== "ready" ? { reason: status } : {}) }, ...this.oauth.catalog(subject).products] };
    }
    async begin(subject: Subject, product: "youtube" | "tiktok" | "pinterest", connectionId?: string) {
        if (!connectionId)
            return this.oauth.begin(subject, product);
        const row = (await this.connectionRows(subject)).connections.find(c => c.id === connectionId && c.product === product);
        if (!row)
            throw new BrokerError("connection_not_found");
        return this.oauth.begin(subject, product, { providerId: row.providerId, connectionId: row.id });
    }
    async disconnect(subject: Subject, id: string) {
        const rows = (await this.oauth.list(subject)).connections;
        const old = (await this.legacy(subject)).find(c => c.connectionId === id);
        const row = rows.find(c => c.id === id) ?? rows.find(c => old && c.product === old.product && c.providerId === old.providerId);
        if (!row)
            throw new BrokerError("write_connection_not_found");
        await this.oauth.disconnect(subject, row.id);
        const connection = (await this.list(subject)).connections.find(c => c.id === id) ?? (await this.list(subject)).connections.find(c => c.product === row.product && c.account.id === row.providerId);
        return { connection: connection ? { ...connection, id } : undefined, providerRevocation: "not_attempted" };
    }
    async access(subject: Subject, id: string): Promise<Access> {
        const old = (await this.legacy(subject)).find(c => c.connectionId === id);
        const direct = (await this.oauth.list(subject)).connections.find(c => c.id === id);
        let n = direct?.status === "connected" || !old ? await this.oauth.access(subject, id) : undefined;
        if (!n && old) {
            const candidate = (await this.oauth.list(subject)).connections.find(n => n.product === old.product && n.providerId === old.providerId && n.status === "connected");
            if (candidate)
                n = await this.oauth.access(subject, candidate.id);
        }
        if (n)
            return { ...subject, connectionId: id, product: n.product, providerId: n.providerId, label: n.label, accessToken: n.accessToken, scopes: n.scopes, apiVersion: n.product === "youtube" ? "v3" : "v2" };
        for (const vault of [this.legacyVault, this.youtubeVault].filter((x): x is StudentVault => Boolean(x))) {
            const db = await vault.snapshot(), c = db.connections.find(c => c.id === id && sameSubject(c, subject) && ["instagram", "youtube"].includes(c.product));
            if (!c)
                continue;
            const g = db.grants.find(g => g.id === c.grantId && sameSubject(g, subject)), config = this.registry.get(c.product);
            if (c.status !== "connected" || !g || g.status !== "active" || !config || g.fingerprint !== configFingerprint(config) || this.registry.status(c.product, subject) !== "ready" || g.expiresAt !== undefined && g.expiresAt * 1000 <= Date.now())
                throw new BrokerError("reauth_required");
            const credential = vault.credential(g);
            return { ...subject, connectionId: id, product: c.product as PublishProduct, providerId: c.providerId, label: c.label, accessToken: credential.assetTokens[c.providerId] ?? credential.accessToken, scopes: g.scopes, apiVersion: config.apiVersion, family: config.provider };
        }
        throw new BrokerError("connection_not_found");
    }
}
export async function createPublishingRuntime(env: NodeJS.ProcessEnv, config: {
    directory: string;
    vaultKey: Buffer;
    platformOrigin: string;
    registry: StudentRegistry;
}, legacyVault: StudentVault, youtubeVault?: StudentVault): Promise<{
    runtime: PublishingRuntime;
    close(): Promise<void>;
} | undefined> {
    const origin = env.META_BROKER_PUBLISHING_MEDIA_ORIGIN, prefix = env.META_BROKER_PUBLISHING_MEDIA_PATH;
    if (!origin && !prefix && !env.META_BROKER_PUBLISHING_CONFIG_FILE)
        return undefined;
    if (!origin || !prefix)
        throw new BrokerError("missing_publishing_media_config");
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== "https:" || !prefix.startsWith("/") || !prefix.endsWith("/"))
        throw new BrokerError("invalid_publishing_media_config");
    const oauthConfigs = await loadPublishingOAuthConfig(env.META_BROKER_PUBLISHING_CONFIG_FILE, env, env.META_BROKER_CALLBACK_URL ?? config.platformOrigin);
    const directory = join(config.directory, "publishing"), vault = await StudentVault.open(directory, config.vaultKey);
    try {
        for (const name of await readdir(directory)) {
            if (/^\.media-[a-f0-9-]{36}-[a-f0-9-]{36}$/.test(name))
                await unlink(join(directory, name));
        }
        const store = new PublishingStore(vault), oauth = new PublishingOAuth(store, oauthConfigs, undefined, config.platformOrigin);
        let runtime: PublishingRuntime;
        const broker = new PublishingBroker(store, (s, id) => runtime.access(s, id), new PublishingProviders(), { origin, pathPrefix: prefix, maxBytes: 20000000000 }, directory);
        runtime = new PublishingRuntime(broker, oauth, legacyVault, config.registry, youtubeVault);
        return { runtime, close: async () => {
                await broker.stop();
                await vault.close();
            } };
    }
    catch (e) {
        await vault.close();
        throw e;
    }
}
