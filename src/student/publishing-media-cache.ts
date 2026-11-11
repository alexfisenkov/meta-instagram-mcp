import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory, assertPrivateFile } from "../private-fs.js";
import { BrokerError } from "./types.js";
import type { Asset } from "./publishing-types.js";
import { spoolMedia, type MediaPolicy, type ProviderFetch } from "./provider-publishing-http.js";
export type MediaRole = "asset" | "cover";
export interface MediaReference {
    deliveryId: string;
    role: MediaRole;
    asset: Asset;
}
export interface MediaLease {
    path: string;
    release(): void;
}
interface Entry {
    size: number;
    lastUsed: number;
    inUse: number;
    verified?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cacheName = /^cache-[0-9a-f-]{36}-(?:asset|cover)-[0-9a-f-]{36}-[0-9a-f]{64}$/i;
const temporaryName = /^\.media-(?:[0-9a-f-]{36}-)?[0-9a-f-]{36}-[0-9a-f-]{36}$/i;
export function publishingCacheBinding(name: string): {
    deliveryId: string;
    assetId: string;
    temporary: boolean;
} | undefined {
    const cached = /^cache-([0-9a-f-]{36})-(?:asset|cover)-([0-9a-f-]{36})-[0-9a-f]{64}$/i.exec(name);
    const temporary = /^\.media-([0-9a-f-]{36})-([0-9a-f-]{36})-[0-9a-f-]{36}$/i.exec(name);
    const match = cached ?? temporary;
    if (!match || !uuid.test(match[1]) || !uuid.test(match[2]))
        return undefined;
    return { deliveryId: match[1], assetId: match[2], temporary: Boolean(temporary) };
}
function fingerprint(s: BigIntStats): string {
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}
/** Disposable, bounded verified copies only. Originals and caller-supplied filesystem paths are never touched. */
export class PublishingMediaCache {
    readonly directory: string;
    private entries = new Map<string, Entry>();
    private tail: Promise<unknown> = Promise.resolve();
    private initialized = false;
    constructor(directory: string, private readonly policy: MediaPolicy, private readonly fetcher: ProviderFetch = fetch, private readonly maxBytes = policy.maxBytes * 2) {
        this.directory = join(directory, ".media-cache");
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
            throw new BrokerError("invalid_media_cache_limit");
    }
    private name(ref: MediaReference): string {
        if (!uuid.test(ref.deliveryId) || !uuid.test(ref.asset.id) || !/^[a-f0-9]{64}$/.test(ref.asset.sha256) || !["asset", "cover"].includes(ref.role) || !Number.isSafeInteger(ref.asset.size) || ref.asset.size <= 0)
            throw new BrokerError("invalid_media_cache_binding");
        return `cache-${ref.deliveryId}-${ref.role}-${ref.asset.id}-${ref.asset.sha256}`;
    }
    private serial<T>(run: () => Promise<T>): Promise<T> {
        const result = this.tail.then(run);
        this.tail = result.catch(() => undefined);
        return result;
    }
    private async initialize(): Promise<void> {
        if (this.initialized)
            return;
        await ensurePrivateDirectory(this.directory);
        for (const name of await readdir(this.directory)) {
            const path = join(this.directory, name);
            if (temporaryName.test(name)) {
                await unlink(path);
                continue;
            }
            if (!cacheName.test(name))
                continue;
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size > this.policy.maxBytes) {
                await unlink(path);
                continue;
            }
            try {
                await assertPrivateFile(path);
            }
            catch {
                await unlink(path);
                continue;
            }
            this.entries.set(name, { size: info.size, lastUsed: info.mtimeMs, inUse: 0 });
        }
        this.initialized = true;
        await this.makeRoom(0);
    }
    private async remove(name: string): Promise<void> {
        const e = this.entries.get(name);
        if (e?.inUse)
            throw new BrokerError("media_cache_busy");
        await unlink(join(this.directory, name)).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        });
        this.entries.delete(name);
    }
    private async makeRoom(bytes: number): Promise<void> {
        let used = [...this.entries.values()].reduce((n, e) => n + e.size, 0);
        for (const [name, e] of [...this.entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
            if (used + bytes <= this.maxBytes)
                break;
            if (e.inUse)
                continue;
            await this.remove(name);
            used -= e.size;
        }
        if (used + bytes > this.maxBytes)
            throw new BrokerError("media_cache_capacity_exceeded");
    }
    private async verified(name: string, asset: Asset): Promise<boolean> {
        const path = join(this.directory, name), entry = this.entries.get(name);
        if (!entry)
            return false;
        try {
            const info = await lstat(path, { bigint: true });
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size !== BigInt(asset.size))
                return false;
            await assertPrivateFile(path);
            const current = fingerprint(info);
            if (entry.verified === current)
                return true;
            const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
                const before = await file.stat({ bigint: true });
                if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(asset.size))
                    return false;
                const hash = createHash("sha256");
                let size = 0;
                for await (const chunk of file.createReadStream({ autoClose: false })) {
                    size += chunk.length;
                    if (size > asset.size)
                        return false;
                    hash.update(chunk);
                }
                const after = await file.stat({ bigint: true });
                if (fingerprint(before) !== fingerprint(after) || size !== asset.size || hash.digest("hex") !== asset.sha256)
                    return false;
                entry.verified = fingerprint(after);
                return true;
            }
            finally {
                await file.close();
            }
        }
        catch (error) {
            if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
                return false;
            throw error;
        }
    }
    acquire(ref: MediaReference): Promise<MediaLease> {
        return this.serial(async () => {
            await this.initialize();
            const name = this.name(ref), path = join(this.directory, name);
            if (!await this.verified(name, ref.asset)) {
                if (this.entries.has(name))
                    await this.remove(name);
                await this.makeRoom(ref.asset.size);
                const temporary = await spoolMedia(ref.asset, this.policy, this.directory, this.fetcher, ref.deliveryId);
                try {
                    await rename(temporary.path, path);
                    this.entries.set(name, { size: ref.asset.size, lastUsed: Date.now(), inUse: 0 });
                    if (!await this.verified(name, ref.asset)) {
                        await this.remove(name);
                        throw new BrokerError("asset_integrity_failed");
                    }
                }
                finally {
                    await temporary.cleanup();
                }
            }
            const entry = this.entries.get(name)!;
            entry.inUse++;
            entry.lastUsed = Date.now();
            let released = false;
            return { path, release: () => {
                    if (!released) {
                        released = true;
                        entry.inUse--;
                    }
                } };
        });
    }
    discard(ref: MediaReference): Promise<void> {
        return this.serial(async () => {
            await this.initialize();
            await this.remove(this.name(ref));
        });
    }
    reconcile(keep: MediaReference[]): Promise<void> {
        return this.serial(async () => {
            await this.initialize();
            const names = new Set(keep.map(ref => this.name(ref)));
            for (const name of [...this.entries.keys()])
                if (!names.has(name))
                    await this.remove(name);
        });
    }
}
