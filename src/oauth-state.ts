import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type OAuthAuthMode = "instagram" | "facebook";

export interface OAuthStateBinding {
  accountBinding: string;
  authMode: OAuthAuthMode;
  redirectUri: string;
  expectedAccountId?: string;
}

export interface OAuthStateRecord extends OAuthStateBinding {
  issuedAt: number;
  expiresAt: number;
}

export interface OAuthStateStoreOptions {
  directory: string;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Durable nonce store. Raw state is returned once and is never written to disk. */
export class OAuthStateStore {
  private readonly directory: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: OAuthStateStoreOptions) {
    this.directory = options.directory;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > DEFAULT_TTL_MS) {
      throw new Error("OAuth state TTL must be between 1 ms and 10 minutes.");
    }
  }

  async issue(binding: OAuthStateBinding): Promise<string> {
    validateBinding(binding);
    const state = randomBytes(32).toString("base64url");
    const hash = hashState(state);
    const issuedAt = this.now();
    const record: OAuthStateRecord = { ...binding, issuedAt, expiresAt: issuedAt + this.ttlMs };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await writeFile(this.pendingPath(hash), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    return state;
  }

  /** Context mismatch, expiry, malformed input, and replay all return undefined. */
  async consume(state: string, expected: OAuthStateBinding): Promise<OAuthStateRecord | undefined> {
    if (!isState(state)) return undefined;
    validateBinding(expected);
    const hash = hashState(state);
    const pending = this.pendingPath(hash);
    let record: OAuthStateRecord;
    try {
      record = JSON.parse(await readFile(pending, "utf8")) as OAuthStateRecord;
    } catch {
      return undefined;
    }
    if (!isRecord(record) || record.expiresAt <= this.now() || !sameBinding(record, expected)) {
      if (isRecord(record) && record.expiresAt <= this.now()) await rm(pending, { force: true });
      return undefined;
    }
    try {
      // rename atomically claims the pending nonce; only one concurrent caller can win.
      await rename(pending, join(this.directory, `${hash}.consumed`));
      return record;
    } catch {
      return undefined;
    }
  }

  private pendingPath(hash: string): string {
    return join(this.directory, `${hash}.pending`);
  }
}

export function createOAuthStateStore(options: OAuthStateStoreOptions): OAuthStateStore {
  return new OAuthStateStore(options);
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function isState(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validateBinding(binding: OAuthStateBinding): void {
  if (!binding.accountBinding || !binding.redirectUri || !["instagram", "facebook"].includes(binding.authMode)) {
    throw new Error("OAuth state binding is incomplete.");
  }
  const redirect = new URL(binding.redirectUri);
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(redirect.hostname))) {
    throw new Error("OAuth redirect URI must use HTTPS or loopback HTTP.");
  }
}

function sameBinding(record: OAuthStateRecord, expected: OAuthStateBinding): boolean {
  return equal(record.accountBinding, expected.accountBinding)
    && equal(record.authMode, expected.authMode)
    && equal(record.redirectUri, expected.redirectUri)
    && equal(record.expectedAccountId ?? "", expected.expectedAccountId ?? "");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is OAuthStateRecord {
  return typeof value === "object" && value !== null
    && "issuedAt" in value && typeof value.issuedAt === "number"
    && "expiresAt" in value && typeof value.expiresAt === "number"
    && "accountBinding" in value && typeof value.accountBinding === "string"
    && "redirectUri" in value && typeof value.redirectUri === "string"
    && "authMode" in value && (value.authMode === "facebook" || value.authMode === "instagram");
}
