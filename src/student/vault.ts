import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensurePrivateDirectory, assertPrivateFile } from "../private-fs.js";
import { BrokerError, type Credential, type Database, type Sealed, type Subject } from "./types.js";

interface Binding extends Subject { id: string; provider: string }
function aad(binding: Binding): Buffer { return Buffer.from(JSON.stringify(["meta-student-grant-v1", binding.tenantId, binding.sub, binding.id, binding.provider])); }
function encrypt(key: Buffer, associated: Buffer, value: unknown): Sealed {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
function decrypt(key: Buffer, associated: Buffer, sealed: Sealed): unknown {
  try {
    const iv = Buffer.from(sealed.iv, "base64"), tag = Buffer.from(sealed.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAAD(associated); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } catch { throw new BrokerError("vault_integrity_failed"); }
}
export function sealCredential(key: Buffer, binding: Binding, value: Credential): Sealed { return encrypt(key, aad(binding), value); }
export function openCredential(key: Buffer, binding: Binding, sealed: Sealed): Credential { return decrypt(key, aad(binding), sealed) as Credential; }
const vaultAAD = Buffer.from("meta-student-vault-v1");
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** One process owns this directory for its entire lifecycle. No stale-lock stealing. */
export class StudentVault {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private commitUncertain = false;
  private hash: string | undefined;
  private data: Database = { version: 1, revision: 0, grants: [], connections: [], states: [], events: [], generations: {} };
  private constructor(private readonly directory: string, private readonly key: Buffer) {}
  static async open(directory: string, key: Buffer): Promise<StudentVault> {
    if (key.length !== 32) throw new BrokerError("invalid_vault_key");
    const path = resolve(directory); await ensurePrivateDirectory(path);
    try { await mkdir(join(path, ".writer-lock"), { mode: 0o700 }); } catch { throw new BrokerError("writer_locked"); }
    const store = new StudentVault(path, Buffer.from(key));
    try {
      const raw = await store.disk();
      if (raw !== undefined) {
        store.hash = digest(raw);
        const parsed = decrypt(store.key, vaultAAD, JSON.parse(raw)) as Database;
        if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || ![parsed.grants, parsed.connections, parsed.states, parsed.events].every(Array.isArray)) throw new BrokerError("vault_integrity_failed");
        store.data = parsed;
      }
      return store;
    } catch (error) { await rmdir(join(path, ".writer-lock")); throw error; }
  }
  credential(grant: Binding & { credential: Sealed }): Credential { return openCredential(this.key, grant, grant.credential); }
  seal(binding: Binding, credential: Credential): Sealed { return sealCredential(this.key, binding, credential); }
  async snapshot(): Promise<Database> { await this.tail; if (this.closed) throw new BrokerError("vault_closed"); if (this.commitUncertain) throw new BrokerError("vault_commit_uncertain"); return structuredClone(this.data); }
  /** allowUncertain is reserved for access-reducing revocation/deletion, never grants or reads. */
  transaction<T>(change: (data: Database) => T | Promise<T>, options: { allowUncertain?: boolean } = {}): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.closed) throw new BrokerError("vault_closed");
      if (this.commitUncertain && !options.allowUncertain) throw new BrokerError("vault_commit_uncertain");
      const raw = await this.disk();
      if ((raw === undefined ? undefined : digest(raw)) !== this.hash) throw new BrokerError("vault_changed");
      const next = structuredClone(this.data); const value = await change(next); next.revision += 1;
      const encoded = JSON.stringify(encrypt(this.key, vaultAAD, next));
      if (Buffer.byteLength(encoded) > 20_000_000) throw new BrokerError("vault_capacity_exceeded");
      const tmp = join(this.directory, `.vault-${randomUUID()}.tmp`);
      let renamed = false;
      try {
        const file = await open(tmp, "wx", 0o600);
        try { await file.writeFile(encoded, "utf8"); await file.sync(); } finally { await file.close(); }
        await rename(tmp, join(this.directory, "vault.json"));
        renamed = true;
        if (process.platform !== "win32") { const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
      } catch (error) {
        if (renamed) {
          // Rename already changed the visible file. Retain that exact candidate for the next CAS,
          // but disclose no state and admit no new grants until a revocation commits durably.
          this.data = next; this.hash = digest(encoded); this.commitUncertain = true;
          throw new BrokerError("vault_commit_uncertain");
        }
        throw error;
      } finally { await unlink(tmp).catch(() => undefined); }
      this.data = next; this.hash = digest(encoded); this.commitUncertain = false; return value;
    });
    this.tail = result.catch(() => undefined); return result;
  }
  async close(): Promise<void> { await this.tail; if (this.closed) return; this.closed = true; this.key.fill(0); await rmdir(join(this.directory, ".writer-lock")); }
  private async disk(): Promise<string | undefined> {
    const path = join(this.directory, "vault.json");
    try { const info = await lstat(path); if (info.size > 20_000_000) throw new BrokerError("vault_too_large"); await assertPrivateFile(path); return await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}
