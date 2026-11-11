import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import { PublishingStore, type PublishingConnection } from "./publishing-store.js";
import { PublishingHttp } from "./provider-publishing-http.js";
const products = ["youtube", "tiktok", "pinterest"] as const;
type Product = typeof products[number];
export interface PublishingOAuthConfig {
    product: Product;
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    admission: "disabled" | "test" | "live";
    testSubjects: string[];
}
const scopes: Record<Product, string[]> = { youtube: ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"], tiktok: ["user.info.basic", "video.publish"], pinterest: ["user_accounts:read", "boards:read", "pins:read", "pins:write"] };
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export async function loadPublishingOAuthConfig(file: string | undefined, env: NodeJS.ProcessEnv, callbackOrigin: string): Promise<PublishingOAuthConfig[]> {
    if (!file)
        return [];
    const ref = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
    const schema = z.object({ version: z.literal(1), products: z.array(z.object({ product: z.enum(products), clientIdEnv: ref, clientSecretEnv: ref, admission: z.enum(["disabled", "test", "live"]), testSubjects: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(100) }).strict()).max(3) }).strict();
    const data = schema.parse(JSON.parse(await readFile(file, "utf8")));
    const seen = new Set();
    const result: PublishingOAuthConfig[] = [];
    for (const row of data.products) {
        if (seen.has(row.product))
            throw new BrokerError("invalid_provider_config");
        seen.add(row.product);
        const clientId = env[row.clientIdEnv], clientSecret = env[row.clientSecretEnv];
        if (!clientId && !clientSecret)
            continue;
        if (!clientId || !clientSecret || !/^[A-Za-z0-9._-]{1,256}$/.test(clientId))
            throw new BrokerError("invalid_provider_config");
        const origin = new URL(callbackOrigin);
        if (origin.protocol !== "https:")
            throw new BrokerError("invalid_callback_url");
        result.push({ ...row, clientId, clientSecret, callbackUrl: `${origin.origin}/social/oauth/${row.product}/callback` });
    }
    return result;
}
export class PublishingOAuth {
    private refreshTail: Promise<unknown> = Promise.resolve();
    constructor(readonly store: PublishingStore, readonly configs: PublishingOAuthConfig[], private readonly http = new PublishingHttp(), private readonly platformOrigin = "https://learn.fisenkov.com") {
    }
    private config(product: Product, subject: Subject) {
        const c = this.configs.find(c => c.product === product);
        if (!c)
            throw new BrokerError("not_configured");
        if (c.admission !== "live" && !(c.admission === "test" && c.testSubjects.includes(subject.sub)))
            throw new BrokerError("review_required");
        return c;
    }
    private fingerprint(c: PublishingOAuthConfig) {
        return digest(JSON.stringify([c.product, c.clientId, c.clientSecret, c.callbackUrl, scopes[c.product]]));
    }
    catalog(subject: Subject) {
        return { products: products.map(product => {
                let status = "ready";
                try {
                    this.config(product, subject);
                }
                catch (e) {
                    status = e instanceof BrokerError ? e.code : "not_configured";
                }
                return { product, label: product === "youtube" ? "YouTube" : product === "tiktok" ? "TikTok" : "Pinterest", status, capabilities: [], ...(status !== "ready" ? { reason: status } : {}) };
            }) };
    }
    async list(subject: Subject) {
        return { connections: (await this.store.snapshot()).connections.filter(c => sameSubject(c, subject)).map(c => ({ id: c.id, product: c.product, providerId: c.providerId, label: c.label, status: c.status, capabilities: c.status === "connected" ? ["account", ...(scopes[c.product].every(s => c.scopes.includes(s)) ? ["publish"] : [])] : [], scopes: c.scopes })) };
    }
    async begin(subject: Subject, product: Product, binding?: {
        providerId: string;
        connectionId: string;
    }) {
        const c = this.config(product, subject), state = randomBytes(32).toString("base64url"), codeVerifier = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 600000;
        await this.store.transaction(d => {
            d.states = d.states.filter(s => s.expiresAt > Date.now());
            if (d.states.filter(s => sameSubject(s, subject)).length >= 10)
                throw new BrokerError("too_many_oauth_flows");
            d.states.push({ ...subject, product, hash: digest(state), expiresAt, codeVerifier, fingerprint: this.fingerprint(c), generation: d.generations[`${subject.tenantId}:${subject.sub}:${product}`] ?? 0, ...(binding ? { expectedProviderId: binding.providerId, connectionId: binding.connectionId } : {}) });
        });
        const u = new URL(product === "youtube" ? "https://accounts.google.com/o/oauth2/v2/auth" : product === "tiktok" ? "https://www.tiktok.com/v2/auth/authorize/" : "https://www.pinterest.com/oauth/");
        u.searchParams.set(product === "tiktok" ? "client_key" : "client_id", c.clientId);
        u.searchParams.set("redirect_uri", c.callbackUrl);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("state", state);
        u.searchParams.set("scope", scopes[product].join(product === "youtube" ? " " : ","));
        if (product === "youtube") {
            u.searchParams.set("access_type", "offline");
            u.searchParams.set("prompt", "select_account consent");
            u.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
            u.searchParams.set("code_challenge_method", "S256");
        }
        return { authorizationUrl: u.toString(), expiresAt: new Date(expiresAt).toISOString() };
    }
    async callback(product: Product, input: {
        state?: string;
        code?: string;
        error?: string;
        issuer?: string;
    }) {
        const target = new URL("/social", this.platformOrigin);
        try {
            if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state))
                throw new BrokerError("state_rejected");
            const state = await this.store.transaction(d => {
                const i = d.states.findIndex(s => s.hash === digest(input.state!));
                if (i < 0)
                    throw new BrokerError("state_rejected");
                const [s] = d.states.splice(i, 1);
                return s;
            });
            const c = this.config(product, state);
            if (state.product !== product || state.expiresAt <= Date.now() || state.fingerprint !== this.fingerprint(c))
                throw new BrokerError("state_rejected");
            if (input.error) {
                target.searchParams.set("social", "cancelled");
                return target.toString();
            }
            if (!input.code || input.code.length > 4096 || product === "youtube" && input.issuer !== "https://accounts.google.com")
                throw new BrokerError("callback_rejected");
            const connection = await this.exchange(c, { grant_type: "authorization_code", code: input.code, redirect_uri: c.callbackUrl, ...(product === "youtube" ? { code_verifier: state.codeVerifier } : {}) });
            if (state.expectedProviderId && state.expectedProviderId !== connection.providerId)
                throw new BrokerError("grant_verification_failed");
            await this.store.transaction(d => {
                if ((d.generations[`${state.tenantId}:${state.sub}:${product}`] ?? 0) !== state.generation)
                    throw new BrokerError("oauth_cancelled");
                const old = d.connections.find(c => sameSubject(c, state) && c.product === product && c.providerId === connection.providerId);
                if (old)
                    Object.assign(old, connection, { status: "connected" });
                else
                    d.connections.push({ ...state, ...connection, id: state.connectionId ?? randomUUID(), status: "connected" });
            });
            target.searchParams.set("social", "connected");
        }
        catch {
            target.searchParams.set("social", "error");
        }
        return target.toString();
    }
    async disconnect(subject: Subject, id: string) {
        await this.store.transaction(d => {
            const c = d.connections.find(c => c.id === id && sameSubject(c, subject));
            if (!c)
                throw new BrokerError("connection_not_found");
            c.status = "disconnected";
            c.accessToken = "";
            c.refreshToken = "";
            const key = `${subject.tenantId}:${subject.sub}:${c.product}`;
            d.generations[key] = (d.generations[key] ?? 0) + 1;
        });
        return { disconnected: true, providerRevocation: "not_attempted" };
    }
    async access(subject: Subject, id: string): Promise<PublishingConnection | undefined> {
        const run = this.refreshTail.then(async () => {
            let c = (await this.store.snapshot()).connections.find(c => c.id === id && sameSubject(c, subject));
            if (!c)
                return undefined;
            const config = this.config(c.product, subject);
            if (c.status !== "connected" || c.configFingerprint !== this.fingerprint(config))
                throw new BrokerError("reauth_required");
            if (c.expiresAt > Date.now() + 60000)
                return c;
            const original = c;
            const fresh = await this.exchange(config, { grant_type: "refresh_token", refresh_token: c.refreshToken }, c);
            await this.store.transaction(d => {
                const stored = d.connections.find(x => x.id === id && sameSubject(x, subject));
                if (!stored || stored.status !== "connected" || stored.accessToken !== original.accessToken)
                    throw new BrokerError("reauth_required");
                Object.assign(stored, fresh);
            });
            return { ...c, ...fresh };
        });
        this.refreshTail = run.catch(() => undefined);
        return run;
    }
    private async exchange(c: PublishingOAuthConfig, fields: Record<string, string>, previous?: PublishingConnection): Promise<Omit<PublishingConnection, "id" | "status" | "tenantId" | "sub">> {
        const p = c.product;
        const form = new URLSearchParams(fields);
        const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
        if (p === "pinterest")
            headers.Authorization = `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`;
        else {
            form.set(p === "tiktok" ? "client_key" : "client_id", c.clientId);
            form.set("client_secret", c.clientSecret);
        }
        const token = await this.http.json(p === "youtube" ? "https://oauth2.googleapis.com/token" : p === "tiktok" ? "https://open.tiktokapis.com/v2/oauth/token/" : "https://api.pinterest.com/v5/oauth/token", { method: "POST", headers, body: form });
        if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 8192 || String(token.token_type).toLowerCase() !== "bearer" || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0 || token.expires_in > 31536000)
            throw new BrokerError("grant_verification_failed");
        if (token.scope !== undefined && (typeof token.scope !== "string" || token.scope.length > 4096))
            throw new BrokerError("grant_verification_failed");
        const granted = typeof token.scope === "string" ? token.scope.split(/[ ,]+/).filter(Boolean).map((s: string) => s === "https://www.googleapis.com/auth/userinfo.profile" ? "profile" : s) : previous?.scopes ?? [];
        if (granted.length > 64 || granted.some((s: string) => !/^[-A-Za-z0-9_:/\.]{1,255}$/.test(s)))
            throw new BrokerError("grant_verification_failed");
        const mandatory = p === "youtube" ? scopes[p].filter(s => !s.endsWith("youtube.upload")) : p === "tiktok" ? ["user.info.basic"] : ["user_accounts:read", "boards:read"];
        if (mandatory.some(s => !granted.includes(s)))
            throw new BrokerError("permission_unavailable");
        const refreshToken = token.refresh_token ?? previous?.refreshToken;
        if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 8192)
            throw new BrokerError("refresh_token_missing");
        const auth = { headers: { Authorization: `Bearer ${token.access_token}` } };
        let providerId: string, label: string;
        if (p === "pinterest") {
            const user = await this.http.json("https://api.pinterest.com/v5/user_account", auth);
            if (typeof user.id !== "string" || !/^\d+$/.test(user.id))
                throw new BrokerError("provider_identity_missing");
            providerId = user.id;
            label = typeof user.username === "string" ? user.username : providerId;
        }
        else if (p === "tiktok") {
            const user = await this.http.json("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", auth);
            if (typeof user.data?.user?.open_id !== "string" || user.data.user.open_id !== token.open_id)
                throw new BrokerError("grant_verification_failed");
            providerId = user.data.user.open_id;
            label = user.data.user.display_name ?? providerId;
        }
        else {
            const user = await this.http.json("https://openidconnect.googleapis.com/v1/userinfo", auth);
            if (typeof user.sub !== "string")
                throw new BrokerError("grant_verification_failed");
            const channels = await this.http.json("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50", auth);
            if (!Array.isArray(channels.items) || channels.items.length !== 1 || channels.nextPageToken || typeof channels.items[0].id !== "string")
                throw new BrokerError("youtube_select_single_channel_required");
            providerId = channels.items[0].id;
            label = channels.items[0].snippet?.title ?? providerId;
        }
        if (typeof providerId !== "string" || !/^[A-Za-z0-9_.-]{1,255}$/.test(providerId) || previous && previous.providerId !== providerId)
            throw new BrokerError("grant_verification_failed");
        return { product: p, providerId, label: String(label).slice(0, 512), scopes: granted, accessToken: token.access_token, refreshToken, expiresAt: Date.now() + token.expires_in * 1000, configFingerprint: this.fingerprint(c) };
    }
}
