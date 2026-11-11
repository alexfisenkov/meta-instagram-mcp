import { canonical, identity, requestBinding, submitSchema, targetHash, type Access, type Asset, type Context, type Delivery, type Receipt, type Submit } from "./publishing-types.js";
import { PublishingStore } from "./publishing-store.js";
import { PublishingProviders } from "./provider-publishing.js";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import { mediaUrl, spoolMedia, type MediaPolicy, type ProviderFetch } from "./provider-publishing-http.js";
export type AccessResolver = (subject: Subject, connectionId: string) => Promise<Access>;
/** Durable acceptance is separate from a bounded asynchronous provider runner. */
export class PublishingBroker {
    private running = new Set<string>();
    private timer?: ReturnType<typeof setInterval>;
    private stopping = false;
    constructor(readonly store: PublishingStore, private readonly resolveAccess: AccessResolver, readonly providers: PublishingProviders, readonly mediaPolicy: MediaPolicy, readonly spoolDirectory: string, private readonly fetcher: ProviderFetch = fetch) {
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
        return this.store.transaction(data => {
            const d = this.owned(data.deliveries, subject, input.deliveryId);
            if (d.receipt.version !== input.expectedVersion)
                throw new BrokerError("version_conflict");
            if (this.running.has(input.deliveryId))
                throw new BrokerError("delivery_busy");
            if (["published", "cancelled"].includes(d.receipt.state))
                return structuredClone(d.receipt);
            if (d.checkpoint.inFlight || d.checkpoint.providerId || d.request.product === "tiktok" && (d.checkpoint.offset ?? 0) >= d.request.asset.size)
                throw new BrokerError("provider_outcome_unknown");
            d.receipt = { ...d.receipt, version: d.receipt.version + 1, state: "cancelled", stage: "cancelled_locally", retryable: false };
            delete d.receipt.nextPollAt;
            return structuredClone(d.receipt);
        });
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
        const due = (await this.store.snapshot()).deliveries.filter(d => ["queued", "uploading", "processing", "publishing"].includes(d.receipt.state) && (!d.receipt.nextPollAt || Date.parse(d.receipt.nextPollAt) <= Date.now()) && !this.running.has(d.request.deliveryId)).slice(0, Math.max(0, 2 - this.running.size));
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
        let media: Awaited<ReturnType<typeof spoolMedia>> | undefined, cover: typeof media;
        try {
            if (original.processingStartedAt && Date.now() - Date.parse(original.processingStartedAt) > 24 * 60 * 60 * 1000)
                throw new BrokerError("provider_processing_timeout");
            const a = await this.resolveAccess(original, original.request.connectionId);
            if (a.product !== original.request.product)
                throw new BrokerError("connection_product_mismatch");
            const context = await this.providers.context(a);
            this.providers.validate(original, context);
            // A readback on a known provider ID/session does not depend on a renewable ingestion URL.
            const needsBytes = !original.checkpoint.providerId && (a.product !== "instagram" || !original.checkpoint.mediaId) && (a.product !== "pinterest" || !original.checkpoint.mediaId || original.receipt.stage === "media_upload");
            if (needsBytes)
                media = await spoolMedia(original.request.asset, this.mediaPolicy, this.spoolDirectory, this.fetcher);
            if (original.request.cover && (!original.checkpoint.providerId && !original.checkpoint.mediaId || a.product === "youtube" && original.checkpoint.providerId && original.checkpoint.operation !== "youtube_thumbnail_complete"))
                cover = await spoolMedia(original.request.cover, this.mediaPolicy, this.spoolDirectory, this.fetcher);
            const step = await this.providers.step(original, a, media?.path ?? "", async (cp, state, stage) => {
                await this.store.transaction(data => {
                    const d = this.owned(data.deliveries, original, id);
                    if (d.receipt.state === "cancelled")
                        throw new BrokerError("delivery_cancelled");
                    d.checkpoint = structuredClone(cp);
                    d.receipt = { ...d.receipt, version: d.receipt.version + 1, state, stage, retryable: false };
                    d.updatedAt = new Date().toISOString();
                });
            }, cover?.path);
            await this.store.transaction(data => {
                const d = this.owned(data.deliveries, original, id);
                d.checkpoint = step.checkpoint;
                if (step.state === "processing")
                    d.processingStartedAt ??= new Date().toISOString();
                d.receipt = { ...d.receipt, version: d.receipt.version + 1, state: step.state, stage: step.stage, retryable: false, ...(step.failureCode ? { failureCode: step.failureCode } : {}), ...(step.providerId ? { providerId: step.providerId } : {}), ...(step.permalink ? { permalink: step.permalink } : {}) };
                if (!["published", "failed", "cancelled", "unknown"].includes(step.state))
                    d.receipt.nextPollAt = new Date(Date.now() + (a.product === "instagram" ? 60000 : 15000)).toISOString();
                else
                    delete d.receipt.nextPollAt;
                d.updatedAt = new Date().toISOString();
            });
        }
        catch (e) {
            const safe = new Set(["asset_lease_rejected", "asset_unavailable", "asset_integrity_failed", "asset_size_mismatch", "reauth_required", "permission_unavailable", "write_consent_required", "privacy_readback_mismatch", "provider_binding_mismatch", "grant_verification_failed", "provider_outcome_unknown", "provider_response_invalid", "commercial_disclosure_required", "privacy_option_unavailable", "interaction_option_unavailable", "board_not_available", "provider_unavailable", "provider_processing_timeout"]);
            const code = e instanceof BrokerError && safe.has(e.code) ? e.code : "publishing_failed";
            await this.store.transaction(data => {
                const d = this.owned(data.deliveries, original, id);
                const unknown = Boolean(d.checkpoint.inFlight) || ["provider_outcome_unknown", "provider_processing_timeout"].includes(code);
                const recoverable = unknown || ["asset_lease_rejected", "asset_unavailable", "provider_unavailable", "reauth_required"].includes(code);
                d.receipt = { ...d.receipt, version: d.receipt.version + 1, state: unknown ? "unknown" : "failed", stage: "stopped", failureCode: code, retryable: recoverable && Boolean(d.checkpoint.mediaId || d.checkpoint.sessionUrl || d.checkpoint.providerId || !d.checkpoint.inFlight) };
                delete d.receipt.nextPollAt;
            }).catch(() => undefined);
        }
        finally {
            await Promise.allSettled([media?.cleanup(), cover?.cleanup()]);
            this.running.delete(id);
        }
    }
}
