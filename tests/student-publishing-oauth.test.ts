import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudentVault } from "../src/student/vault.js";
import { PublishingStore } from "../src/student/publishing-store.js";
import { PublishingOAuth, type PublishingOAuthConfig } from "../src/student/provider-publishing-oauth.js";
import { PublishingHttp, type ProviderFetch } from "../src/student/provider-publishing-http.js";
import { submitSchema } from "../src/student/publishing-types.js";
const subject = { tenantId: "masterskaya", sub: "synthetic-a" }, other = { tenantId: "masterskaya", sub: "synthetic-b" }, cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse())
        await c();
});
const scopes = { youtube: "openid profile https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload", tiktok: "user.info.basic,video.publish", pinterest: "user_accounts:read,boards:read,pins:read,pins:write" };
async function setup(product: PublishingOAuthConfig["product"], options: {
    partial?: boolean;
    wrongIdentity?: boolean;
    omitId?: boolean;
} = {}) {
    const directory = await mkdtemp(join(tmpdir(), "publishing-oauth-")), vault = await StudentVault.open(directory, Buffer.alloc(32, 1));
    cleanups.push(() => rm(directory, { recursive: true, force: true }), () => vault.close());
    const calls: string[] = [];
    let tokenCalls = 0;
    const fetcher: ProviderFetch = async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/token")) {
            tokenCalls++;
            return Response.json({ access_token: `synthetic-private-${tokenCalls}`, refresh_token: `synthetic-refresh-${tokenCalls}`, token_type: "Bearer", scope: options.partial ? product === "youtube" ? "openid profile https://www.googleapis.com/auth/youtube.readonly" : product === "tiktok" ? "user.info.basic" : "user_accounts:read,boards:read" : scopes[product], expires_in: 3600, open_id: "stable-tiktok-id" });
        }
        if (url.includes("/userinfo"))
            return Response.json({ sub: "stable-google-id" });
        if (url.includes("/channels"))
            return Response.json({ items: [{ id: options.wrongIdentity ? "UCother" : "UCsynthetic", snippet: { title: "Synthetic channel" } }] });
        if (url.includes("/user/info/"))
            return Response.json({ data: { user: { open_id: options.wrongIdentity ? "other-tiktok-id" : "stable-tiktok-id", display_name: "Synthetic user" } }, error: { code: "ok" } });
        if (url.includes("/user_account"))
            return Response.json({ ...(options.omitId ? {} : { id: options.wrongIdentity ? "987" : "123" }), username: "mutable-name" });
        throw new Error("synthetic endpoint missing");
    };
    const config: PublishingOAuthConfig = { product, clientId: "synthetic-client", clientSecret: "synthetic-private-test-secret", callbackUrl: `https://broker.example.test/social/oauth/${product}/callback`, admission: "test", testSubjects: [subject.sub] };
    const store = new PublishingStore(vault);
    return { oauth: new PublishingOAuth(store, [config], new PublishingHttp(fetcher), "https://platform.example.test"), store, vault, directory, calls };
}
async function connect(x: Awaited<ReturnType<typeof setup>>, product: PublishingOAuthConfig["product"], binding?: {
    providerId: string;
    connectionId: string;
}) {
    const begin = await x.oauth.begin(subject, product, binding), state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    return { begin, state, result: await x.oauth.callback(product, { state, code: "synthetic-code", ...(product === "youtube" ? { issuer: "https://accounts.google.com" } : {}) }) };
}
describe("isolated publishing OAuth", () => {
    it.each(["youtube", "tiktok", "pinterest"] as const)("binds %s official consent to owner and one-time state", async (p) => {
        const x = await setup(p), done = await connect(x, p), u = new URL(done.begin.authorizationUrl);
        expect(u.hostname).toBe(p === "youtube" ? "accounts.google.com" : p === "tiktok" ? "www.tiktok.com" : "www.pinterest.com");
        expect(new URL(done.result).searchParams.get("social")).toBe("connected");
        const row = (await x.oauth.list(subject)).connections[0];
        expect(row.providerId).toBe(p === "youtube" ? "UCsynthetic" : p === "tiktok" ? "stable-tiktok-id" : "123");
        expect(await x.oauth.list(other)).toEqual({ connections: [] });
        await expect(x.oauth.access(other, row.id)).resolves.toBeUndefined();
        const before = x.calls.length;
        expect(new URL(await x.oauth.callback(p, { state: done.state, code: "replay" })).searchParams.get("social")).toBe("error");
        expect(x.calls).toHaveLength(before);
        expect(JSON.stringify(await x.oauth.list(subject))).not.toContain("synthetic-private");
    });
    it.each(["youtube", "tiktok", "pinterest"] as const)("retains useful partial %s read grants when optional write consent is declined", async (p) => {
        const x = await setup(p, { partial: true }), done = await connect(x, p);
        expect(new URL(done.result).searchParams.get("social")).toBe("connected");
        const row = (await x.oauth.list(subject)).connections[0];
        expect(row.scopes).not.toContain(p === "youtube" ? "https://www.googleapis.com/auth/youtube.upload" : p === "tiktok" ? "video.publish" : "pins:write");
        expect(row.capabilities).not.toContain("publish");
    });
    it("requires Pinterest native stable account ID, never substituting mutable username", async () => {
        const x = await setup("pinterest", { omitId: true });
        expect(new URL((await connect(x, "pinterest")).result).searchParams.get("social")).toBe("error");
        expect((await x.store.snapshot()).connections).toEqual([]);
    });
    it("rejects a wrong channel on upgrade while preserving previous connections", async () => {
        const x = await setup("youtube", { wrongIdentity: true });
        const done = await connect(x, "youtube", { providerId: "UCsynthetic", connectionId: "11111111-1111-4111-8111-111111111111" });
        expect(new URL(done.result).searchParams.get("social")).toBe("error");
        expect((await x.store.snapshot()).connections).toEqual([]);
    });
    it("does not resurrect disconnected resources through pending callbacks", async () => {
        const x = await setup("pinterest");
        await connect(x, "pinterest");
        const row = (await x.oauth.list(subject)).connections[0];
        const pending = await x.oauth.begin(subject, "pinterest");
        await x.oauth.disconnect(subject, row.id);
        const result = await x.oauth.callback("pinterest", { state: new URL(pending.authorizationUrl).searchParams.get("state")!, code: "synthetic-code" });
        expect(new URL(result).searchParams.get("social")).toBe("error");
        expect((await x.oauth.list(subject)).connections[0].status).toBe("disconnected");
    });
    it("rotates refresh tokens and verifies stable identity after expiry", async () => {
        const x = await setup("tiktok");
        await connect(x, "tiktok");
        const row = (await x.oauth.list(subject)).connections[0];
        await x.store.transaction(d => {
            d.connections[0].expiresAt = 0;
        });
        const refreshed = await x.oauth.access(subject, row.id);
        expect(refreshed?.refreshToken).toBe("synthetic-refresh-2");
        expect(refreshed?.providerId).toBe("stable-tiktok-id");
    });
    it("permits missing disclosureVersion on a noncommercial TikTok request", () => {
        const input = { deliveryId: "11111111-1111-4111-8111-111111111111", intentId: "22222222-2222-4222-8222-222222222222", intentHash: "a".repeat(64), targetHash: "b".repeat(64), connectionId: "33333333-3333-4333-8333-333333333333", product: "tiktok", asset: { id: "44444444-4444-4444-8444-444444444444", size: 10, sha256: "c".repeat(64), mime: "video/mp4", fetchUrl: "https://media.example.test/lease", expiresAt: "2027-01-01T00:00:00Z" }, title: "", caption: "test", options: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, consent: true, isAigc: false, brandOrganicToggle: false, brandContentToggle: false, commercialContentDisclosureConfirmed: false } };
        expect(submitSchema.safeParse(input).success).toBe(true);
    });
});
