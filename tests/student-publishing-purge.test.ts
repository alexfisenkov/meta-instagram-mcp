import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StudentVault } from "../src/student/vault.js";
import { PublishingStore } from "../src/student/publishing-store.js";
import { purgePublishingSubject } from "../src/student/publishing-purge.js";
import { targetHash, type Submit, type Asset } from "../src/student/publishing-types.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse())
        await c();
});
const a = { tenantId: "masterskaya", sub: "synthetic-a" }, b = { tenantId: "masterskaya", sub: "synthetic-ab" }, key = Buffer.alloc(32, 17);
const base = { connections: 0, grants: 0, events: 0, states: 0, generations: 0 };
function asset(mime: "video/mp4" | "image/jpeg" = "video/mp4"): Asset {
    return { id: randomUUID(), sha256: "a".repeat(64), size: 15, mime, fetchUrl: "https://example.test/media/opaque", expiresAt: "2027-01-01T00:00:00Z" };
}
function request(): Submit {
    const r: Submit = { deliveryId: randomUUID(), intentId: randomUUID(), intentHash: "b".repeat(64), targetHash: "c".repeat(64), connectionId: randomUUID(), product: "tiktok", asset: asset(), cover: asset("image/jpeg"), title: "Synthetic", caption: "Synthetic", options: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, consent: true, brandContentToggle: false, brandOrganicToggle: false, isAigc: false, commercialContentDisclosureConfirmed: false } };
    r.targetHash = targetHash(r);
    return r;
}
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "publishing-purge-")), directory = join(root, "publishing"), vault = await StudentVault.open(directory, key), store = new PublishingStore(vault), ra = request(), rb = request();
    cleanups.push(() => rm(root, { recursive: true, force: true }), () => vault.close());
    await store.transaction(d => {
        for (const [subject, r] of [[a, ra], [b, rb]] as const) {
            d.connections.push({ ...subject, id: r.connectionId, product: "tiktok", providerId: subject.sub, label: "Synthetic", scopes: ["user.info.basic"], accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000, status: "connected", configFingerprint: "d".repeat(64) });
            d.states.push({ ...subject, hash: subject.sub, product: "tiktok", expiresAt: Date.now() + 600000, codeVerifier: "v".repeat(43), fingerprint: "d".repeat(64), generation: 0 });
            d.deliveries.push({ ...subject, request: r, receipt: { deliveryId: r.deliveryId, intentId: r.intentId, intentHash: r.intentHash, targetHash: r.targetHash, version: 2, state: "unknown", stage: "uploading", retryable: true }, checkpoint: { mediaId: "v_pub_file~synthetic", uploadUrl: "https://open-upload.tiktokapis.com/video/?upload_id=synthetic&upload_token=synthetic", inFlight: "tiktok_upload" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            d.generations[`${subject.tenantId}:${subject.sub}:tiktok`] = 1;
        }
    });
    const cache = join(directory, ".media-cache");
    await mkdir(cache, { mode: 0o700 });
    const filesA = [join(cache, `cache-${ra.deliveryId}-asset-${ra.asset.id}-${ra.asset.sha256}`), join(cache, `cache-${ra.deliveryId}-cover-${ra.cover!.id}-${ra.cover!.sha256}`), join(cache, `.media-${ra.deliveryId}-${ra.asset.id}-${randomUUID()}`), join(directory, `.media-${ra.asset.id}-${randomUUID()}`)], filesB = [join(cache, `cache-${rb.deliveryId}-asset-${rb.asset.id}-${rb.asset.sha256}`), join(cache, `.media-${rb.deliveryId}-${rb.asset.id}-${randomUUID()}`)];
    for (const path of [...filesA, ...filesB])
        await writeFile(path, "synthetic-cache", { mode: 0o600 });
    const original = join(root, "platform-original.mp4");
    await writeFile(original, "original-kept");
    return { root, directory, vault, store, ra, rb, filesA, filesB, original };
}
it("purges only the selected publishing subject, inline credentials, checkpoints and private cache copies", async () => {
    const f = await fixture(), before = await f.store.snapshot();
    await f.vault.close();
    expect(await purgePublishingSubject(f.root, key, a)).toEqual({ connections: 1, grants: 0, events: 0, states: 1, generations: 1, deliveries: 1, mediaCacheFiles: 4 });
    const check = await StudentVault.open(f.directory, key);
    try {
        const after = await new PublishingStore(check).snapshot();
        expect(after.connections).toEqual(before.connections.filter(c => c.sub === b.sub));
        expect(after.states).toEqual(before.states.filter(c => c.sub === b.sub));
        expect(after.deliveries).toEqual(before.deliveries.filter(c => c.sub === b.sub));
        expect(after.generations).toEqual({ [`${b.tenantId}:${b.sub}:tiktok`]: 1 });
    }
    finally {
        await check.close();
    }
    for (const path of f.filesA)
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of f.filesB)
        expect(await readFile(path, "utf8")).toBe("synthetic-cache");
    expect(await readFile(f.original, "utf8")).toBe("original-kept");
    expect(await purgePublishingSubject(f.root, key, a)).toEqual({ ...base, deliveries: 0, mediaCacheFiles: 0 });
});
it("uses the existing publisher writer lock and never removes live state/cache", async () => {
    const f = await fixture(), before = await f.store.snapshot();
    await expect(purgePublishingSubject(f.root, key, a)).rejects.toMatchObject({ code: "writer_locked" });
    expect(await f.store.snapshot()).toEqual(before);
    for (const path of f.filesA)
        expect(await readFile(path, "utf8")).toBe("synthetic-cache");
});
it("does not create an optional namespace and rejects an invalid subject", async () => {
    const root = await mkdtemp(join(tmpdir(), "publishing-purge-empty-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    expect(await purgePublishingSubject(root, key, a)).toEqual(base);
    expect(await readdir(root)).toEqual([]);
    await expect(purgePublishingSubject(root, key, { ...a, sub: "../other" })).rejects.toMatchObject({ code: "invalid_purge_subject" });
});
it("rejects a wrong encryption key before touching any cached copy", async () => {
    const f = await fixture();
    await f.vault.close();
    await expect(purgePublishingSubject(f.root, Buffer.alloc(32, 18), a)).rejects.toMatchObject({ code: "vault_integrity_failed" });
    for (const path of f.filesA)
        expect(await readFile(path, "utf8")).toBe("synthetic-cache");
});
it.runIf(process.platform !== "win32")("rejects a cache-directory symlink without deleting records or originals", async () => {
    const f = await fixture();
    await f.vault.close();
    await rm(join(f.directory, ".media-cache"), { recursive: true });
    await symlink(f.root, join(f.directory, ".media-cache"));
    await expect(purgePublishingSubject(f.root, key, a)).rejects.toMatchObject({ code: "publishing_cache_path_rejected" });
    expect(await readFile(f.original, "utf8")).toBe("original-kept");
    const check = await StudentVault.open(f.directory, key);
    try {
        expect((await new PublishingStore(check).snapshot()).connections).toHaveLength(2);
    }
    finally {
        await check.close();
    }
});
it("bounds filesystem discovery before deleting cache files or authenticated records", async () => {
    const f = await fixture();
    await f.vault.close();
    await expect(purgePublishingSubject(f.root, key, a, { maxEntries: 1 })).rejects.toMatchObject({ code: "purge_capacity_exceeded" });
    for (const path of f.filesA)
        expect(await readFile(path, "utf8")).toBe("synthetic-cache");
    const check = await StudentVault.open(f.directory, key);
    try {
        expect((await new PublishingStore(check).snapshot()).deliveries).toHaveLength(2);
    }
    finally {
        await check.close();
    }
});
it.runIf(process.platform !== "win32")("unlinks only an owned cache symlink, never its platform-original target", async () => {
    const f = await fixture();
    await f.vault.close();
    await rm(f.filesA[0]);
    await symlink(f.original, f.filesA[0]);
    expect(await purgePublishingSubject(f.root, key, a)).toMatchObject({ deliveries: 1, mediaCacheFiles: 4 });
    expect(await readFile(f.original, "utf8")).toBe("original-kept");
});
