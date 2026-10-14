import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrivateFile } from "../src/private-fs.js";
import { loadStoredToken, saveStoredToken, withTokenStoreLock } from "../src/token-store.js";

describe("token store", () => {
  it("stores tokens outside source files and returns metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meta-token-store-"));
    const path = join(dir, "nested", "token.json");

    await saveStoredToken(path, {
      accessToken: "secret-token",
      tokenType: "bearer",
      userId: "ig-user",
      permissions: ["instagram_business_basic"],
      expiresAt: "2026-07-22T00:39:04.000Z",
    });

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("secret-token");

    await expect(assertPrivateFile(path)).resolves.toBeUndefined();
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);

    const loaded = await loadStoredToken(path);
    expect(loaded?.userId).toBe("ig-user");
    expect(loaded?.accessToken).toBe("secret-token");
  });

  it("keeps same-app account tokens isolated by separate config roots", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "meta-token-first-install-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "meta-token-second-install-"));
    const firstPath = join(firstRoot, "token.json");
    const secondPath = join(secondRoot, "token.json");

    await saveStoredToken(firstPath, { accessToken: "first-private-token", authMode: "instagram", userId: "ig-account-1" });
    await saveStoredToken(secondPath, { accessToken: "second-private-token", authMode: "instagram", userId: "ig-account-2" });

    await expect(loadStoredToken(firstPath)).resolves.toMatchObject({ accessToken: "first-private-token", userId: "ig-account-1" });
    await expect(loadStoredToken(secondPath)).resolves.toMatchObject({ accessToken: "second-private-token", userId: "ig-account-2" });
  });

  it("rejects a concurrent writer and removes only the lock it owns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meta-token-lock-"));
    const path = join(dir, "token.json");
    const lockPath = `${path}.write-lock`;
    let markEntered!: () => void;
    let releaseWork!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseWork = resolve; });
    const first = withTokenStoreLock(path, async (store) => {
      markEntered();
      await gate;
      await store.save({ accessToken: "first-token", userId: "first-account" });
    });
    try {
      await entered;
      await expect(withTokenStoreLock(path, async () => undefined)).rejects.toThrow("TOKEN_STORE_BUSY");
      await rm(lockPath);
      await writeFile(lockPath, "another-owner\n", { mode: 0o600 });
      releaseWork();
      await first;
      await expect(readFile(lockPath, "utf8")).resolves.toBe("another-owner\n");
      await expect(withTokenStoreLock(path, async () => undefined)).rejects.toThrow("TOKEN_STORE_BUSY");
    } finally {
      releaseWork();
      await first.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
