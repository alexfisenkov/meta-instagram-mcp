import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishingBroker } from "../src/student/publishing-broker.js";
import { PublishingProviders, TIKTOK_DISCLOSURE_VERSION } from "../src/student/provider-publishing.js";
import { PublishingHttp, type ProviderFetch } from "../src/student/provider-publishing-http.js";
import { PublishingStore } from "../src/student/publishing-store.js";
import { StudentVault } from "../src/student/vault.js";
import { targetHash, type Access, type Submit } from "../src/student/publishing-types.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0).reverse())
        await close();
});
const subject = { tenantId: "masterskaya", sub: "synthetic-pull" }, bytes = Buffer.from("synthetic source"), policy = { origin: "https://media.example.test", pathPrefix: "/api/v1/social/publishing/media/", maxBytes: 100000 };
function request(): Submit {
    const s: Submit = { deliveryId: randomUUID(), intentId: randomUUID(), intentHash: "a".repeat(64), targetHash: "b".repeat(64), connectionId: randomUUID(), product: "tiktok", asset: { id: randomUUID(), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mime: "video/mp4", fetchUrl: policy.origin + policy.pathPrefix + "lease", expiresAt: new Date(Date.now() + 7200000).toISOString() }, title: "Source video", caption: "Exact caption", options: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, consent: true, brandContentToggle: false, brandOrganicToggle: false, isAigc: true, commercialContentDisclosureConfirmed: false, disclosureVersion: TIKTOK_DISCLOSURE_VERSION } };
    s.targetHash = targetHash(s);
    return s;
}
async function fixture(s = request()) {
    const directory = await mkdtemp(join(tmpdir(), "tiktok-pull-")), key = Buffer.alloc(32, 29);
    let vault = await StudentVault.open(directory, key);
    cleanups.push(() => rm(directory, { recursive: true, force: true }), () => vault.close());
    const metrics = { sourceGets: 0, uploads: 0, init: [] as any[], statusCalls: 0 };
    let initFailure: "timeout" | "ownership" | "contradictory" | undefined, legacy = false, uploaded = false;
    const fetcher: ProviderFetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.origin === policy.origin) {
            metrics.sourceGets++;
            return new Response(bytes);
        }
        if (url.pathname === "/v2/user/info/")
            return Response.json({ data: { user: { open_id: "creator-open-id" } }, error: { code: "ok" } });
        if (url.pathname.includes("creator_info"))
            return Response.json({ data: { creator_avatar_url: "https://example.test/avatar", creator_username: "current_creator", creator_nickname: "Fresh Creator", privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], comment_disabled: true, duet_disabled: true, stitch_disabled: true, max_video_post_duration_sec: 180 }, error: { code: "ok" } });
        if (url.pathname.endsWith("/video/init/")) {
            metrics.init.push(JSON.parse(String(init.body)));
            if (initFailure === "timeout")
                throw new Error("synthetic lost init response");
            if (initFailure === "contradictory")
                return Response.json({ data: { publish_id: "v_pub_url~uncertain" }, error: { code: "url_ownership_unverified" } }, { status: 403 });
            if (initFailure === "ownership")
                return Response.json({ error: { code: "url_ownership_unverified", message: "private-provider-detail" } }, { status: 403 });
            return Response.json({ data: { publish_id: "v_pub_url~v2.synthetic" }, error: { code: "ok" } });
        }
        if (url.pathname.endsWith("status/fetch/")) {
            metrics.statusCalls++;
            if (legacy)
                return Response.json({ data: uploaded ? { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] } : { status: "PROCESSING_UPLOAD", uploaded_bytes: 0 }, error: { code: "ok" } });
            return Response.json({ data: metrics.statusCalls === 1 ? { status: "PROCESSING_DOWNLOAD", downloaded_bytes: bytes.length } : { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: { code: "ok" } });
        }
        if (["open-upload.tiktokapis.com", "upload.us.tiktokapis.com"].includes(url.hostname)) {
            metrics.uploads++;
            const hash = createHash("sha256");
            let size = 0;
            for await (const chunk of init.body as any) {
                hash.update(chunk);
                size += chunk.length;
            }
            expect(size).toBe(bytes.length);
            expect(hash.digest("hex")).toBe(s.asset.sha256);
            uploaded = true;
            return new Response(null, { status: 201 });
        }
        throw new Error("unrecognized synthetic route");
    };
    const access: Access = { ...subject, connectionId: s.connectionId, product: "tiktok", providerId: "creator-open-id", label: "Old label", accessToken: "synthetic-access", scopes: ["user.info.basic", "video.publish"], apiVersion: "v2" };
    const make = () => new PublishingBroker(new PublishingStore(vault), async () => access, new PublishingProviders(new PublishingHttp(fetcher)), policy, directory, fetcher);
    return { s, directory, metrics, broker: make(), get store() {
            return new PublishingStore(vault);
        }, set initFailure(value: typeof initFailure) {
            initFailure = value;
        }, set legacy(value: boolean) {
            legacy = value;
        }, set uploaded(value: boolean) {
            uploaded = value;
        }, restart: async () => {
            await vault.close();
            vault = await StudentVault.open(directory, key);
            return make();
        } };
}
async function tick(b: PublishingBroker) {
    await b.store.transaction(d => {
        for (const row of d.deliveries)
            delete row.receipt.nextPollAt;
    });
    await b.tick();
}
async function finish(b: PublishingBroker, s: Submit) {
    for (let i = 0; i < 6; i++) {
        await tick(b);
        const r = await b.status(subject, s.deliveryId);
        if (["published", "failed", "unknown"].includes(r.state))
            return r;
    }
    return b.status(subject, s.deliveryId);
}
describe("TikTok server-stored source contract", () => {
    it("never falls back to bytes if a known pull reports an upload-style status", async () => {
        const f = await fixture();
        f.legacy = true;
        await f.broker.submit(subject, f.s);
        await f.broker.tick();
        expect(await finish(f.broker, f.s)).toMatchObject({ state: "processing", stage: "post_download" });
        expect(f.metrics.sourceGets).toBe(0);
        expect(f.metrics.uploads).toBe(0);
        f.uploaded = true;
        expect((await finish(f.broker, f.s)).state).toBe("published");
        expect(f.metrics.init).toHaveLength(1);
    });
    it("treats a contradictory provider rejection containing an operation ID as uncertain, never as retryable nonacceptance", async () => {
        const f = await fixture();
        f.initFailure = "contradictory";
        await f.broker.submit(subject, f.s);
        const r = await finish(f.broker, f.s);
        expect(r).toMatchObject({ state: "unknown", retryable: false });
        await expect(f.broker.resume(subject, { deliveryId: f.s.deliveryId, expectedVersion: r.version })).rejects.toMatchObject({ code: "provider_outcome_unknown" });
        expect(f.metrics.init).toHaveLength(1);
    });
    it("initializes PULL_FROM_URL with the exact first-party lease and never fetches/spools/uploads it in Node", async () => {
        const f = await fixture();
        await f.broker.submit(subject, f.s);
        await f.broker.tick();
        expect(f.metrics.init).toHaveLength(1);
        expect(f.metrics.init[0]).toEqual({ post_info: { title: "Exact caption", privacy_level: "SELF_ONLY", disable_comment: true, disable_duet: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: false, is_aigc: true }, source_info: { source: "PULL_FROM_URL", video_url: f.s.asset.fetchUrl } });
        expect(await f.broker.status(subject, f.s.deliveryId)).toMatchObject({ state: "processing", stage: "post_download" });
        expect(f.metrics.sourceGets).toBe(0);
        expect(f.metrics.uploads).toBe(0);
        expect(targetHash({ ...f.s, asset: { ...f.s.asset, fetchUrl: f.s.asset.fetchUrl + "renewed", expiresAt: "2027-01-01T00:00:00Z" } })).toBe(f.s.targetHash);
        let cache: string[] = [];
        try {
            cache = await readdir(join(f.directory, ".media-cache"));
        }
        catch {
        }
        expect(cache).toEqual([]);
        expect(await finish(f.broker, f.s)).toMatchObject({ state: "published" });
        expect((await f.broker.status(subject, f.s.deliveryId)).providerId).toBeUndefined();
    });
    it.each(["expired", "wrong-origin"])("rejects a %s lease immediately before pull init without source IO", async (kind) => {
        const f = await fixture();
        await f.broker.submit(subject, f.s);
        await f.store.transaction(d => {
            if (kind === "expired")
                d.deliveries[0].request.asset.expiresAt = "2020-01-01T00:00:00Z";
            else
                d.deliveries[0].request.asset.fetchUrl = "https://evil.example.test/lease";
        });
        expect(await finish(f.broker, f.s)).toMatchObject({ state: "failed", failureCode: "asset_lease_rejected" });
        expect(f.metrics.init).toHaveLength(0);
        expect(f.metrics.sourceGets).toBe(0);
        expect(f.metrics.uploads).toBe(0);
    });
    it("does not claim cancellation or issue a remote abort after accepted pull init", async () => {
        const f = await fixture();
        await f.broker.submit(subject, f.s);
        await f.broker.tick();
        const r = await f.broker.status(subject, f.s.deliveryId);
        await expect(f.broker.cancel(subject, { deliveryId: f.s.deliveryId, expectedVersion: r.version })).rejects.toMatchObject({ code: "provider_outcome_unknown" });
        expect((await finish(f.broker, f.s)).state).toBe("published");
        expect(f.metrics.init).toHaveLength(1);
        expect(f.metrics.uploads).toBe(0);
        expect(f.metrics.sourceGets).toBe(0);
    });
    it("reconciles accepted pull after restart and source lease expiry without a second init", async () => {
        const f = await fixture();
        await f.broker.submit(subject, f.s);
        await f.broker.tick();
        await f.store.transaction(d => {
            d.deliveries[0].request.asset.expiresAt = "2020-01-01T00:00:00Z";
        });
        const restarted = await f.restart();
        expect((await finish(restarted, f.s)).state).toBe("published");
        expect(f.metrics.init).toHaveLength(1);
        expect(f.metrics.sourceGets).toBe(0);
        expect(f.metrics.uploads).toBe(0);
    });
    it("never blindly repeats an init whose response was lost", async () => {
        const f = await fixture();
        f.initFailure = "timeout";
        await f.broker.submit(subject, f.s);
        const r = await finish(f.broker, f.s);
        expect(r.state).toBe("unknown");
        expect(f.metrics.init[0].source_info).toEqual({ source: "PULL_FROM_URL", video_url: f.s.asset.fetchUrl });
        const restarted = await f.restart();
        await expect(restarted.resume(subject, { deliveryId: f.s.deliveryId, expectedVersion: r.version })).rejects.toMatchObject({ code: "provider_outcome_unknown" });
        await tick(restarted);
        expect(f.metrics.init).toHaveLength(1);
        expect(f.metrics.sourceGets).toBe(0);
        expect(f.metrics.uploads).toBe(0);
    });
    it("reports a verified-domain rejection truthfully and only permits an explicit retry after proven nonacceptance", async () => {
        const f = await fixture();
        f.initFailure = "ownership";
        await f.broker.submit(subject, f.s);
        const r = await finish(f.broker, f.s);
        expect(r).toMatchObject({ state: "failed", failureCode: "url_ownership_unverified", retryable: true });
        expect(JSON.stringify(r)).not.toContain("private-provider-detail");
        f.initFailure = undefined;
        await f.broker.resume(subject, { deliveryId: f.s.deliveryId, expectedVersion: r.version });
        expect((await finish(f.broker, f.s)).state).toBe("published");
        expect(f.metrics.init).toHaveLength(2);
        expect(f.metrics.sourceGets).toBe(0);
    });
    it.each([undefined, "FILE_UPLOAD"] as const)("preserves legacy known FILE_UPLOAD checkpoints, mode=%s", async (sourceMode) => {
        const f = await fixture();
        f.legacy = true;
        await f.broker.submit(subject, f.s);
        await f.store.transaction(d => {
            d.deliveries[0].checkpoint = { mediaId: "v_pub_file~legacy", uploadUrl: "https://upload.us.tiktokapis.com/video/?upload_id=legacy&upload_token=synthetic", ...(sourceMode ? { sourceMode } : {}) };
        });
        expect((await finish(f.broker, f.s)).state).toBe("published");
        expect(f.metrics.init).toHaveLength(0);
        expect(f.metrics.uploads).toBe(1);
        expect(f.metrics.sourceGets).toBe(1);
    });
});
