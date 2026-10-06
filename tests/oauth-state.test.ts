import { link, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertPrivateFile } from "../src/private-fs.js";
import { OAuthStateStore } from "../src/oauth-state.js";

describe("OAuthStateStore", () => {
  it("issues a random one-time state bound to its OAuth context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-oauth-state-"));
    const store = new OAuthStateStore({ directory, now: () => 1_000 });
    const binding = { accountBinding: "owner-1", authMode: "instagram" as const, redirectUri: "https://mcp.example/oauth/callback" };

    const first = await store.issue(binding);
    const second = await store.issue(binding);

    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(files.every((name) => /^[a-f0-9]{64}\.pending$/.test(name))).toBe(true);
    await expect(assertPrivateFile(join(directory, files[0]!))).resolves.toBeUndefined();
    if (process.platform !== "win32") expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    await expect(store.consume(first, binding)).resolves.toMatchObject({ ...binding, issuedAt: 1_000 });
    await expect(store.consume(first, binding)).resolves.toBeUndefined();
  });

  it("rejects a context mismatch without consuming the state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-oauth-state-"));
    const store = new OAuthStateStore({ directory, now: () => 1_000 });
    const binding = { accountBinding: "owner-1", authMode: "facebook" as const, redirectUri: "https://mcp.example/callback" };
    const state = await store.issue(binding);

    await expect(store.consume(state, { ...binding, accountBinding: "other-owner" })).resolves.toBeUndefined();
    await expect(store.consume(state, { ...binding, authMode: "instagram" })).resolves.toBeUndefined();
    await expect(store.consume(state, { ...binding, redirectUri: "https://evil.example/callback" })).resolves.toBeUndefined();
    await expect(store.consume(state, binding)).resolves.toMatchObject(binding);
  });

  it("rejects expired state", async () => {
    let now = 1_000;
    const directory = await mkdtemp(join(tmpdir(), "instagram-oauth-state-"));
    const store = new OAuthStateStore({ directory, now: () => now, ttlMs: 600_000 });
    const binding = { accountBinding: "owner-1", authMode: "instagram" as const, redirectUri: "https://mcp.example/callback" };
    const state = await store.issue(binding);
    now += 600_001;

    await expect(store.consume(state, binding)).resolves.toBeUndefined();
  });

  it("allows only one concurrent consume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-oauth-state-"));
    const store = new OAuthStateStore({ directory, now: () => 1_000 });
    const secondStore = new OAuthStateStore({ directory, now: () => 1_000 });
    const binding = { accountBinding: "owner-1", authMode: "instagram" as const, redirectUri: "https://mcp.example/callback" };
    const state = await store.issue(binding);

    const results = await Promise.all([store.consume(state, binding), secondStore.consume(state, binding)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("fails closed when a previous consumer created the claim but crashed before cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-oauth-state-"));
    const store = new OAuthStateStore({ directory, now: () => 1_000 });
    const binding = { accountBinding: "owner-1", authMode: "facebook" as const, redirectUri: "https://mcp.example/callback" };
    const state = await store.issue(binding);
    const hash = createHash("sha256").update(state, "utf8").digest("hex");
    const pending = join(directory, `${hash}.pending`);
    const consumed = join(directory, `${hash}.consumed`);

    // Simulate interruption after the exclusive claim link was created.
    await link(pending, consumed);

    await expect(store.consume(state, binding)).resolves.toBeUndefined();
    expect(await readdir(directory)).toEqual([`${hash}.consumed`, `${hash}.pending`]);
  });
});
