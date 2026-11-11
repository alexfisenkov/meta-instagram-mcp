import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BrokerError } from "./types.js";
import { ensurePrivateFile } from "../private-fs.js";
import type { Asset } from "./publishing-types.js";
export type ProviderFetch = typeof fetch;
export function providerUrl(value: string): URL {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.port || u.username || u.password || u.hash)
        throw new BrokerError("provider_host_rejected");
    const allowed: Record<string, RegExp> = { "graph.instagram.com": /^\/v\d+\.0\/[A-Za-z0-9_]+(?:\/media|\/media_publish)?$/, "graph.facebook.com": /^\/v\d+\.0\/[A-Za-z0-9_]+(?:\/media|\/media_publish)?$/, "www.googleapis.com": /^\/(?:upload\/youtube\/v3\/(?:videos|thumbnails\/set)|youtube\/v3\/(?:channels|videos))$/, "oauth2.googleapis.com": /^\/token$/, "openidconnect.googleapis.com": /^\/v1\/userinfo$/, "open.tiktokapis.com": /^\/v2\/(?:oauth\/token|user\/info|post\/publish\/(?:creator_info\/query|video\/init|status\/fetch))\/$/, "open-upload.tiktokapis.com": /^\/video\/$/, "upload.us.tiktokapis.com": /^\/video\/$/, "api.pinterest.com": /^\/v5\/(?:oauth\/token|user_account|boards|boards\/\d+|media|media\/\d+|pins|pins\/\d+)$/, "pinterest-media-upload.s3-accelerate.amazonaws.com": /^\/$/ };
    if (!allowed[u.hostname]?.test(u.pathname))
        throw new BrokerError("provider_host_rejected");
    if (["open-upload.tiktokapis.com", "upload.us.tiktokapis.com"].includes(u.hostname)) {
        const allowedKeys = new Set(["upload_id", "upload_token"]);
        if (!u.searchParams.get("upload_id") || [...u.searchParams.keys()].some(key => !allowedKeys.has(key) || u.searchParams.getAll(key).length !== 1 || !/^[\x21-\x7e]{1,4096}$/.test(u.searchParams.get(key)!)))
            throw new BrokerError("provider_path_rejected");
    }
    return u;
}
export function tiktokUploadUrl(value: string): URL {
    const parsed = providerUrl(value);
    if (!["open-upload.tiktokapis.com", "upload.us.tiktokapis.com"].includes(parsed.hostname))
        throw new BrokerError("provider_host_rejected");
    return parsed;
}
export async function responseJson(response: Response): Promise<Record<string, any>> {
    if (!response.body)
        return {};
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > 1048576)
                throw new BrokerError("provider_response_too_large");
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
    if (!size)
        return {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"), (_key: string, value: unknown, context?: {
            source?: string;
        }) => {
            if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value)) {
                if (context?.source && /^-?[0-9]+$/.test(context.source))
                    return context.source;
                throw new Error("unsafe_provider_integer");
            }
            return value;
        });
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error();
        return parsed;
    }
    catch {
        throw new BrokerError("provider_response_invalid");
    }
}
export class PublishingHttp {
    constructor(readonly fetcher: ProviderFetch = fetch) {
    }
    async raw(url: string, init: RequestInit = {}): Promise<Response> {
        providerUrl(url);
        try {
            return await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20000) });
        }
        catch {
            throw new BrokerError("provider_unavailable");
        }
    }
    async json(url: string, init: RequestInit = {}): Promise<Record<string, any>> {
        const r = await this.raw(url, init);
        const b = await responseJson(r);
        const endpoint = new URL(url);
        if (r.status === 403 && endpoint.hostname === "open.tiktokapis.com" && endpoint.pathname === "/v2/post/publish/video/init/" && b.error?.code === "url_ownership_unverified" && b.data?.publish_id === undefined)
            throw new BrokerError("url_ownership_unverified");
        if (!r.ok || b.error && b.error.code !== "ok")
            throw new BrokerError(r.status === 401 ? "reauth_required" : r.status === 403 ? "permission_unavailable" : "provider_unavailable");
        return b;
    }
}
export interface MediaPolicy {
    origin: string;
    pathPrefix: string;
    maxBytes: number;
}
export function mediaUrl(asset: Asset, policy: MediaPolicy): URL {
    const u = new URL(asset.fetchUrl), o = new URL(policy.origin);
    if (o.origin !== policy.origin || o.protocol !== "https:" || !policy.pathPrefix.startsWith("/") || !policy.pathPrefix.endsWith("/") || u.origin !== o.origin || !u.pathname.startsWith(policy.pathPrefix) || !/^[-A-Za-z0-9_]+$/.test(u.pathname.slice(policy.pathPrefix.length)) || u.username || u.password || u.hash || u.search || asset.size > policy.maxBytes || Date.parse(asset.expiresAt) <= Date.now())
        throw new BrokerError("asset_lease_rejected");
    return u;
}
/** Verify the entire source before any provider mutation, using a private disk spool. */
export async function spoolMedia(asset: Asset, policy: MediaPolicy, directory: string, fetcher: ProviderFetch = fetch, deliveryId?: string): Promise<{
    path: string;
    cleanup(): Promise<void>;
}> {
    if (deliveryId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId))
        throw new BrokerError("invalid_media_cache_binding");
    const u = mediaUrl(asset, policy), path = join(directory, `.media-${deliveryId ? deliveryId + "-" : ""}${asset.id}-${crypto.randomUUID()}`);
    const file = await open(path, "wx", 0o600);
    let good = false;
    try {
        await ensurePrivateFile(path);
        const response = await fetcher(u, { redirect: "error", signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.body)
            throw new BrokerError("asset_unavailable");
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > asset.size)
                throw new BrokerError("asset_size_mismatch");
            hash.update(chunk);
            await file.writeFile(chunk);
        }
        if (size !== asset.size || hash.digest("hex") !== asset.sha256)
            throw new BrokerError("asset_integrity_failed");
        await file.sync();
        good = true;
        return { path, cleanup: () => unlink(path).catch(() => undefined) };
    }
    finally {
        await file.close();
        if (!good)
            await unlink(path).catch(() => undefined);
    }
}
export async function* readMedia(path: string, start?: number, end?: number): AsyncGenerator<Buffer> {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        if (!(await file.stat()).isFile())
            throw new BrokerError("asset_integrity_failed");
        for await (const chunk of file.createReadStream({ autoClose: false, ...(start === undefined ? {} : { start, end }) }))
            yield chunk;
    }
    finally {
        await file.close();
    }
}
export function streamBody(path: string, start?: number, end?: number): RequestInit {
    return { body: Readable.from(readMedia(path, start, end)) as unknown as RequestInit["body"], duplex: "half" } as RequestInit;
}
