import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { StudentVault } from "../src/student/vault.js";
import { purgeStudentSubject } from "../src/student/purge-subject.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "student-purge-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); const key = randomBytes(32), vault = await StudentVault.open(dir, key); cleanup.push(() => vault.close());
  await vault.transaction((db) => { for (const sub of ["student-a", "student-b"]) {
    const binding = { tenantId: "masterskaya", sub, id: `grant-${sub}`, provider: "threads" as const };
    db.grants.push({ ...binding, providerUserId: `provider-${sub}`, configKey: "threads", fingerprint: "fingerprint", scopes: ["threads_basic"], status: "active", createdAt: "now", credential: vault.seal(binding, { accessToken: `private-token-${sub}`, assetTokens: {} }) });
    db.connections.push({ tenantId: "masterskaya", sub, id: `connection-${sub}`, grantId: binding.id, product: "threads", providerId: `provider-${sub}`, label: `private-label-${sub}`, capabilities: ["account"], status: "connected", updatedAt: "now" });
    db.states.push({ tenantId: "masterskaya", sub, hash: `state-${sub}`, product: "threads", provider: "threads", configKey: "threads", fingerprint: "fingerprint", expiresAt: Date.now() + 60_000, returnTarget: "https://platform.example/social", generation: 1 });
    (db.replyAttempts ??= []).push({ tenantId:"masterskaya", sub, intentId:`intent-${sub}`, connectionId:`connection-${sub}`, grantId:binding.id, conversationId:"conversation", textHash:"a".repeat(64), recipientHash:"b".repeat(64), status:"unknown", createdAt:"now", updatedAt:"now" });
    db.generations[JSON.stringify(["masterskaya", sub, "threads"])] = 1;
    db.events.push({ connectionId: `connection-${sub}`, eventId: `message-${sub}`, receivedAt: new Date().toISOString(), data: { text: `private-content-${sub}` } });
  } });
  return { dir, key, vault };
}
it("offline purge refuses the live writer and deletes only the exact subject's entire live state after stop", async () => {
  const { dir, key, vault } = await fixture(), subject = { tenantId: "masterskaya", sub: "student-a" };
  await expect(purgeStudentSubject(dir, key, subject)).rejects.toThrow("writer_locked"); expect((await vault.snapshot()).connections).toHaveLength(2); await vault.close();
  expect(await purgeStudentSubject(dir, key, subject)).toEqual({ connections: 1, grants: 1, events: 1, states: 1, generations: 1 });
  const remaining = await StudentVault.open(dir, key); try { const db = await remaining.snapshot(); expect(db.connections.map((c) => c.sub)).toEqual(["student-b"]); expect(db.grants.map((g) => g.sub)).toEqual(["student-b"]); expect(db.events.map((e) => e.connectionId)).toEqual(["connection-student-b"]); expect(db.states.map((s) => s.sub)).toEqual(["student-b"]); expect(Object.keys(db.generations)).toEqual(['["masterskaya","student-b","threads"]']); expect(JSON.stringify(db)).not.toContain("student-a"); } finally { await remaining.close(); }
});
it("offline purge also removes the subject from the rollback-isolated YouTube vault", async () => {
  const { dir, key, vault } = await fixture(), youtubeVault = await StudentVault.open(join(dir, "youtube"), key); cleanup.push(() => youtubeVault.close());
  await youtubeVault.transaction((db) => {
    const binding = { tenantId: "masterskaya", sub: "student-a", id: "youtube-grant-a", provider: "youtube" as const };
    db.grants.push({ ...binding, providerUserId: "oidc-sub-fixture", configKey: "youtube", fingerprint: "youtube-fingerprint", scopes: ["youtube.readonly"], status: "active", createdAt: "now", credential: youtubeVault.seal(binding, { accessToken: "private-youtube-access", refreshToken: "private-youtube-refresh", assetTokens: {} }) });
    db.connections.push({ tenantId: "masterskaya", sub: "student-a", id: "youtube-connection-a", grantId: binding.id, product: "youtube", providerId: "UC-private-fixture", label: "Private YouTube channel", capabilities: ["account"], status: "connected", updatedAt: "now" });
    db.generations[JSON.stringify(["masterskaya", "student-a", "youtube"])] = 1;
  });
  await vault.close(); await youtubeVault.close();
  expect(await purgeStudentSubject(dir, key, { tenantId: "masterskaya", sub: "student-a" })).toEqual({ connections: 2, grants: 2, events: 1, states: 1, generations: 2 });
  const remainingYouTube = await StudentVault.open(join(dir, "youtube"), key);
  try { expect(await remainingYouTube.snapshot()).toMatchObject({ connections: [], grants: [], generations: {} }); } finally { await remainingYouTube.close(); }
});
it("the owner CLI requires explicit confirmation, honors the live lock and emits only counts", async () => {
  const { dir, key, vault } = await fixture(), command = fileURLToPath(new URL("../src/student/purge-subject.ts", import.meta.url));
  const options = { env: { ...process.env, META_BROKER_STATE_DIR: dir, META_BROKER_VAULT_KEY: key.toString("base64") }, timeout: 5000 };
  const run = promisify(execFile);
  await expect(run(process.execPath, ["--import", "tsx", command, "--subject", "student-a"], options)).rejects.toMatchObject({ code: 1, stderr: '{"error":"purge_confirmation_required"}\n' });
  await expect(run(process.execPath, ["--import", "tsx", command, "--subject", "student-a", "--confirm-purge"], options)).rejects.toMatchObject({ code: 1, stderr: '{"error":"writer_locked"}\n' });
  await vault.close(); const result = await run(process.execPath, ["--import", "tsx", command, "--subject", "student-a", "--confirm-purge"], options);
  expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout)).toEqual({ connections: 1, grants: 1, events: 1, states: 1, generations: 1 }); expect(result.stdout).not.toMatch(/student-a|private|token|label/);
});
