import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrivateFile } from "../src/private-fs.js";
import { loadStoredToken, saveStoredToken } from "../src/token-store.js";

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
});
