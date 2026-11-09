import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateSubject } from "../src/student/auth.js";
import { StudentVault, openCredential, sealCredential } from "../src/student/vault.js";
import { StudentBroker } from "../src/student/broker.js";
import { StudentRegistry } from "../src/student/registry.js";
import * as privateFs from "../src/private-fs.js";

const key = randomBytes(32);
const now = 1_800_000_000;
function jwt(overrides: Record<string, unknown> = {}, secret = key): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "masterskaya-platform", aud: "meta-student-broker", tenantId: "masterskaya", sub: "student-a", iat: now, exp: now + 60, ...overrides })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}
describe("student subject boundary", () => {
  it("accepts only the service credential and a signed bounded platform subject", () => {
    expect(authenticateSubject("Bearer " + "s".repeat(40), jwt(), { serviceToken: "s".repeat(40), subjectKey: key }, now)).toEqual({ tenantId: "masterskaya", sub: "student-a" });
  });
  it.each([{ iss: "attacker" }, { aud: "owner-mcp" }, { tenantId: "other" }, { sub: "" }, { iat: now + 1 }, { exp: now }, { exp: now + 61 }])("rejects claim mismatch %j", (claims) => {
    expect(() => authenticateSubject("Bearer " + "s".repeat(40), jwt(claims), { serviceToken: "s".repeat(40), subjectKey: key }, now)).toThrow("unauthorized");
  });
  it("rejects forged signature, missing subject and wrong service token", () => {
    for (const [bearer, token] of [["Bearer wrong", jwt()], ["Bearer " + "s".repeat(40), jwt({}, randomBytes(32))], ["Bearer " + "s".repeat(40), undefined]]) {
      expect(() => authenticateSubject(bearer, token, { serviceToken: "s".repeat(40), subjectKey: key }, now)).toThrow("unauthorized");
    }
  });
});
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function vault() { const dir = await mkdtemp(join(tmpdir(), "student-vault-")); dirs.push(dir); return { dir, store: await StudentVault.open(dir, key) }; }
describe("student encrypted single-writer vault", () => {
  it("AEAD binds credentials to tenant, subject, grant and provider", () => {
    const binding = { tenantId: "masterskaya", sub: "student-a", id: "grant-a", provider: "threads" };
    const sealed = sealCredential(key, binding, { accessToken: "secret-a", assetTokens: {} });
    expect(openCredential(key, binding, sealed).accessToken).toBe("secret-a");
    for (const changed of [{ sub: "student-b" }, { tenantId: "other" }, { id: "grant-b" }, { provider: "facebook_business" }]) {
      expect(() => openCredential(key, { ...binding, ...changed }, sealed)).toThrow();
    }
    expect(() => openCredential(key, binding, { ...sealed, tag: randomBytes(16).toString("base64") })).toThrow();
  });
  it("persists no plaintext state and rejects another process writer", async () => {
    const { dir, store } = await vault();
    await store.transaction((db) => { db.events.push({ connectionId: "secret-account", eventId: "event", receivedAt: "now", data: { text: "private-message" } }); });
    expect(await readFile(join(dir, "vault.json"), "utf8")).not.toContain("private-message");
    await expect(StudentVault.open(dir, key)).rejects.toThrow("writer_locked");
    await store.close();
    const reopened = await StudentVault.open(dir, key);
    expect((await reopened.snapshot()).events[0].data).toEqual({ text: "private-message" });
    await reopened.close();
  });
  it("refuses a vault commit when private file protection fails before any contents are written", async () => {
    const { dir, store } = await vault();
    const protection = vi.spyOn(privateFs, "ensurePrivateFile").mockImplementationOnce(async (path) => {
      expect(await readFile(path, "utf8")).toBe("");
      throw new Error("private_file_protection_refused");
    });
    try {
      await expect(store.transaction((db) => { db.events.push({ connectionId: "connection", eventId: "event", receivedAt: "now", data: { text: "private-message" } }); })).rejects.toThrow("private_file_protection_refused");
      expect((await store.snapshot()).revision).toBe(0);
      await expect(readFile(join(dir, "vault.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { protection.mockRestore(); await store.close(); }
  });
  it("serializes transactions and fails CAS after external ciphertext replacement", async () => {
    const { dir, store } = await vault();
    await Promise.all(Array.from({ length: 10 }, () => store.transaction((db) => { db.revision += 1; })));
    expect((await store.snapshot()).revision).toBe(20);
    await writeFile(join(dir, "vault.json"), "{}", { mode: 0o600 });
    await expect(store.transaction(() => undefined)).rejects.toThrow("vault_changed");
    await store.close();
  });
  it("enforces its writer lock in a second Node process", async () => {
    const { dir, store } = await vault();
    const script = `import { StudentVault } from './src/student/vault.ts'; try { const v=await StudentVault.open(process.argv[1],Buffer.from(process.argv[2],'base64')); await v.close(); process.exitCode=2; } catch(e) { if(e.message!=='writer_locked') process.exitCode=3; }`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir, key.toString("base64")], { cwd: process.cwd(), timeout: 5000 });
    expect(result.stdout).toBe(""); expect(result.stderr).toBe(""); await store.close();
  });
  it.skipIf(process.platform === "win32")("a post-rename directory fsync failure fails closed but a later durable disconnect can recover", async () => {
    const { dir, store } = await vault(); const subject = { tenantId: "masterskaya", sub: "student-a" };
    await store.transaction((db) => { db.connections.push({ ...subject, id: "connection", grantId: "grant", product: "instagram", providerId: "100", label: "own", capabilities: ["account"], status: "connected", updatedAt: "now" }); });
    const probe = await open(dir, "r"), prototype = Object.getPrototypeOf(probe); await probe.close(); const original = prototype.sync;
    let injected = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: { stat(): Promise<{ isDirectory(): boolean }> }) { if (!injected && (await this.stat()).isDirectory()) { injected = true; throw new Error("injected_directory_fsync_failure"); } return original.call(this); });
    try {
      await expect(store.transaction((db) => { db.events.push({ connectionId: "connection", eventId: "event", receivedAt: new Date().toISOString(), data: { text: "private" } }); })).rejects.toThrow("vault_commit_uncertain");
      await expect(store.snapshot()).rejects.toThrow("vault_commit_uncertain"); await expect(store.transaction(() => undefined)).rejects.toThrow("vault_commit_uncertain");
    } finally { spy.mockRestore(); }
    const broker = new StudentBroker(store, new StudentRegistry([]), { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); } }, "https://platform.example");
    expect((await broker.disconnect(subject, "connection")).connection.status).toBe("disconnected"); expect((await store.snapshot()).events).toEqual([]); await store.close();
    const reopened = await StudentVault.open(dir, key); expect((await reopened.snapshot()).connections[0].status).toBe("disconnected"); await reopened.close();
  });
});
