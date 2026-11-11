import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StudentVault } from "../src/student/vault.js";
import { PublishingStore } from "../src/student/publishing-store.js";
import { ConnectionsStore } from "../src/student/connections-store.js";
import { purgeStudentSubject } from "../src/student/purge-subject.js";
import type { Submit } from "../src/student/publishing-types.js";
const cleanup: (() => Promise<unknown>)[] = [], a = { tenantId: "masterskaya", sub: "synthetic-a" }, b = { tenantId: "masterskaya", sub: "synthetic-ab" }, key = Buffer.alloc(32, 19);
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "purge-all-stores-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const vaults: Record<string, StudentVault> = {};
  for (const name of ["meta", "youtube", "connections", "publishing"]) {
    vaults[name] = await StudentVault.open(name === "meta" ? directory : join(directory, name), key); cleanup.push(() => vaults[name].close());
  }
  for (const name of ["meta", "youtube"]) await vaults[name].transaction(d => {
    for (const s of [a, b]) d.connections.push({ ...s, id: randomUUID(), grantId: randomUUID(), product: name === "youtube" ? "youtube" : "instagram", providerId: s.sub, label: "Fictitious", capabilities: ["account"], status: "connected", updatedAt: new Date().toISOString() });
  });
  await new ConnectionsStore(vaults.connections).transaction(d => {
    for (const s of [a, b]) {
      d.grants.push({ ...s, id: s.sub, product: "twitch", actorId: s.sub, accessToken: "synthetic-private", scopes: [], expiresAt: Date.now() + 3600000, fingerprint: "f".repeat(64), status: "active", validatedAt: Date.now() });
      d.resources.push({ ...s, id: randomUUID(), grantId: s.sub, product: "twitch", providerId: s.sub, kind: "account", label: "Fictitious", capabilities: ["account"], status: "connected" });
    }
  });
  const deliveries: Submit[] = [];
  await new PublishingStore(vaults.publishing).transaction(d => {
    for (const s of [a, b]) {
      const request: Submit = { deliveryId: randomUUID(), intentId: randomUUID(), intentHash: "a".repeat(64), targetHash: "b".repeat(64), connectionId: randomUUID(), product: "tiktok", asset: { id: randomUUID(), sha256: "c".repeat(64), size: 12, mime: "video/mp4", fetchUrl: "https://example.test/asset", expiresAt: "2027-01-01T00:00:00Z" }, title: "Fictitious", caption: "Fictitious", options: {} }; deliveries.push(request);
      d.connections.push({ ...s, id: request.connectionId, product: "tiktok", providerId: s.sub, label: "Fictitious", accessToken: "synthetic-private", refreshToken: "synthetic-refresh", scopes: ["user.info.basic"], expiresAt: Date.now() + 3600000, status: "connected", configFingerprint: "f".repeat(64) });
      d.deliveries.push({ ...s, request, receipt: { deliveryId: request.deliveryId, intentId: request.intentId, intentHash: request.intentHash, targetHash: request.targetHash, version: 1, state: "unknown", stage: "uploading", retryable: false }, checkpoint: { inFlight: "tiktok_upload", uploadUrl: "https://example.test/private-upload" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
  });
  const cache = join(directory, "publishing", ".media-cache"); await mkdir(cache, { mode: 0o700 });
  const cachePaths = deliveries.map(r => join(cache, `cache-${r.deliveryId}-asset-${r.asset.id}-${r.asset.sha256}`));
  for (const file of cachePaths) await writeFile(file, "fictitious-cache", { mode: 0o600 });
  const original = join(directory, "original-platform-media.mp4"); await writeFile(original, "original-kept");
  await Promise.all(Object.values(vaults).map(v => v.close()));
  return { directory, vaults, cachePaths, original };
}
async function snapshot(directory: string, name: string, vaultKey = key) {
  const vault = await StudentVault.open(name === "meta" ? directory : join(directory, name), vaultKey);
  try { return name === "connections" ? await new ConnectionsStore(vault).snapshot() : name === "publishing" ? await new PublishingStore(vault).snapshot() : await vault.snapshot(); }
  finally { await vault.close(); }
}
it("the single offline entry removes only one subject from all four stores and its bounded publishing copies", async () => {
  const f = await fixture();
  expect(await purgeStudentSubject(f.directory, key, a)).toEqual({ connections: 4, grants: 1, events: 0, states: 0, generations: 0, deliveries: 1, mediaCacheFiles: 1 });
  for (const name of ["meta", "youtube", "connections", "publishing"]) {
    const remaining = await snapshot(f.directory, name);
    expect(JSON.stringify(remaining)).not.toContain('"sub":"synthetic-a"'); expect(JSON.stringify(remaining)).toContain('"sub":"synthetic-ab"');
  }
  await expect(readFile(f.cachePaths[0])).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.cachePaths[1], "utf8")).toBe("fictitious-cache"); expect(await readFile(f.original, "utf8")).toBe("original-kept");
});
it.each(["youtube", "connections", "publishing"])("preflights a busy %s store before changing another store", async name => {
  const f = await fixture(), before = await snapshot(f.directory, "meta"), held = await StudentVault.open(join(f.directory, name), key); cleanup.push(() => held.close());
  await expect(purgeStudentSubject(f.directory, key, a)).rejects.toThrow("writer_locked");
  expect(await snapshot(f.directory, "meta")).toEqual(before); expect(await readFile(f.cachePaths[0], "utf8")).toBe("fictitious-cache");
});
it("preflights a separate wrong-key vault before changing any records or cache", async () => {
  const f = await fixture(), before = await snapshot(f.directory, "meta");
  await rm(join(f.directory, "connections", "vault.json"));
  const wrong = await StudentVault.open(join(f.directory, "connections"), Buffer.alloc(32, 20)); await wrong.transaction(() => undefined); await wrong.close();
  await expect(purgeStudentSubject(f.directory, key, a)).rejects.toThrow("vault_integrity_failed");
  expect(await snapshot(f.directory, "meta")).toEqual(before); expect(await readFile(f.cachePaths[0], "utf8")).toBe("fictitious-cache");
});
it("keeps the main writer lock through each namespace mutation and never reports a failed multi-vault purge as success", async () => {
  const f = await fixture(), transaction = StudentVault.prototype.transaction; let checked = false, calls = 0;
  vi.spyOn(StudentVault.prototype, "transaction").mockImplementation(function(this: StudentVault, ...args: Parameters<StudentVault["transaction"]>) {
    calls++;
    if (calls === 2) return Promise.reject(new Error("synthetic-private-failure"));
    return transaction.call(this, async db => {
      if (!checked) { checked = true; await expect(StudentVault.open(f.directory, key)).rejects.toThrow("writer_locked"); }
      return args[0](db);
    }, args[1]);
  });
  await expect(purgeStudentSubject(f.directory, key, a)).rejects.toThrow("purge_incomplete");
  expect(checked).toBe(true); expect(await readFile(f.original, "utf8")).toBe("original-kept");
});
it("retains the main service lock through all namespace mutations before returning a success receipt", async () => {
  const f = await fixture(), transaction = StudentVault.prototype.transaction; let calls = 0;
  vi.spyOn(StudentVault.prototype, "transaction").mockImplementation(function(this: StudentVault, ...args: Parameters<StudentVault["transaction"]>) {
    return transaction.call(this, async db => {
      calls++; await expect(StudentVault.open(f.directory, key)).rejects.toThrow("writer_locked");
      return args[0](db);
    }, args[1]);
  });
  expect(await purgeStudentSubject(f.directory, key, a)).toMatchObject({ connections: 4, deliveries: 1 });
  expect(calls).toBe(4);
  vi.restoreAllMocks();
  const reopened = await StudentVault.open(f.directory, key); await reopened.close();
});
it("the unified CLI returns a fixed incomplete error and no success counts on a publishing cleanup refusal", async () => {
  const f = await fixture();
  await rm(join(f.directory, "publishing", ".media-cache"), { recursive: true });
  await writeFile(join(f.directory, "publishing", ".media-cache"), "fictitious-invalid-cache", { mode: 0o600 });
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util"), { fileURLToPath } = await import("node:url");
  const command = fileURLToPath(new URL("../src/student/purge-subject.ts", import.meta.url));
  await expect(promisify(execFile)(process.execPath, ["--import", "tsx", command, "--subject", a.sub, "--confirm-purge"], { env: { ...process.env, META_BROKER_STATE_DIR: f.directory, META_BROKER_VAULT_KEY: key.toString("base64") }, timeout: 5000 })).rejects.toMatchObject({ code: 1, stdout: "", stderr: '{"error":"purge_incomplete"}\n' });
  expect(JSON.stringify(await snapshot(f.directory, "meta"))).toContain('"sub":"synthetic-a"');
  expect(await readFile(f.original, "utf8")).toBe("original-kept");
});
