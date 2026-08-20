import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as StoredInstagramToken;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveStoredToken(path: string, token: StoredTokenFields): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
