import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StudentVault } from "../src/student/vault.js";
import { PublishingStore } from "../src/student/publishing-store.js";
import { PublishingBroker } from "../src/student/publishing-broker.js";
import { PublishingProviders, TIKTOK_DISCLOSURE_VERSION } from "../src/student/provider-publishing.js";
import { PublishingHttp, mediaUrl, providerUrl, spoolMedia, type ProviderFetch } from "../src/student/provider-publishing-http.js";
import { canonical, targetHash, type Submit, type Access } from "../src/student/publishing-types.js";
const subject = { tenantId: "masterskaya", sub: "synthetic-a" }, other = { tenantId: "masterskaya", sub: "synthetic-b" };
const bytes = Buffer.from("synthetic MP4 source"), sha = createHash("sha256").update(bytes).digest("hex"), policy = { origin: "https://media.example.test", pathPrefix: "/api/v1/social/publishing/media/", maxBytes: 100000 };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const c of cleanup.splice(0).reverse())
        await c();
});
function request(product: Submit["product"] = "youtube"): Submit {
    const s: Submit = { deliveryId: randomUUID(), intentId: randomUUID(), intentHash: "a".repeat(64), targetHash: "b".repeat(64), connectionId: randomUUID(), product, asset: { id: randomUUID(), sha256: sha, size: bytes.length, mime: "video/mp4", fetchUrl: `${policy.origin}${policy.pathPrefix}lease`, expiresAt: new Date(Date.now() + 3600000).toISOString() }, title: "synthetic title", caption: "test caption", options: product === "youtube" ? { categoryId: "22", privacyStatus: "private", madeForKids: false } : product === "instagram" ? { shareToFeed: false } : product === "pinterest" ? { boardId: "321" } : { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, consent: true, brandContentToggle: false, brandOrganicToggle: false, isAigc: true, commercialContentDisclosureConfirmed: false, disclosureVersion: TIKTOK_DISCLOSURE_VERSION } };
    s.targetHash = targetHash(s);
    return s;
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", ...headers } });
async function setup(s: Submit, fetcher: ProviderFetch) {
    const directory = await mkdtemp(join(tmpdir(), "publishing-")), key = Buffer.alloc(32, 8);
    let vault = await StudentVault.open(directory, key);
    cleanup.push(() => rm(directory, { recursive: true, force: true }), () => vault.close());
    const access: Access = { ...subject, connectionId: s.connectionId, product: s.product, providerId: s.product === "youtube" ? "UCsynthetic" : s.product === "instagram" ? "123" : "456", label: "Synthetic", accessToken: "synthetic-private-test-token", scopes: s.product === "youtube" ? ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"] : s.product === "instagram" ? ["instagram_business_content_publish"] : s.product === "tiktok" ? ["user.info.basic", "video.publish"] : ["user_accounts:read", "boards:read", "pins:read", "pins:write"], apiVersion: "v25.0", family: "instagram_login" };
    const resolver = async (who: typeof subject, id: string) => {
        if (who.sub !== subject.sub || id !== s.connectionId)
            throw new Error("connection_not_found");
        return access;
    };
    const make = () => new PublishingBroker(new PublishingStore(vault), resolver, new PublishingProviders(new PublishingHttp(fetcher)), policy, directory, fetcher);
    return { directory, get vault() {
            return vault;
        }, get store() {
            return new PublishingStore(vault);
        }, access, broker: make(), restart: async () => {
            await vault.close();
            vault = await StudentVault.open(directory, key);
            return make();
        } };
}
function fixture(s: Submit, options: {
    loseUpload?: boolean;
    losePost?: boolean;
    wrongPrivacy?: boolean;
} = {}) {
    const calls: {
        url: string;
        method: string;
        body?: unknown;
    }[] = [];
    let uploaded = false, posted = false;
    const fetcher: ProviderFetch = async (input, init = {}) => {
        const url = String(input), u = new URL(url), method = init.method ?? "GET";
        calls.push({ url, method, body: init.body });
        if (u.hostname === "media.example.test")
            return new Response(bytes);
        if (u.pathname.includes("/channels"))
            return json({ items: [{ id: "UCsynthetic" }] });
        if (u.pathname === "/v25.0/123")
            return json({ id: "123" });
        if (u.pathname === "/v25.0/123/media")
            return json({ id: "container1" });
        if (u.pathname === "/v25.0/container1")
            return json({ id: "container1", status_code: "FINISHED" });
        if (u.pathname === "/v25.0/123/media_publish") {
            posted = true;
            if (options.losePost)
                throw new Error("synthetic timeout");
            return json({ id: "post1" });
        }
        if (u.pathname === "/v25.0/post1")
            return json({ id: "post1", owner: { id: "123" }, media_product_type: "REELS", permalink: "https://www.instagram.com/reel/test/" });
        if (u.pathname === "/upload/youtube/v3/videos" && method === "POST")
            return new Response(null, { status: 200, headers: { Location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic-session" } });
        if (u.pathname === "/upload/youtube/v3/videos" && method === "PUT") {
            const h = new Headers(init.headers);
            if (h.get("content-range")?.startsWith("bytes */"))
                return uploaded ? json({ id: "video1" }) : new Response(null, { status: 308 });
            let size = 0;
            for await (const c of init.body as any)
                size += c.length;
            expect(size).toBe(bytes.length);
            uploaded = true;
            if (options.loseUpload)
                throw new Error("timeout after accepted");
            return json({ id: "video1" });
        }
        if (u.pathname === "/youtube/v3/videos")
            return json({ items: [{ id: "video1", snippet: { channelId: "UCsynthetic" }, status: { privacyStatus: options.wrongPrivacy ? "public" : "private", selfDeclaredMadeForKids: false, uploadStatus: "processed" }, processingDetails: { processingStatus: "succeeded" } }] });
        if (u.pathname === "/v2/user/info/")
            return json({ data: { user: { open_id: "456" } }, error: { code: "ok" } });
        if (u.pathname.includes("creator_info"))
            return json({ data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], comment_disabled: true, duet_disabled: true, stitch_disabled: true, max_video_post_duration_sec: 180 }, error: { code: "ok" } });
        if (u.pathname.includes("/video/init"))
            return json({ data: { publish_id: "v_pub_file~synthetic", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=synthetic" }, error: { code: "ok" } });
        if (u.hostname === "open-upload.tiktokapis.com") {
            for await (const _ of init.body as any) {
            }
            uploaded = true;
            return new Response(null, { status: 201 });
        }
        if (u.pathname.includes("status/fetch"))
            return json({ data: uploaded ? { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] } : { status: "PROCESSING_UPLOAD", uploaded_bytes: 0 }, error: { code: "ok" } });
        if (u.pathname === "/v5/user_account")
            return json({ id: "456", username: "synthetic" });
        if (u.pathname === "/v5/boards")
            return json({ items: [{ id: "321", name: "Synthetic board" }] });
        if (u.pathname === "/v5/media")
            return json({ media_id: "111", media_type: "video", upload_url: "https://pinterest-media-upload.s3-accelerate.amazonaws.com/", upload_parameters: { key: "synthetic", policy: "synthetic" } });
        if (u.pathname === "/v5/media/111")
            return json({ media_id: "111", status: uploaded ? "succeeded" : "registered" });
        if (u.hostname === "pinterest-media-upload.s3-accelerate.amazonaws.com") {
            for await (const _ of init.body as any) {
            }
            uploaded = true;
            return new Response(null, { status: 204 });
        }
        if (u.pathname === "/v5/pins") {
            posted = true;
            const body = JSON.parse(String(init.body));
            expect(body.media_source).toEqual({ source_type: "video_id", media_id: "111", cover_image_key_frame_time: 0 });
            if (options.losePost)
                throw new Error("synthetic timeout");
            return json({ id: "222" });
        }
        if (u.pathname === "/v5/pins/222")
            return json({ id: "222", board_id: "321" });
        throw new Error(`unexpected synthetic endpoint ${url}`);
    };
    return { fetcher, calls, get posted() {
            return posted;
        } };
}
async function progress(b: PublishingBroker, s: Submit, max = 8) {
    for (let i = 0; i < max; i++) {
        await b.store.transaction(d => {
            for (const x of d.deliveries)
                delete x.receipt.nextPollAt;
        });
        await b.tick();
        const r = await b.status(subject, s.deliveryId);
        if (["published", "unknown", "failed"].includes(r.state))
            return r;
    }
    return b.status(subject, s.deliveryId);
}
describe("durable video publishing", () => {
    it("rejects missing or noncanonical YouTube category before any provider call", async () => {
        const s = request(), f = fixture(s), x = await setup(s, f.fetcher);
        for (const options of [{ privacyStatus: "private", madeForKids: false }, { ...s.options, categoryId: "0" }, { ...s.options, categoryId: "01" }, { ...s.options, categoryId: 22 }]) {
            const changed = { ...s, options };
            changed.targetHash = targetHash(changed);
            await expect(x.broker.submit(subject, changed)).rejects.toMatchObject({ code: "invalid_publish_request" });
        }
        expect(f.calls).toHaveLength(0);
        expect(targetHash({ ...s, options: { ...s.options, categoryId: "23" } })).not.toBe(s.targetHash);
    });
    it.each(["youtube", "tiktok"] as const)("still requires verified source bytes when a known %s upload is incomplete", async (product) => {
        const s = request(product), f = fixture(s), x = await setup(s, f.fetcher);
        await x.broker.submit(subject, s);
        await x.broker.tick();
        await x.store.transaction(d => {
            d.deliveries[0].request.asset.expiresAt = "2020-01-01T00:00:00Z";
            delete d.deliveries[0].receipt.nextPollAt;
        });
        expect(await progress(x.broker, s)).toMatchObject({ state: "failed", failureCode: "asset_lease_rejected" });
        expect(f.calls.filter(c => new URL(c.url).hostname === "open-upload.tiktokapis.com")).toHaveLength(0);
        expect(f.calls.filter(c => c.method === "PUT" && c.url.includes("/upload/youtube") && c.body)).toHaveLength(0);
    });
    it("sends the explicitly confirmed YouTube category required by provider metadata", async () => {
        const s = request(), f = fixture(s);
        const fetcher: ProviderFetch = async (input, init) => {
            if (String(input).includes("/upload/youtube/v3/videos") && init?.method === "POST") {
                const metadata = JSON.parse(String(init.body));
                if (metadata.snippet?.categoryId !== "22")
                    return json({ error: { errors: [{ reason: "invalidVideoMetadata" }] } }, 400);
            }
            return f.fetcher(input, init);
        };
        const x = await setup(s, fetcher);
        await x.broker.submit(subject, s);
        expect((await progress(x.broker, s)).state).toBe("published");
    });
    it("accepts TikTok's documented regional upload host without broadening to other hosts", async () => {
        const s = request("tiktok"), f = fixture(s);
        const actualUploads: string[] = [];
        const fetcher: ProviderFetch = async (input, init) => {
            const u = new URL(String(input));
            if (u.pathname.includes("/video/init"))
                return json({ data: { publish_id: "v_pub_file~synthetic", upload_url: "https://upload.us.tiktokapis.com/video/?upload_id=67890&upload_token=chunkexample" }, error: { code: "ok" } });
            if (u.hostname === "upload.us.tiktokapis.com") {
                actualUploads.push(String(input));
                return f.fetcher(String(input).replace("upload.us.tiktokapis.com", "open-upload.tiktokapis.com"), init);
            }
            return f.fetcher(input, init);
        };
        const x = await setup(s, fetcher);
        await x.broker.submit(subject, s);
        expect((await progress(x.broker, s)).state).toBe("published");
        expect(actualUploads).toHaveLength(1);
        for (const bad of ["https://upload.us.tiktokapis.com.evil.test/video/?upload_id=1&upload_token=x", "http://upload.us.tiktokapis.com/video/?upload_id=1&upload_token=x", "https://upload.us.tiktokapis.com/other/?upload_id=1&upload_token=x", "https://upload.us.tiktokapis.com/video/?upload_id=1&upload_id=2&upload_token=x", "https://upload.us.tiktokapis.com/video/?upload_id=1&upload_token=x&redirect=https://evil.test"]) {
            expect(() => providerUrl(bad)).toThrow();
        }
    });
    it("resumes a registered Pinterest media checkpoint after the receipt stage changes", async () => {
        const s = request("pinterest"), f = fixture(s), x = await setup(s, f.fetcher);
        await x.broker.submit(subject, s);
        await x.broker.tick();
        const registered = await x.broker.status(subject, s.deliveryId);
        expect(registered.stage).toBe("media_upload");
        const restarted = await x.restart();
        await restarted.resume(subject, { deliveryId: s.deliveryId, expectedVersion: registered.version });
        expect((await progress(restarted, s)).state).toBe("published");
        expect(f.calls.filter(c => c.method === "POST" && c.url.endsWith("/v5/media"))).toHaveLength(1);
        expect(f.calls.filter(c => c.url.includes(policy.pathPrefix))).toHaveLength(2);
    });
    it.each(["youtube", "tiktok"] as const)("reconciles an already uploaded %s operation before touching an expired source lease", async (product) => {
        const s = request(product), f = fixture(s, { loseUpload: product === "youtube" });
        let loseTikUpload = true;
        const fetcher: ProviderFetch = async (input, init) => {
            const result = await f.fetcher(input, init);
            if (product === "tiktok" && String(input).startsWith("https://open-upload.tiktokapis.com/") && loseTikUpload) {
                loseTikUpload = false;
                throw new Error("synthetic accepted upload response lost");
            }
            return result;
        };
        const x = await setup(s, fetcher);
        await x.broker.submit(subject, s);
        expect((await progress(x.broker, s)).state).toBe("unknown");
        await x.store.transaction(d => {
            d.deliveries[0].request.asset.expiresAt = "2020-01-01T00:00:00Z";
        });
        const requestsBefore = f.calls.filter(c => c.url.includes(policy.pathPrefix)).length;
        const restarted = await x.restart(), unknown = await restarted.status(subject, s.deliveryId);
        await restarted.resume(subject, { deliveryId: s.deliveryId, expectedVersion: unknown.version });
        expect((await progress(restarted, s)).state).toBe("published");
        expect(f.calls.filter(c => c.url.includes(policy.pathPrefix))).toHaveLength(requestsBefore);
    });
    it("does not report cancellation after an external video already exists", async () => {
        const s = request(), x = await setup(s, fixture(s).fetcher);
        await x.broker.submit(subject, s);
        await x.broker.tick();
        await x.store.transaction(d => {
            delete d.deliveries[0].receipt.nextPollAt;
        });
        await x.broker.tick();
        const processing = await x.broker.status(subject, s.deliveryId);
        expect(processing.state).toBe("processing");
        await expect(x.broker.cancel(subject, { deliveryId: s.deliveryId, expectedVersion: processing.version })).rejects.toMatchObject({ code: "provider_outcome_unknown" });
        expect((await progress(x.broker, s)).state).toBe("published");
    });
    it("uploads a selected YouTube cover only to the known owned video", async () => {
        const s = request();
        s.cover = { ...s.asset, id: randomUUID(), mime: "image/jpeg", fetchUrl: s.asset.fetchUrl + "cover" };
        s.targetHash = targetHash(s);
        const f = fixture(s);
        const fetcher: ProviderFetch = async (input, init) => {
            if (String(input).includes("/thumbnails/set")) {
                expect(String(input)).toContain("videoId=video1");
                let size = 0;
                for await (const chunk of init?.body as any)
                    size += chunk.length;
                expect(size).toBe(bytes.length);
                return Response.json({ items: [{ default: { url: "https://example.test/thumbnail" } }] });
            }
            return f.fetcher(input, init);
        };
        const x = await setup(s, fetcher);
        await x.broker.submit(subject, s);
        expect((await progress(x.broker, s)).state).toBe("published");
    });
    it("bounds processing and requires explicit reconciliation of the known session", async () => {
        const s = request(), x = await setup(s, fixture(s).fetcher);
        await x.broker.submit(subject, s);
        await x.broker.tick();
        await x.store.transaction(d => {
            d.deliveries[0].processingStartedAt = new Date(Date.now() - 25 * 3600000).toISOString();
            delete d.deliveries[0].receipt.nextPollAt;
        });
        await x.broker.tick();
        const stopped = await x.broker.status(subject, s.deliveryId);
        expect(stopped).toMatchObject({ state: "unknown", failureCode: "provider_processing_timeout", retryable: true });
        await x.broker.resume(subject, { deliveryId: s.deliveryId, expectedVersion: stopped.version });
        expect((await progress(x.broker, s)).state).toBe("published");
    });
    it("renews an expired source after a proven pre-mutation failure", async () => {
        const s = request(), f = fixture(s);
        let assetOnline = false;
        const fetcher: ProviderFetch = async (input, init) => String(input).includes(policy.pathPrefix) && !assetOnline ? new Response(null, { status: 503 }) : f.fetcher(input, init);
        const x = await setup(s, fetcher);
        await x.broker.submit(subject, s);
        await x.broker.tick();
        const failed = await x.broker.status(subject, s.deliveryId);
        expect(failed).toMatchObject({ state: "failed", retryable: true });
        assetOnline = true;
        await x.broker.resume(subject, { deliveryId: s.deliveryId, expectedVersion: failed.version, asset: { ...s.asset, fetchUrl: s.asset.fetchUrl + "renewed" } });
        expect((await progress(x.broker, s)).state).toBe("published");
    });
    it("matches the frozen independent Go Unicode fixture", async () => {
        const f = JSON.parse(await readFile(new URL("./fixtures/publishing-hash-fixture.json", import.meta.url), "utf8"));
        const s = { ...request(), connectionId: f.connectionId, product: f.product, asset: { ...request().asset, ...f.source.asset }, title: f.title, caption: f.caption, options: f.options };
        expect(canonical(["social-publish-target-v1", f.connectionId, f.product, f.source, f.title, f.caption, f.options])).toBe(f.canonical);
        expect(targetHash(s)).toBe(f.targetHash);
    });
    it.each(["instagram", "youtube", "tiktok", "pinterest"] as const)("publishes %s only after exact provider readback", async (product) => {
        const s = request(product), f = fixture(s), x = await setup(s, f.fetcher);
        await x.broker.submit(subject, s);
        const r = await progress(x.broker, s);
        expect(r.state).toBe("published");
        expect(r.providerId).toBeTruthy();
        expect(f.calls.filter(c => c.url.includes(policy.pathPrefix))).not.toHaveLength(0);
        expect((await readdir(x.directory)).filter(p => p.startsWith(".media-"))).toEqual([]);
    });
    it("preserves official TikTok int64 public post IDs without floating point corruption", async () => {
        const s = request("tiktok");
        s.options.privacyLevel = "PUBLIC_TO_EVERYONE";
        s.targetHash = targetHash(s);
        const f = fixture(s);
        const fetcher: ProviderFetch = async (input, init) => String(input).includes("status/fetch") ? new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7654321098765432109]},"error":{"code":"ok"}}') : f.fetcher(input, init);
        const x = await setup(s, fetcher);
        await x.broker.submit(subject, s);
        expect(await progress(x.broker, s)).toMatchObject({ state: "published", providerId: "7654321098765432109" });
    });
    it("keeps two deliveries in one intent independent and rejects changed duplicate/cross-owner", async () => {
        const s = request(), f = fixture(s), x = await setup(s, f.fetcher);
        await x.broker.submit(subject, s);
        expect(await x.broker.submit(subject, { ...s, asset: { ...s.asset, fetchUrl: s.asset.fetchUrl + "2" } })).toMatchObject({ version: 1 });
        const changed = { ...s, caption: "changed" };
        changed.targetHash = targetHash(changed);
        await expect(x.broker.submit(subject, changed)).rejects.toMatchObject({ code: "delivery_payload_conflict" });
        await expect(x.broker.submit(other, s)).rejects.toMatchObject({ code: "delivery_not_found" });
        await expect(x.broker.status(other, s.deliveryId)).rejects.toMatchObject({ code: "delivery_not_found" });
        const second = { ...s, deliveryId: randomUUID() };
        await x.broker.submit(subject, second);
        expect((await x.store.snapshot()).deliveries).toHaveLength(2);
    });
    it("reconciles a known YouTube session after timeout and restart without a second video", async () => {
        const s = request(), f = fixture(s, { loseUpload: true }), x = await setup(s, f.fetcher);
        await x.broker.submit(subject, s);
        const unknown = await progress(x.broker, s);
        expect(unknown.state).toBe("unknown");
        const restarted = await x.restart();
        await restarted.resume(subject, { deliveryId: s.deliveryId, expectedVersion: unknown.version });
        expect((await progress(restarted, s)).state).toBe("published");
        expect(f.calls.filter(c => c.method === "POST" && c.url.includes("/upload/youtube"))).toHaveLength(1);
        expect(f.calls.filter(c => c.method === "PUT" && new Headers((c.body as any)?.headers).has("content-range"))).toHaveLength(0);
    });
    it.each(["instagram", "pinterest"] as const)("does not repeat ambiguous %s publish after restart", async (product) => {
        const s = request(product), f = fixture(s, { losePost: true }), x = await setup(s, f.fetcher);
        await x.broker.submit(subject, s);
        const unknown = await progress(x.broker, s);
        expect(unknown.state).toBe("unknown");
        const restarted = await x.restart();
        await restarted.resume(subject, { deliveryId: s.deliveryId, expectedVersion: unknown.version });
        expect((await progress(restarted, s)).state).toBe("unknown");
        expect(f.calls.filter(c => c.method === "POST" && (c.url.includes("media_publish") || c.url.endsWith("/pins")))).toHaveLength(1);
    });
    it("fails YouTube privacy mismatch without claiming publication", async () => {
        const s = request(), f = fixture(s, { wrongPrivacy: true }), x = await setup(s, f.fetcher);
        await x.broker.submit(subject, s);
        expect(await progress(x.broker, s)).toMatchObject({ state: "failed", failureCode: "privacy_readback_mismatch" });
    });
    it("requires exact immutable source identity for lease renewal and version for cancel", async () => {
        const s = request(), x = await setup(s, fixture(s).fetcher);
        await x.broker.submit(subject, s);
        await expect(x.broker.resume(subject, { deliveryId: s.deliveryId, expectedVersion: 1, asset: { ...s.asset, sha256: "c".repeat(64) } })).rejects.toMatchObject({ code: "asset_identity_mismatch" });
        await expect(x.broker.cancel(subject, { deliveryId: s.deliveryId, expectedVersion: 2 })).rejects.toMatchObject({ code: "version_conflict" });
        expect(await x.broker.cancel(subject, { deliveryId: s.deliveryId, expectedVersion: 1 })).toMatchObject({ state: "cancelled" });
        await x.broker.tick();
        expect(await x.broker.status(subject, s.deliveryId)).toMatchObject({ state: "cancelled" });
    });
    it("rejects non-first-party media, redirects, oversized/corrupt streams before provider mutation", async () => {
        const s = request(), f = fixture(s), x = await setup(s, f.fetcher);
        expect(() => mediaUrl({ ...s.asset, fetchUrl: "https://evil.test/x" }, policy)).toThrow("asset_lease_rejected");
        expect(() => mediaUrl({ ...s.asset, fetchUrl: `${policy.origin}${policy.pathPrefix}a%2Fb` }, policy)).toThrow();
        for (const body of [Buffer.from("wrong"), Buffer.alloc(bytes.length + 1)])
            await expect(spoolMedia(s.asset, policy, x.directory, async () => new Response(body))).rejects.toThrow();
        await expect(spoolMedia(s.asset, policy, x.directory, async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }))).rejects.toThrow("asset_unavailable");
        expect(f.calls).toHaveLength(0);
        expect(() => providerUrl("https://www.googleapis.com/evil")).toThrow();
    });
    it("validates latest TikTok privacy, interaction and mandatory disclosures before acceptance", async () => {
        const s = request("tiktok"), x = await setup(s, fixture(s).fetcher);
        for (const options of [{ ...s.options, privacyLevel: "FOLLOWER_OF_CREATOR" }, { ...s.options, disableDuet: false }, { ...s.options, brandContentToggle: true }, { ...s.options, brandOrganicToggle: true }]) {
            const next = { ...s, options };
            next.targetHash = targetHash(next);
            await expect(x.broker.submit(subject, next)).rejects.toThrow();
        }
        expect((await x.store.snapshot()).deliveries).toEqual([]);
    });
});
