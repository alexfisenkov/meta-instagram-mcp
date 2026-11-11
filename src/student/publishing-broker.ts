import { canonical, identity, requestBinding, submitSchema, targetHash, type Access, type Asset, type Context, type Delivery, type Receipt, type Submit } from "./publishing-types.js";
import { PublishingStore } from "./publishing-store.js";
import { PublishingProviders } from "./provider-publishing.js";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import { mediaUrl, type MediaPolicy, type ProviderFetch } from "./provider-publishing-http.js";
import { PublishingMediaCache, type MediaLease, type MediaReference } from "./publishing-media-cache.js";
export type AccessResolver = (subject: Subject, connectionId: string) => Promise<Access>;
/** Durable acceptance is separate from a bounded asynchronous provider runner. */
export class PublishingBroker {
    private running = new Set<string>();
    private timer?: ReturnType<typeof setInterval>;
    private stopping = false;
    private readonly mediaCache: PublishingMediaCache;
    private prepared?: Promise<void>;
    constructor(readonly store: PublishingStore, private readonly resolveAccess: AccessResolver, readonly providers: PublishingProviders, readonly mediaPolicy: MediaPolicy, readonly spoolDirectory: string, private readonly fetcher: ProviderFetch = fetch) {
        this.mediaCache = new PublishingMediaCache(spoolDirectory, mediaPolicy, fetcher);
    }
    private cacheReferences(d: Delivery): MediaReference[] {
        if (["published", "failed", "cancelled"].includes(d.receipt.state))
            return [];
        const c = d.checkpoint, r = d.request, refs: MediaReference[] = [];
        const sourceDone = Boolean(c.providerId) || r.product === "instagram" && Boolean(c.mediaId) || (r.product === "tiktok" && (c.operation === "tiktok_publish_complete" || (c.offset ?? 0) >= r.asset.size)) || (r.product === "pinterest" && (c.offset ?? 0) >= r.asset.size);
        if (!sourceDone)
            refs.push({ deliveryId: r.deliveryId, role: "asset", asset: r.asset });
        if (r.cover && !(r.product === "instagram" && c.mediaId) && !(r.product === "youtube" && c.operation === "youtube_thumbnail_complete") && !c.providerId)
            refs.push({ deliveryId: r.deliveryId, role: "cover", asset: r.cover });
        else if (r.cover && r.product === "youtube" && c.operation !== "youtube_thumbnail_complete")
            refs.push({ deliveryId: r.deliveryId, role: "cover", asset: r.cover });
        return refs;
    }
    private prepare(): Promise<void> {
        return this.prepared ??= (async () => {
            const data = await this.store.snapshot();
            await this.mediaCache.reconcile(data.deliveries.flatMap(d => this.cacheReferences(d)));
        })();
    }
    private async cleanCache(d: Delivery): Promise<void> {
        const keep = new Set(this.cacheReferences(d).map(ref => ref.role));
        await Promise.allSettled((["asset", "cover"] as const).filter(role => !keep.has(role) && d.request[role]).map(role => this.mediaCache.discard({ deliveryId: d.request.deliveryId, role, asset: d.request[role]! })));
    }
    async context(subject: Subject, connectionId: string): Promise<Context> {
        return this.providers.context(await this.resolveAccess(subject, connectionId));
    }
    async submit(subject: Subject, raw: unknown): Promise<Receipt> {
        const parsed = submitSchema.safeParse(raw);
        if (!parsed.success)
            throw new BrokerError("invalid_publish_request");
        const input = parsed.data;
        if (targetHash(input) !== input.targetHash)
            throw new BrokerError("target_hash_mismatch");
        const old = (await this.store.snapshot()).deliveries.find(d => d.request.deliveryId === input.deliveryId);
        if (old) {
            if (!sameSubject(old, subject))
                throw new BrokerError("delivery_not_found");
            if (requestBinding(old.request) !== requestBinding(input))
                throw new BrokerError("delivery_payload_conflict");
            return structuredClone(old.receipt);
        }
        if (input.product !== (await this.resolveAccess(subject, input.connectionId)).product)
            throw new BrokerError("connection_product_mismatch");
        mediaUrl(input.asset, this.mediaPolicy);
        if (input.cover)
            mediaUrl(input.cover, this.mediaPolicy);
        const context = await this.context(subject, input.connectionId);
        const now = new Date().toISOString();
        const delivery: Delivery = { ...subject, request: input, receipt: { deliveryId: input.deliveryId, intentId: input.intentId, intentHash: input.intentHash, targetHash: input.targetHash, version: 1, state: "queued", stage: "accepted", retryable: false }, checkpoint: {}, createdAt: now, updatedAt: now };
        this.providers.validate(delivery, context);
        return this.store.transaction(data => {
            if (data.deliveries.length >= 10000)
                throw new BrokerError("publishing_capacity_exceeded");
            const existing = data.deliveries.find(d => d.request.deliveryId === input.deliveryId);
            if (existing) {
                if (!sameSubject(existing, subject))
                    throw new BrokerError("delivery_not_found");
                if (requestBinding(existing.request) !== requestBinding(input))
                    throw new BrokerError("delivery_payload_conflict");
                return structuredClone(existing.receipt);
            }
            data.deliveries.push(delivery);
            return structuredClone(delivery.receipt);
        });
    }
    async status(subject: Subject, id: string) {
        const d = (await this.store.snapshot()).deliveries.find(d => d.request.deliveryId === id && sameSubject(d, subject));
        if (!d)
            throw new BrokerError("delivery_not_found");
        return structuredClone(d.receipt);
    }
    async resume(subject: Subject, input: {
        deliveryId: string;
        expectedVersion: number;
        asset?: Asset;
        cover?: Asset;
    }) {
        return this.store.transaction(data => {
            const d = this.owned(data.deliveries, subject, input.deliveryId);
            if (d.receipt.version !== input.expectedVersion)
                throw new BrokerError("version_conflict");
            if (this.running.has(input.deliveryId))
                throw new BrokerError("delivery_busy");
            if (["published", "cancelled"].includes(d.receipt.state))
                return structuredClone(d.receipt);
            for (const key of ["asset", "cover"] as const) {
                const renewed = input[key];
                if (renewed) {
                    if (!d.request[key] || canonical(identity(renewed)) !== canonical(identity(d.request[key]!)))
                        throw new BrokerError("asset_identity_mismatch");
                    mediaUrl(renewed, this.mediaPolicy);
                    d.request[key] = renewed;
                }
            }
            if (d.checkpoint.inFlight && !d.checkpoint.mediaId && !d.checkpoint.sessionUrl && !d.checkpoint.providerId)
                throw new BrokerError("provider_outcome_unknown");
            if (d.receipt.state === "unknown" && !d.checkpoint.mediaId && !d.checkpoint.sessionUrl && !d.checkpoint.providerId)
                throw new BrokerError("provider_outcome_unknown");
            if (d.receipt.state === "failed" && !d.receipt.retryable)
                throw new BrokerError("delivery_not_retryable");
            d.receipt = { ...d.receipt, version: d.receipt.version + 1, state: "queued", stage: "resume_reconcile", retryable: false };
            delete d.receipt.failureCode;
            delete d.receipt.nextPollAt;
            delete d.processingStartedAt;
            d.updatedAt = new Date().toISOString();
            return structuredClone(d.receipt);
        });
    }
    async cancel(subject: Subject, input: {
        deliveryId: string;
        expectedVersion: number;
    }) {
        const receipt = await this.store.transaction(data => {
            const d = this.owned(data.deliveries, subject, input.deliveryId);
            if (d.receipt.version !== input.expectedVersion)
                throw new BrokerError("version_conflict");
            if (this.running.has(input.deliveryId))
                throw new BrokerError("delivery_busy");
            if (["published", "cancelled"].includes(d.receipt.state))
                return structuredClone(d.receipt);
            if (d.checkpoint.inFlight || d.checkpoint.providerId || d.checkpoint.operation === "tiktok_publish_complete" || d.request.product === "tiktok" && (d.checkpoint.offset ?? 0) >= d.request.asset.size)
                throw new BrokerError("provider_outcome_unknown");
            d.receipt = { ...d.receipt, version: d.receipt.version + 1, state: "cancelled", stage: "cancelled_locally", retryable: false };
            delete d.receipt.nextPollAt;
            return structuredClone(d.receipt);
        });
        const d = (await this.store.snapshot()).deliveries.find(d => d.request.deliveryId === input.deliveryId && sameSubject(d, subject));
        if (d)
            await this.cleanCache(d);
        return receipt;
    }
    start() {
        if (!this.timer) {
            this.timer = setInterval(() => {
                void this.tick().catch(() => undefined);
            }, 2000);
            this.timer.unref();
        }
    }
    async stop() {
        this.stopping = true;
        if (this.timer)
            clearInterval(this.timer);
        while (this.running.size)
            await new Promise(r => setTimeout(r, 20));
    }
    async tick() {
        if (this.stopping)
            return;
        const data = await this.store.snapshot();
        const connectionKey = (d: Delivery) => `${d.tenantId}:${d.sub}:${d.request.connectionId}`;
        const occupied = new Set(data.deliveries.filter(d => this.running.has(d.request.deliveryId)).map(connectionKey));
        const candidates = data.deliveries.filter(d => ["queued", "uploading", "processing", "publishing"].includes(d.receipt.state) && (!d.receipt.nextPollAt || Date.parse(d.receipt.nextPollAt) <= Date.now()) && !this.running.has(d.request.deliveryId)).sort((a, b) => Number(b.receipt.state === "uploading") - Number(a.receipt.state === "uploading"));
        const due: Delivery[] = [];
        for (const d of candidates) {
            if (due.length >= Math.max(0, 2 - this.running.size))
                break;
            const key = connectionKey(d);
            if (occupied.has(key))
                continue;
            occupied.add(key);
            due.push(d);
        }
        await Promise.all(due.map(d => this.run(d)));
    }
    private owned(deliveries: Delivery[], subject: Subject, id: string) {
        const d = deliveries.find(d => d.request.deliveryId === id && sameSubject(d, subject));
        if (!d)
            throw new BrokerError("delivery_not_found");
        return d;
    }
    private async run(original: Delivery) {
        const id = original.request.deliveryId;
        if (this.running.has(id))
            return;
        this.running.add(id);
        let media: MediaLease | undefined, cover: MediaLease | undefined;
        try {
            if (original.processingStartedAt && Date.now() - Date.parse(original.processingStartedAt) > 24 * 60 * 60 * 1000)
                throw new BrokerError("provider_processing_timeout");
            const a = await this.resolveAccess(original, original.request.connectionId);
            if (a.product !== original.request.product)
                throw new BrokerError("connection_product_mismatch");
            const checkpoint = original.checkpoint;
            const hasKnownOperation = checkpoint.providerId || (a.product === "youtube" ? checkpoint.sessionUrl : checkpoint.mediaId);
            if (!hasKnownOperation)
                this.providers.validate(original, await this.providers.context(a));
            // Known operations reconcile first; media is fetched only if that exact checkpoint needs more bytes.
            const getAssetPath = async () => {
                await this.prepare();
                media ??= await this.mediaCache.acquire({ deliveryId: id, role: "asset", asset: original.request.asset });
                return media.path;
            };
            const getCoverPath = async () => {
                if (!original.request.cover)
                    return "";
                await this.prepare();
                cover ??= await this.mediaCache.acquire({ deliveryId: id, role: "cover", asset: original.request.cover });
                return cover.path;
            };
            if (!hasKnownOperation && !checkpoint.inFlight) {
                await getAssetPath();
                if (original.request.cover)
                    await getCoverPath();
            }
            const step = await this.providers.step(original, a, media?.path ?? "", async (cp, state, stage) => {
                if (cp.inFlight === "instagram_create") {
                    mediaUrl(original.request.asset, this.mediaPolicy);
                    if (original.request.cover)
                        mediaUrl(original.request.cover, this.mediaPolicy);
                }
                if (cp.inFlight === "pinterest_pin" && original.request.cover)
                    mediaUrl(original.request.cover, this.mediaPolicy);
                const current = await this.resolveAccess(original, original.request.connectionId);
                if (current.product !== a.product || current.providerId !== a.providerId)
                    throw new BrokerError("provider_binding_mismatch");
                this.providers.validate(original, await this.providers.context(current));
                Object.assign(a, current);
                await this.store.transaction(data => {
                    const d = this.owned(data.deliveries, original, id);
                    if (d.receipt.state === "cancelled")
                        throw new BrokerError("delivery_cancelled");
                    d.checkpoint = structuredClone(cp);
                    d.receipt = { ...d.receipt, version: d.receipt.version + 1, state, stage, retryable: false };
                    d.updatedAt = new Date().toISOString();
                });
            }, cover?.path, { asset: getAssetPath, cover: getCoverPath });
            await this.store.transaction(data => {
                const d = this.owned(data.deliveries, original, id);
                d.checkpoint = step.checkpoint;
                if (step.state === "processing")
                    d.processingStartedAt ??= new Date().toISOString();
                d.receipt = { ...d.receipt, version: d.receipt.version + 1, state: step.state, stage: step.stage, retryable: false, ...(step.failureCode ? { failureCode: step.failureCode } : {}), ...(step.providerId ? { providerId: step.providerId } : {}), ...(step.permalink ? { permalink: step.permalink } : {}) };
                if (!["published", "failed", "cancelled", "unknown"].includes(step.state))
                    d.receipt.nextPollAt = new Date(Date.now() + (step.pollAfterMs ?? (step.state === "uploading" ? 0 : a.product === "instagram" ? 60000 : 15000))).toISOString();
                else
                    delete d.receipt.nextPollAt;
                d.updatedAt = new Date().toISOString();
            });
        }
        catch (e) {
            const safe = new Set(["asset_lease_rejected", "asset_unavailable", "asset_integrity_failed", "asset_size_mismatch", "reauth_required", "permission_unavailable", "write_consent_required", "privacy_readback_mismatch", "provider_binding_mismatch", "grant_verification_failed", "provider_outcome_unknown", "provider_response_invalid", "commercial_disclosure_required", "privacy_option_unavailable", "interaction_option_unavailable", "board_not_available", "provider_unavailable", "provider_processing_timeout", "title_too_long", "caption_too_long", "forbidden_text_characters", "media_cache_capacity_exceeded"]);
            const code = e instanceof BrokerError && safe.has(e.code) ? e.code : "publishing_failed";
            await this.store.transaction(data => {
                const d = this.owned(data.deliveries, original, id);
                const unknown = Boolean(d.checkpoint.inFlight) || ["provider_outcome_unknown", "provider_processing_timeout"].includes(code);
                const recoverable = unknown || ["asset_lease_rejected", "asset_unavailable", "provider_unavailable", "reauth_required", "media_cache_capacity_exceeded"].includes(code);
                d.receipt = { ...d.receipt, version: d.receipt.version + 1, state: unknown ? "unknown" : "failed", stage: "stopped", failureCode: code, retryable: recoverable && Boolean(d.checkpoint.mediaId || d.checkpoint.sessionUrl || d.checkpoint.providerId || !d.checkpoint.inFlight) };
                delete d.receipt.nextPollAt;
            }).catch(() => undefined);
        }
        finally {
            media?.release();
            cover?.release();
            const latest = (await this.store.snapshot().catch(() => undefined))?.deliveries.find(d => d.request.deliveryId === id && sameSubject(d, original));
            if (latest)
                await this.cleanCache(latest);
            this.running.delete(id);
        }
    }
}
