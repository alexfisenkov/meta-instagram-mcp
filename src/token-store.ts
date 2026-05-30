import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredToken {
  accessToken: string;
  tokenType: string;
  authMode?: "instagram" | "facebook";
  userId?: string;
  username?: string;
  pageId?: string;
  permissions?: string[];
  expiresAt?: string;
}

export async function loadStoredToken(path: string): Promise<StoredToken | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as StoredToken;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function saveStoredToken(path: string, token: StoredToken): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
