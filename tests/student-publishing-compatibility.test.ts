import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StudentVault } from "../src/student/vault.js";
import { StudentRegistry, configFingerprint } from "../src/student/registry.js";
import { YouTubeStudentProvider } from "../src/student/youtube-provider.js";
import { PublishingStore } from "../src/student/publishing-store.js";
import { PublishingBroker } from "../src/student/publishing-broker.js";
import { PublishingProviders } from "../src/student/provider-publishing.js";
import { PublishingOAuth, type PublishingOAuthConfig } from "../src/student/provider-publishing-oauth.js";
import { PublishingHttp } from "../src/student/provider-publishing-http.js";
import { PublishingRuntime } from "../src/student/publishing-runtime.js";
import type { ProductConfig } from "../src/student/types.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse())
        await c();
});
const readScopes = ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"], uploadScope = "https://www.googleapis.com/auth/youtube.upload";
const config: ProductConfig = { product: "youtube", provider: "youtube", key: "youtube", appId: "synthetic-client", appSecret: "synthetic-test-secret", callbackUrl: "https://broker.example.test/youtube/oauth/callback", apiVersion: "v3", admission: "live", testSubjects: [] };
it("keeps the existing read-only provider exchange and refresh valid after broader same-client consent", async () => {
    const provider = new YouTubeStudentProvider(async (url) => {
        if (url.hostname === "oauth2.googleapis.com")
            return { access_token: "synthetic-broader-token", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600, scope: [...readScopes, uploadScope].join(" ") };
        if (url.hostname === "openidconnect.googleapis.com")
            return { sub: "synthetic-google-sub" };
        return { items: [{ id: "UCsynthetic", snippet: { title: "Synthetic channel" } }] };
    });
    const granted = await provider.exchange(config, "synthetic-code", "v".repeat(43));
    expect(granted.scopes).toContain(uploadScope);
    const refreshed = await provider.refresh(config, { accessToken: "synthetic-old", refreshToken: "synthetic-refresh", assetTokens: {} }, "synthetic-google-sub", readScopes);
    expect(refreshed.scopes).toEqual(readScopes);
});
it("merges YouTube upgrade onto the canonical resource, retains siblings/read grants and prevents cross-owner upgrades", async () => {
    const directory = await mkdtemp(join(tmpdir(), "publishing-compat-")), vault = await StudentVault.open(directory, Buffer.alloc(32, 7)), writeVault = await StudentVault.open(join(directory, "publishing"), Buffer.alloc(32, 7));
    cleanups.push(() => rm(directory, { recursive: true, force: true }), () => vault.close(), () => writeVault.close());
    const subject = { tenantId: "masterskaya", sub: "synthetic-a" }, grantId = randomUUID(), connectionId = randomUUID(), siblingId = randomUUID();
    const binding = { ...subject, id: grantId, provider: "youtube" as const };
    await vault.transaction(d => {
        d.grants.push({ ...binding, configKey: config.key, fingerprint: configFingerprint(config), providerUserId: "synthetic-google-sub", scopes: readScopes, status: "active", credential: vault.seal(binding, { accessToken: "synthetic-read-token", refreshToken: "synthetic-read-refresh", assetTokens: {} }), createdAt: new Date().toISOString() });
        for (const [id, providerId] of [[connectionId, "UCsynthetic"], [siblingId, "UCsibling"]])
            d.connections.push({ ...subject, id, product: "youtube", providerId, label: providerId, status: "connected", capabilities: ["account"], updatedAt: new Date().toISOString(), grantId });
    });
    const baseline = await vault.snapshot();
    const oauthConfig: PublishingOAuthConfig = { product: "youtube", clientId: "synthetic-client", clientSecret: "synthetic-test-secret", callbackUrl: "https://broker.example.test/social/oauth/youtube/callback", admission: "live", testSubjects: [] };
    const http = new PublishingHttp(async (input) => {
        const url = String(input);
        if (url.includes("/token"))
            return Response.json({ access_token: "synthetic-write-token", refresh_token: "synthetic-write-refresh", expires_in: 3600, token_type: "Bearer", scope: [...readScopes, uploadScope].join(" ") });
        if (url.includes("/userinfo"))
            return Response.json({ sub: "synthetic-google-sub" });
        if (url.includes("/channels"))
            return Response.json({ items: [{ id: "UCsynthetic", snippet: { title: "Synthetic channel" } }] });
        throw new Error("unexpected fixture endpoint");
    });
    const store = new PublishingStore(writeVault), oauth = new PublishingOAuth(store, [oauthConfig], http), broker = new PublishingBroker(store, async () => {
        throw new Error("unused");
    }, new PublishingProviders(http), { origin: "https://media.example.test", pathPrefix: "/media/", maxBytes: 1000 }, directory), runtime = new PublishingRuntime(broker, oauth, vault, new StudentRegistry([config]));
    await expect(runtime.begin({ ...subject, sub: "synthetic-other" }, "youtube", connectionId)).rejects.toMatchObject({ code: "connection_not_found" });
    const start = await runtime.begin(subject, "youtube", connectionId);
    expect(new URL(await oauth.callback("youtube", { state: new URL(start.authorizationUrl).searchParams.get("state")!, code: "synthetic-code", issuer: "https://accounts.google.com" })).searchParams.get("social")).toBe("connected");
    const rows = (await runtime.list(subject)).connections;
    expect(rows).toHaveLength(2);
    expect(rows.find(c => c.id === connectionId)).toMatchObject({ account: { id: "UCsynthetic", label: "UCsynthetic" }, capabilities: ["account", "publish"] });
    expect((await runtime.access(subject, connectionId)).accessToken).toBe("synthetic-write-token");
    await runtime.disconnect(subject, connectionId);
    expect((await runtime.access(subject, connectionId)).accessToken).toBe("synthetic-read-token");
    expect(await vault.snapshot()).toEqual(baseline);
    expect((await runtime.list(subject)).connections.find(c => c.id === siblingId)).toMatchObject({ account: { id: "UCsibling", label: "UCsibling" }, status: "connected" });
});
