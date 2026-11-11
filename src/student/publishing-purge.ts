import { isAbsolute, join } from "node:path";
import { lstat, opendir, unlink } from "node:fs/promises";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import { StudentVault } from "./vault.js";
import { PublishingStore } from "./publishing-store.js";
import { publishingCacheBinding } from "./publishing-media-cache.js";
export interface PublishingPurgeReport {
    connections: number;
    grants: number;
    events: number;
    states: number;
    generations: number;
    deliveries?: number;
    mediaCacheFiles?: number;
}
/** Offline only. The same writer lock covers the full bounded cache-first / vault-second operation. */
export async function purgePublishingSubject(directory: string, key: Buffer, subject: Subject, options: {
    maxEntries?: number;
} = {}): Promise<PublishingPurgeReport> {
    const empty = { connections: 0, grants: 0, events: 0, states: 0, generations: 0 };
    if (subject.tenantId !== "masterskaya" || !/^[A-Za-z0-9_-]{1,128}$/.test(subject.sub))
        throw new BrokerError("invalid_purge_subject");
    const maxEntries = options.maxEntries ?? 30000;
    if (!isAbsolute(directory))
        throw new BrokerError("invalid_purge_directory");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 30000)
        throw new BrokerError("invalid_purge_limit");
    const namespace = join(directory, "publishing");
    try {
        const info = await lstat(namespace);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new BrokerError("vault_integrity_failed");
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return empty;
        throw error;
    }
    const vault = await StudentVault.open(namespace, key);
    try {
        const store = new PublishingStore(vault), before = await store.snapshot();
        const records = before.connections.length + before.states.length + before.deliveries.length + Object.keys(before.generations).length;
        if (records > 1000000)
            throw new BrokerError("purge_capacity_exceeded");
        const owned = before.deliveries.filter(d => sameSubject(d, subject));
        const assetsByDelivery = new Map(owned.map(d => [d.request.deliveryId, new Set([d.request.asset.id, ...(d.request.cover ? [d.request.cover.id] : [])])]));
        const ownedAssets = new Set(owned.flatMap(d => [d.request.asset.id, ...(d.request.cover ? [d.request.cover.id] : [])]));
        const otherAssets = new Set(before.deliveries.filter(d => !sameSubject(d, subject)).flatMap(d => [d.request.asset.id, ...(d.request.cover ? [d.request.cover.id] : [])]));
        const plan = new Set<string>();
        let scanned = 0;
        const scan = async (path: string, optional = false) => {
            try {
                const info = await lstat(path);
                if (!info.isDirectory() || info.isSymbolicLink())
                    throw new BrokerError("publishing_cache_path_rejected");
            }
            catch (error) {
                if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
                    return;
                throw error;
            }
            const entries = await opendir(path);
            for await (const entry of entries) {
                if (++scanned > maxEntries)
                    throw new BrokerError("purge_capacity_exceeded");
                const binding = publishingCacheBinding(entry.name), legacy = /^\.media-([0-9a-f-]{36})-[0-9a-f-]{36}$/i.exec(entry.name);
                let remove = false;
                if (binding && assetsByDelivery.has(binding.deliveryId)) {
                    if (!assetsByDelivery.get(binding.deliveryId)!.has(binding.assetId))
                        throw new BrokerError("publishing_cache_binding_invalid");
                    remove = true;
                }
                else if (legacy && ownedAssets.has(legacy[1])) {
                    if (otherAssets.has(legacy[1]))
                        throw new BrokerError("publishing_cache_binding_ambiguous");
                    remove = true;
                }
                if (!remove)
                    continue;
                const file = join(path, entry.name), info = await lstat(file);
                if (!info.isFile() && !info.isSymbolicLink())
                    throw new BrokerError("publishing_cache_path_rejected");
                plan.add(file);
            }
        };
        await scan(namespace);
        await scan(join(namespace, ".media-cache"), true);
        let mediaCacheFiles = 0;
        // Leave authenticated subject records intact if filesystem cleanup fails; retry can still identify every copy.
        for (const file of plan) {
            try {
                await unlink(file);
                mediaCacheFiles++;
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
        }
        const prefix = `${subject.tenantId}:${subject.sub}:`;
        const connections = before.connections.filter(c => sameSubject(c, subject)).length, states = before.states.filter(s => sameSubject(s, subject)).length, generations = Object.keys(before.generations).filter(k => k.startsWith(prefix)).length;
        const report = { ...empty, connections, states, generations, deliveries: owned.length, mediaCacheFiles };
        if (connections || states || generations || owned.length)
            await store.transaction(data => {
                data.connections = data.connections.filter(c => !sameSubject(c, subject));
                data.states = data.states.filter(s => !sameSubject(s, subject));
                data.deliveries = data.deliveries.filter(d => !sameSubject(d, subject));
                data.generations = Object.fromEntries(Object.entries(data.generations).filter(([k]) => !k.startsWith(prefix)));
            });
        return report;
    }
    finally {
        await vault.close();
    }
}
