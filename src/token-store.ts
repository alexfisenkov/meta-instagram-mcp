import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { assertPrivateFile, ensurePrivateDirectory, ensurePrivateFile } from "./private-fs.js";

/** Поля, которые пишем мы сами. Именно их принимает saveStoredToken. */
export interface StoredTokenFields {
  accessToken?: string;
  tokenType?: string;
  authMode?: "facebook" | "instagram";
  expiresAt?: string;
  userId?: string;
  username?: string;
  pageId?: string;
  permissions?: string[];
}

/**
 * Что читаем с диска: известные поля плюс всё, что в файл положила прошлая
 * версия. Индексная сигнатура нужна только на чтение — на запись она заставляла
 * бы каждый вызов приводить тип (OAuthToken под неё не подходит).
 */
export interface StoredInstagramToken extends StoredTokenFields {
  [key: string]: unknown;
}

export interface TokenStoreTransaction {
  load(): Promise<StoredInstagramToken | undefined>;
  save(token: StoredTokenFields): Promise<void>;
}

export async function loadStoredToken(path: string): Promise<StoredInstagramToken | undefined> {
  try {
    await assertPrivateFile(path);
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as StoredInstagramToken;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveStoredToken(path: string, token: StoredTokenFields): Promise<void> {
  await withTokenStoreLock(path, (store) => store.save(token));
}

/** Serialize token-store transactions across local MCP processes. A stale lock fails closed. */
export async function withTokenStoreLock<T>(path: string, operation: (store: TokenStoreTransaction) => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(dirname(path));
  const lockPath = `${path}.write-lock`;
  const lockId = `${randomUUID()}\n`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(lockId, "utf8");
    await lock.sync();
    await ensurePrivateFile(lockPath);
  } catch (error) {
    if (lock) {
      await lock.close().catch(() => undefined);
      await removeOwnedLock(lockPath, lockId);
    }
    if (isNodeError(error) && error.code === "EEXIST") throw new Error("TOKEN_STORE_BUSY");
    throw error;
  }
  try {
    return await operation({
      load: () => loadStoredToken(path),
      save: (token) => writeStoredToken(path, token),
    });
  } finally {
    await lock.close().catch(() => undefined);
    await removeOwnedLock(lockPath, lockId);
  }
}

export function sameStoredTokenSnapshot(left: StoredInstagramToken | undefined, right: StoredInstagramToken | undefined): boolean {
  if (!left || !right) return left === right;
  const a = createHash("sha256").update(stableJson(left)).digest();
  const b = createHash("sha256").update(stableJson(right)).digest();
  return timingSafeEqual(a, b);
}

async function writeStoredToken(path: string, token: StoredTokenFields): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  const handle = await open(tmpPath, "wx", 0o600);
  try {
    await ensurePrivateFile(tmpPath);
    await handle.writeFile(`${JSON.stringify(token, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  } finally { await handle.close().catch(() => undefined); }
  await rename(tmpPath, path);
  await ensurePrivateFile(path);
}

async function removeOwnedLock(path: string, lockId: string): Promise<void> {
  try {
    if (await readFile(path, "utf8") === lockId) await rm(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
