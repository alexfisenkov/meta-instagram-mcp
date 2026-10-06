import { randomUUID } from "node:crypto";
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
