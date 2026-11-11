import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { BrokerError } from "./types.js";
import { PublishingHttp, responseJson, streamBody, providerUrl, tiktokUploadUrl } from "./provider-publishing-http.js";
import { optionSchemas, type Access, type Checkpoint, type Context, type Delivery, type PublishState } from "./publishing-types.js";
export const TIKTOK_DISCLOSURE_VERSION = "tiktok-direct-post-2026-11-v1";
export const TIKTOK_DISCLOSURE_TEXT = "By posting, you agree to TikTok's Music Usage Confirmation. For branded content, you also agree to TikTok's Branded Content Policy.";
export interface StepResult {
    state: PublishState;
    stage: string;
    checkpoint: Checkpoint;
    providerId?: string;
    permalink?: string;
    failureCode?: string;
    pollAfterMs?: number;
}
type MediaPath = () => Promise<string>;
export interface ProviderMediaPaths {
    asset: MediaPath;
    cover?: MediaPath;
}
export type SaveCheckpoint = (cp: Checkpoint, state: PublishState, stage: string) => Promise<void>;
function id(value: unknown): string {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        value = String(value);
    if (typeof value !== "string" || !/^[A-Za-z0-9_~.:-]{1,255}$/.test(value))
        throw new BrokerError("provider_response_invalid");
    return value;
}
const bearer = (a: Access) => ({ Authorization: `Bearer ${a.accessToken}` });
export class PublishingProviders {
    private readonly tiktokStatusWindows = new Map<string, number[]>();
    private nextTikTokStatusSweep = 0;
    private tiktokStatusBackoff(a: Access): number {
        const now = Date.now();
        if (now >= this.nextTikTokStatusSweep) {
            for (const [key, times] of this.tiktokStatusWindows)
                if (times[times.length - 1] < now - 60000)
                    this.tiktokStatusWindows.delete(key);
            this.nextTikTokStatusSweep = now + 60000;
        }
        const key = createHash("sha256").update(a.accessToken).digest("hex");
        const recent = (this.tiktokStatusWindows.get(key) ?? []).filter(time => time >= now - 60000);
        if (recent.length >= 30)
            return Math.max(1, recent[0] + 60001 - now);
        recent.push(now);
        this.tiktokStatusWindows.set(key, recent);
        return 0;
    }
    constructor(readonly http = new PublishingHttp()) {
    }
    async context(a: Access): Promise<Context> {
        const limits: Context["limits"] = a.product === "youtube" ? { maxTitleCharacters: 100, maxCaptionBytes: 5000, forbidAngleBrackets: true } : a.product === "pinterest" ? { maxTitleCharacters: 100, maxCaptionCharacters: 800 } : {};
        const base: Context = { connectionId: a.connectionId, product: a.product, accountLabel: a.label, canPublish: true, requirements: [], limits };
        const required = a.product === "youtube" ? ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"] : a.product === "tiktok" ? ["user.info.basic", "video.publish"] : a.product === "pinterest" ? ["user_accounts:read", "boards:read", "pins:read", "pins:write"] : [a.family === "instagram_login" ? "instagram_business_content_publish" : "instagram_content_publish"];
        if (required.some(s => !a.scopes.includes(s)))
            return { ...base, canPublish: false, reason: "write_consent_required", requirements: required.filter(s => !a.scopes.includes(s)) };
        if (a.product === "tiktok") {
            await this.verifyIdentity(a);
            const b = await this.http.json("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", { method: "POST", headers: { ...bearer(a), "Content-Type": "application/json" }, body: "{}" });
            const d = b.data;
            if (!d || !Array.isArray(d.privacy_level_options) || !d.privacy_level_options.length || d.privacy_level_options.some((x: unknown) => typeof x !== "string") || ![d.comment_disabled, d.duet_disabled, d.stitch_disabled].every(x => typeof x === "boolean") || !Number.isSafeInteger(d.max_video_post_duration_sec))
                throw new BrokerError("provider_response_invalid");
            return { ...base, privacyOptions: d.privacy_level_options, limits: { maxDurationSeconds: d.max_video_post_duration_sec, maxCaptionCharacters: 2200 }, disclosureVersion: TIKTOK_DISCLOSURE_VERSION, commercialContentDisclosureText: TIKTOK_DISCLOSURE_TEXT, interactionConstraints: { commentDisabled: d.comment_disabled, duetDisabled: d.duet_disabled, stitchDisabled: d.stitch_disabled } };
        }
        await this.verifyIdentity(a);
        if (a.product === "pinterest") {
            const boards: {
                id: string;
                name: string;
            }[] = [];
            let bookmark: string | undefined;
            for (let n = 0; n < 10; n++) {
                const b = await this.http.json(`https://api.pinterest.com/v5/boards?page_size=100${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ""}`, { headers: bearer(a) });
                if (!Array.isArray(b.items) || b.items.length > 100)
                    throw new BrokerError("provider_response_invalid");
                for (const row of b.items) {
                    if (typeof row.id !== "string" || !/^\d+$/.test(row.id) || typeof row.name !== "string")
                        throw new BrokerError("provider_response_invalid");
                    boards.push({ id: row.id, name: row.name.slice(0, 512) });
                }
                if (!b.bookmark)
                    return { ...base, boards };
                if (typeof b.bookmark !== "string" || b.bookmark === bookmark || b.bookmark.length > 2048)
                    throw new BrokerError("provider_response_invalid");
                bookmark = b.bookmark;
            }
            throw new BrokerError("discovery_exceeds_limit");
        }
        return { ...base, ...(a.product === "youtube" ? { privacyOptions: ["private", "unlisted", "public"] } : {}) };
    }
    async verifyIdentity(a: Access) {
        if (a.product === "tiktok") {
            const b = await this.http.json("https://open.tiktokapis.com/v2/user/info/?fields=open_id", { headers: bearer(a) });
            if (b.data?.user?.open_id !== a.providerId)
                throw new BrokerError("grant_verification_failed");
        }
        else if (a.product === "pinterest") {
            const b = await this.http.json("https://api.pinterest.com/v5/user_account", { headers: bearer(a) });
            if (b.id !== a.providerId)
                throw new BrokerError("grant_verification_failed");
        }
        else if (a.product === "youtube") {
            const b = await this.http.json("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=50", { headers: bearer(a) });
            if (!Array.isArray(b.items) || !b.items.some((x: any) => x.id === a.providerId))
                throw new BrokerError("grant_verification_failed");
        }
        else {
            const b = await this.http.json(`${this.igBase(a)}/${a.providerId}?fields=id`, { headers: bearer(a) });
            if (String(b.id) !== a.providerId)
                throw new BrokerError("grant_verification_failed");
        }
    }
    validate(d: Delivery, c: Context) {
        if (!c.canPublish)
            throw new BrokerError(c.reason ?? "permission_unavailable");
        const r = d.request;
        if (r.cover && r.product === "tiktok")
            throw new BrokerError("cover_not_supported");
        if (c.limits.maxTitleCharacters && [...r.title].length > c.limits.maxTitleCharacters)
            throw new BrokerError("title_too_long");
        if (c.limits.maxCaptionBytes && Buffer.byteLength(r.caption, "utf8") > c.limits.maxCaptionBytes)
            throw new BrokerError("caption_too_long");
        if (c.limits.forbidAngleBrackets && /[<>]/.test(r.title + r.caption))
            throw new BrokerError("forbidden_text_characters");
        if (c.limits.maxCaptionCharacters && r.caption.length > c.limits.maxCaptionCharacters)
            throw new BrokerError("caption_too_long");
        if (r.product === "tiktok") {
            const o = optionSchemas.tiktok.parse(r.options);
            if (!c.privacyOptions?.includes(o.privacyLevel))
                throw new BrokerError("privacy_option_unavailable");
            if (o.brandContentToggle && o.privacyLevel === "SELF_ONLY")
                throw new BrokerError("branded_content_private_forbidden");
            if ((o.brandContentToggle || o.brandOrganicToggle) && (!o.commercialContentDisclosureConfirmed || o.disclosureVersion !== c.disclosureVersion))
                throw new BrokerError("commercial_disclosure_required");
            const x = c.interactionConstraints;
            if (x && (x.commentDisabled && !o.disableComment || x.duetDisabled && !o.disableDuet || x.stitchDisabled && !o.disableStitch))
                throw new BrokerError("interaction_option_unavailable");
        }
        if (r.product === "pinterest" && !c.boards?.some(b => b.id === r.options.boardId))
            throw new BrokerError("board_not_available");
        if (r.product === "youtube" && !r.title)
            throw new BrokerError("youtube_metadata_invalid");
    }
    async step(d: Delivery, a: Access, path: string, save: SaveCheckpoint, coverPath?: string, mediaPaths?: ProviderMediaPaths): Promise<StepResult> {
        const c = { ...d.checkpoint };
        const assetPath: MediaPath = () => path ? Promise.resolve(path) : mediaPaths?.asset() ?? Promise.reject(new BrokerError("asset_unavailable"));
        const selectedCoverPath: MediaPath = () => coverPath ? Promise.resolve(coverPath) : mediaPaths?.cover?.() ?? Promise.resolve("");
        if (a.product === "instagram")
            return this.instagram(d, a, c, save);
        if (a.product === "youtube")
            return this.youtube(d, a, c, assetPath, save, selectedCoverPath);
        if (a.product === "tiktok")
            return this.tiktok(d, a, c, assetPath, save);
        return this.pinterest(d, a, c, assetPath, save);
    }
    private igBase(a: Access) {
        if (!/^v\d+\.0$/.test(a.apiVersion))
            throw new BrokerError("invalid_provider_config");
        return `https://${a.family === "instagram_login" ? "graph.instagram.com" : "graph.facebook.com"}/${a.apiVersion}`;
    }
    private async instagram(d: Delivery, a: Access, c: Checkpoint, save: SaveCheckpoint): Promise<StepResult> {
        const base = this.igBase(a), r = d.request;
        if (!c.mediaId) {
            if (c.inFlight)
                throw new BrokerError("provider_outcome_unknown");
            c.inFlight = "instagram_create";
            await save(c, "uploading", "container_create");
            const b = await this.http.json(`${base}/${a.providerId}/media`, { method: "POST", headers: bearer(a), body: new URLSearchParams({ media_type: "REELS", video_url: r.asset.fetchUrl, caption: r.caption, share_to_feed: String(r.options.shareToFeed), ...(r.cover ? { cover_url: r.cover.fetchUrl } : {}) }) });
            c.mediaId = id(b.id);
            delete c.inFlight;
            return { state: "processing", stage: "container_processing", checkpoint: c };
        }
        if (c.providerId) {
            const b = await this.http.json(`${base}/${c.providerId}?fields=id,permalink,media_type,media_product_type,owner`, { headers: bearer(a) });
            if (b.id !== c.providerId || b.owner?.id !== a.providerId || b.media_product_type !== "REELS")
                throw new BrokerError("provider_binding_mismatch");
            return { state: "published", stage: "complete", checkpoint: c, providerId: c.providerId, ...(typeof b.permalink === "string" ? { permalink: b.permalink } : {}) };
        }
        const status = await this.http.json(`${base}/${c.mediaId}?fields=id,status_code`, { headers: bearer(a) });
        if (status.id !== c.mediaId)
            throw new BrokerError("provider_binding_mismatch");
        if (status.status_code === "ERROR" || status.status_code === "EXPIRED")
            return { state: "failed", stage: "container_failed", checkpoint: c, failureCode: "provider_processing_failed" };
        if (c.inFlight)
            throw new BrokerError("provider_outcome_unknown");
        if (status.status_code !== "FINISHED")
            return { state: "processing", stage: "container_processing", checkpoint: c };
        c.inFlight = "instagram_publish";
        await save(c, "publishing", "container_publish");
        const b = await this.http.json(`${base}/${a.providerId}/media_publish`, { method: "POST", headers: bearer(a), body: new URLSearchParams({ creation_id: c.mediaId }) });
        c.providerId = id(b.id);
        delete c.inFlight;
        return { state: "processing", stage: "publication_readback", checkpoint: c };
    }
    private async youtube(d: Delivery, a: Access, c: Checkpoint, getPath: MediaPath, save: SaveCheckpoint, getCoverPath: MediaPath): Promise<StepResult> {
        const r = d.request, o = optionSchemas.youtube.parse(r.options);
        if (c.providerId) {
            const b = await this.http.json(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${encodeURIComponent(c.providerId)}`, { headers: bearer(a) });
            const v = b.items?.find((x: any) => x.id === c.providerId);
            if (!v)
                return { state: "processing", stage: "video_readback", checkpoint: c };
            if (v.snippet?.channelId !== a.providerId)
                throw new BrokerError("provider_binding_mismatch");
            if (v.status?.privacyStatus !== o.privacyStatus || v.status?.selfDeclaredMadeForKids !== o.madeForKids)
                throw new BrokerError("privacy_readback_mismatch");
            if (["failed", "rejected", "deleted"].includes(v.status?.uploadStatus) || ["failed", "terminated"].includes(v.processingDetails?.processingStatus))
                return { state: "failed", stage: "processing_failed", checkpoint: c, failureCode: "provider_processing_failed" };
            if (v.status?.uploadStatus !== "processed" || v.processingDetails?.processingStatus !== "succeeded")
                return { state: "processing", stage: "video_processing", checkpoint: c };
            if (r.cover && c.operation !== "youtube_thumbnail_complete") {
                const coverPath = await getCoverPath();
                if (!coverPath)
                    return { state: "processing", stage: "thumbnail_upload", checkpoint: c };
                c.inFlight = "youtube_thumbnail";
                await save(c, "processing", "thumbnail_upload");
                const thumbnail = await this.http.json(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(c.providerId)}`, { ...streamBody(coverPath), method: "POST", headers: { ...bearer(a), "Content-Type": r.cover.mime, "Content-Length": String(r.cover.size) } });
                if (!Array.isArray(thumbnail.items) || thumbnail.items.length !== 1)
                    throw new BrokerError("provider_response_invalid");
                delete c.inFlight;
                c.operation = "youtube_thumbnail_complete";
            }
            return { state: "published", stage: "complete", checkpoint: c, providerId: c.providerId, permalink: `https://www.youtube.com/watch?v=${encodeURIComponent(c.providerId)}` };
        }
        if (!c.sessionUrl) {
            if (c.inFlight)
                throw new BrokerError("provider_outcome_unknown");
            c.inFlight = "youtube_init";
            await save(c, "uploading", "session_create");
            const response = await this.http.raw("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { ...bearer(a), "Content-Type": "application/json", "X-Upload-Content-Length": String(r.asset.size), "X-Upload-Content-Type": r.asset.mime }, body: JSON.stringify({ snippet: { title: r.title, description: r.caption, categoryId: o.categoryId }, status: { privacyStatus: o.privacyStatus, selfDeclaredMadeForKids: o.madeForKids, ...(o.containsSyntheticMedia !== undefined ? { containsSyntheticMedia: o.containsSyntheticMedia } : {}) } }) });
            if (!response.ok)
                throw new BrokerError("provider_unavailable");
            const u = response.headers.get("location");
            if (!u)
                throw new BrokerError("provider_response_invalid");
            providerUrl(u);
            const parsed = new URL(u);
            if (parsed.hostname !== "www.googleapis.com" || parsed.pathname !== "/upload/youtube/v3/videos" || !parsed.searchParams.get("upload_id"))
                throw new BrokerError("provider_host_rejected");
            c.sessionUrl = u;
            c.offset = 0;
            delete c.inFlight;
            return { state: "uploading", stage: "video_upload", checkpoint: c };
        }
        // Always query the known session before sending bytes, including after process restart.
        const probe = await this.http.raw(c.sessionUrl, { method: "PUT", headers: { ...bearer(a), "Content-Length": "0", "Content-Range": `bytes */${r.asset.size}` } });
        if (probe.ok) {
            const b = await responseJson(probe);
            c.providerId = id(b.id);
            delete c.inFlight;
            return { state: "processing", stage: "video_processing", checkpoint: c };
        }
        if (probe.status !== 308)
            throw new BrokerError("provider_outcome_unknown");
        const range = probe.headers.get("range");
        if (range && !/^bytes=0-\d+$/.test(range))
            throw new BrokerError("provider_response_invalid");
        const offset = range ? Number(range.slice(8)) + 1 : 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= r.asset.size)
            throw new BrokerError("provider_outcome_unknown");
        const end = Math.min(offset + 8 * 1024 * 1024, r.asset.size) - 1;
        const path = await getPath();
        c.offset = offset;
        c.inFlight = "youtube_upload";
        await save(c, "uploading", "video_upload");
        const response = await this.http.raw(c.sessionUrl, { ...streamBody(path, offset, end), method: "PUT", headers: { ...bearer(a), "Content-Type": r.asset.mime, "Content-Length": String(end - offset + 1), "Content-Range": `bytes ${offset}-${end}/${r.asset.size}` } });
        if (response.ok) {
            const b = await responseJson(response);
            c.providerId = id(b.id);
            delete c.inFlight;
            return { state: "processing", stage: "video_processing", checkpoint: c };
        }
        if (response.status !== 308)
            throw new BrokerError("provider_outcome_unknown");
        delete c.inFlight;
        c.offset = end + 1;
        return { state: "uploading", stage: "video_upload", checkpoint: c };
    }
    private async tiktok(d: Delivery, a: Access, c: Checkpoint, getPath: MediaPath, save: SaveCheckpoint): Promise<StepResult> {
        const r = d.request, o = optionSchemas.tiktok.parse(r.options);
        if (!c.mediaId) {
            if (c.inFlight)
                throw new BrokerError("provider_outcome_unknown");
            const chunkSize = Math.min(r.asset.size, 10000000), count = Math.max(1, Math.floor(r.asset.size / chunkSize));
            c.inFlight = "tiktok_init";
            await save(c, "uploading", "post_init");
            const b = await this.http.json("https://open.tiktokapis.com/v2/post/publish/video/init/", { method: "POST", headers: { ...bearer(a), "Content-Type": "application/json" }, body: JSON.stringify({ post_info: { title: r.caption, privacy_level: o.privacyLevel, disable_comment: o.disableComment, disable_duet: o.disableDuet, disable_stitch: o.disableStitch, brand_content_toggle: o.brandContentToggle, brand_organic_toggle: o.brandOrganicToggle, is_aigc: o.isAigc }, source_info: { source: "FILE_UPLOAD", video_size: r.asset.size, chunk_size: chunkSize, total_chunk_count: count } }) });
            c.mediaId = id(b.data?.publish_id);
            const url = b.data?.upload_url;
            if (typeof url !== "string")
                throw new BrokerError("provider_response_invalid");
            tiktokUploadUrl(url);
            c.uploadUrl = url;
            delete c.inFlight;
            return { state: "uploading", stage: "video_upload", checkpoint: c };
        }
        const backoff = this.tiktokStatusBackoff(a);
        if (backoff)
            return { state: "processing", stage: c.operation === "tiktok_publish_complete" ? "awaiting_moderation" : "status_poll_backoff", checkpoint: c, pollAfterMs: backoff };
        const b = await this.http.json("https://open.tiktokapis.com/v2/post/publish/status/fetch/", { method: "POST", headers: { ...bearer(a), "Content-Type": "application/json" }, body: JSON.stringify({ publish_id: c.mediaId }) });
        const data = b.data;
        if (!data || typeof data.status !== "string")
            throw new BrokerError("provider_response_invalid");
        if (data.status === "FAILED")
            return { state: "failed", stage: "provider_failed", checkpoint: c, failureCode: "provider_processing_failed" };
        if (data.status === "PUBLISH_COMPLETE") {
            delete c.inFlight;
            c.operation = "tiktok_publish_complete";
            const ids = data.publicaly_available_post_id;
            if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1))
                throw new BrokerError("provider_response_invalid");
            const postId = Array.isArray(ids) && ids.length === 1 ? id(ids[0]) : undefined;
            if (!postId && o.privacyLevel === "PUBLIC_TO_EVERYONE")
                return { state: "processing", stage: "awaiting_moderation", checkpoint: c, pollAfterMs: 60000 };
            return { state: "published", stage: "complete", checkpoint: c, ...(postId ? { providerId: postId } : {}) };
        }
        // Once posting is complete, later status reads must never re-enter byte upload.
        if (c.operation === "tiktok_publish_complete")
            return { state: "processing", stage: "awaiting_moderation", checkpoint: c, pollAfterMs: 60000 };
        if (data.status !== "PROCESSING_UPLOAD")
            return { state: "processing", stage: "post_processing", checkpoint: c };
        const offset = data.uploaded_bytes ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= r.asset.size || !c.uploadUrl)
            throw new BrokerError("provider_outcome_unknown");
        const size = Math.min(r.asset.size, 10000000), count = Math.max(1, Math.floor(r.asset.size / size)), end = offset / size >= count - 1 ? r.asset.size - 1 : offset + size - 1;
        if (offset % size !== 0)
            throw new BrokerError("provider_outcome_unknown");
        const path = await getPath();
        c.inFlight = "tiktok_upload";
        await save(c, "uploading", "video_upload");
        const response = await this.http.raw(c.uploadUrl, { ...streamBody(path, offset, end), method: "PUT", headers: { "Content-Type": r.asset.mime, "Content-Length": String(end - offset + 1), "Content-Range": `bytes ${offset}-${end}/${r.asset.size}` } });
        if (!response.ok)
            throw new BrokerError("provider_outcome_unknown");
        delete c.inFlight;
        c.offset = end + 1;
        return { state: "processing", stage: "post_processing", checkpoint: c };
    }
    private async pinterest(d: Delivery, a: Access, c: Checkpoint, getPath: MediaPath, save: SaveCheckpoint): Promise<StepResult> {
        const r = d.request, o = optionSchemas.pinterest.parse(r.options);
        if (c.providerId) {
            const b = await this.http.json(`https://api.pinterest.com/v5/pins/${c.providerId}`, { headers: bearer(a) });
            if (b.id !== c.providerId || b.board_id !== o.boardId)
                throw new BrokerError("provider_binding_mismatch");
            return { state: "published", stage: "complete", checkpoint: c, providerId: c.providerId, permalink: `https://www.pinterest.com/pin/${c.providerId}/` };
        }
        if (!c.mediaId) {
            if (c.inFlight)
                throw new BrokerError("provider_outcome_unknown");
            c.inFlight = "pinterest_register";
            await save(c, "uploading", "media_register");
            const b = await this.http.json("https://api.pinterest.com/v5/media", { method: "POST", headers: { ...bearer(a), "Content-Type": "application/json" }, body: JSON.stringify({ media_type: "video" }) });
            c.mediaId = id(b.media_id);
            if (typeof b.upload_url !== "string" || providerUrl(b.upload_url).hostname !== "pinterest-media-upload.s3-accelerate.amazonaws.com" || !b.upload_parameters || Object.values(b.upload_parameters).some(x => typeof x !== "string"))
                throw new BrokerError("provider_response_invalid");
            c.uploadUrl = b.upload_url;
            c.uploadParameters = b.upload_parameters;
            delete c.inFlight;
            return { state: "uploading", stage: "media_upload", checkpoint: c };
        }
        const b = await this.http.json(`https://api.pinterest.com/v5/media/${c.mediaId}`, { headers: bearer(a) });
        if (b.media_id !== c.mediaId)
            throw new BrokerError("provider_binding_mismatch");
        if (b.status === "failed")
            return { state: "failed", stage: "media_failed", checkpoint: c, failureCode: "provider_processing_failed" };
        if (b.status === "registered") {
            if (c.inFlight)
                throw new BrokerError("provider_outcome_unknown");
            if (!c.uploadUrl || !c.uploadParameters)
                throw new BrokerError("provider_response_invalid");
            const path = await getPath();
            const boundary = `publishing-${randomUUID()}`;
            const parts: string[] = [];
            for (const [key, value] of Object.entries(c.uploadParameters)) {
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || value.length > 16384 || /[\r\n]/.test(value))
                    throw new BrokerError("provider_response_invalid");
                parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
            }
            const prefix = Buffer.from(parts.join("") + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: ${r.asset.mime}\r\n\r\n`), suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
            async function* body() {
                yield prefix;
                for await (const chunk of createReadStream(path))
                    yield chunk;
                yield suffix;
            }
            const { Readable } = await import("node:stream");
            c.inFlight = "pinterest_upload";
            await save(c, "uploading", "media_upload");
            const response = await this.http.raw(c.uploadUrl, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(prefix.length + r.asset.size + suffix.length) }, body: Readable.from(body()) as unknown as RequestInit["body"], duplex: "half" } as RequestInit);
            if (!response.ok)
                throw new BrokerError("provider_outcome_unknown");
            delete c.inFlight;
            return { state: "processing", stage: "media_processing", checkpoint: c };
        }
        if (b.status !== "succeeded")
            return { state: "processing", stage: "media_processing", checkpoint: c };
        if (c.inFlight && c.inFlight !== "pinterest_upload")
            throw new BrokerError("provider_outcome_unknown");
        c.inFlight = "pinterest_pin";
        await save(c, "publishing", "pin_create");
        const pin = await this.http.json("https://api.pinterest.com/v5/pins", { method: "POST", headers: { ...bearer(a), "Content-Type": "application/json" }, body: JSON.stringify({ board_id: o.boardId, title: r.title, description: r.caption, ...(o.link ? { link: o.link } : {}), ...(o.altText ? { alt_text: o.altText } : {}), media_source: { source_type: "video_id", media_id: c.mediaId, ...(r.cover ? { cover_image_url: r.cover.fetchUrl } : { cover_image_key_frame_time: o.coverImageKeyFrameTime ?? 0 }) } }) });
        c.providerId = id(pin.id);
        delete c.inFlight;
        return { state: "processing", stage: "pin_readback", checkpoint: c };
    }
}
