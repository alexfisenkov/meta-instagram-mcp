import { z } from "zod";
import { createHash } from "node:crypto";
import type { Subject } from "./types.js";
export const publishProducts = ["instagram", "youtube", "tiktok", "pinterest"] as const;
export type PublishProduct = typeof publishProducts[number];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const assetSchema = z.object({ id: z.string().uuid(), sha256: hash, size: z.number().int().positive().max(20000000000), mime: z.enum(["video/mp4", "video/quicktime", "image/jpeg", "image/png"]), fetchUrl: z.string().url().max(2048), expiresAt: z.string().datetime({ offset: true }) }).strict();
export type Asset = z.infer<typeof assetSchema>;
export const optionSchemas = {
    instagram: z.object({ shareToFeed: z.boolean() }).strict(),
    youtube: z.object({ privacyStatus: z.enum(["private", "unlisted", "public"]), madeForKids: z.boolean() }).strict(),
    tiktok: z.object({ privacyLevel: z.string().min(1).max(64), disableComment: z.boolean(), disableDuet: z.boolean(), disableStitch: z.boolean(), consent: z.literal(true), brandContentToggle: z.boolean(), brandOrganicToggle: z.boolean(), isAigc: z.boolean(), commercialContentDisclosureConfirmed: z.boolean(), disclosureVersion: z.string().max(128).optional() }).strict(),
    pinterest: z.object({ boardId: z.string().regex(/^\d{1,64}$/), link: z.string().url().max(2048).optional(), altText: z.string().max(500).optional(), coverImageKeyFrameTime: z.number().int().min(0).optional() }).strict(),
};
export const submitSchema = z.object({ deliveryId: z.string().uuid(), intentId: z.string().uuid(), intentHash: hash, targetHash: hash, connectionId: z.string().uuid(), product: z.enum(publishProducts), asset: assetSchema, cover: assetSchema.optional(), title: z.string().max(1000), caption: z.string().max(10000), options: z.record(z.string(), z.unknown()) }).strict().superRefine((v, ctx) => {
    const parsed = optionSchemas[v.product].safeParse(v.options);
    if (!parsed.success)
        ctx.addIssue({ code: "custom", message: "invalid_provider_options" });
    if (!v.asset.mime.startsWith("video/") || v.cover && !v.cover.mime.startsWith("image/"))
        ctx.addIssue({ code: "custom", message: "invalid_media_type" });
});
export type Submit = z.infer<typeof submitSchema>;
export type PublishState = "queued" | "uploading" | "processing" | "publishing" | "published" | "failed" | "unknown" | "cancelled";
export interface Receipt {
    deliveryId: string;
    intentId: string;
    intentHash: string;
    targetHash: string;
    version: number;
    state: PublishState;
    stage: string;
    retryable: boolean;
    failureCode?: string;
    providerId?: string;
    permalink?: string;
    nextPollAt?: string;
}
export interface Context {
    connectionId: string;
    product: PublishProduct;
    accountLabel: string;
    canPublish: boolean;
    reason?: string;
    requirements: string[];
    privacyOptions?: string[];
    boards?: {
        id: string;
        name: string;
    }[];
    limits: {
        maxBytes?: number;
        maxDurationSeconds?: number;
        maxCaptionCharacters?: number;
    };
    disclosureVersion?: string;
    commercialContentDisclosureText?: string;
    interactionConstraints?: {
        commentDisabled: boolean;
        duetDisabled: boolean;
        stitchDisabled: boolean;
    };
}
export interface Access extends Subject {
    connectionId: string;
    product: PublishProduct;
    providerId: string;
    label: string;
    accessToken: string;
    scopes: string[];
    apiVersion: string;
    family?: string;
}
export interface Checkpoint {
    operation?: string;
    sessionUrl?: string;
    mediaId?: string;
    uploadParameters?: Record<string, string>;
    uploadUrl?: string;
    offset?: number;
    inFlight?: string;
    providerId?: string;
}
export interface Delivery extends Subject {
    processingStartedAt?: string;
    request: Submit;
    receipt: Receipt;
    checkpoint: Checkpoint;
    createdAt: string;
    updatedAt: string;
}
export function canonical(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    if (typeof value === "number" && Number.isSafeInteger(value))
        return String(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value).sort().map(k => {
            if (!/^[\x20-\x7e]+$/.test(k))
                throw new Error("canonical_key_invalid");
            return `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`;
        }).join(",")}}`;
    throw new Error("canonical_value_invalid");
}
export function identity(a: Asset) {
    return { id: a.id, sha256: a.sha256, size: a.size, mime: a.mime };
}
export function targetHash(v: Submit): string {
    return createHash("sha256").update(canonical(["social-publish-target-v1", v.connectionId, v.product, { asset: identity(v.asset), cover: v.cover ? identity(v.cover) : null }, v.title, v.caption, v.options])).digest("hex");
}
export function requestBinding(v: Submit): string {
    return canonical({ ...v, asset: identity(v.asset), ...(v.cover ? { cover: identity(v.cover) } : {}) });
}
