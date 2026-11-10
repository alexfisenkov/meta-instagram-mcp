import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StudentBroker } from "../src/student/broker.js";
import { MetaStudentProvider } from "../src/student/meta-provider.js";
import { StudentRegistry } from "../src/student/registry.js";
import { StudentVault } from "../src/student/vault.js";
import type { ProductConfig } from "../src/student/types.js";

it("persists two independent Instagram Login accounts, keeps credentials private and rejects state replay or another subject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "instagram-login-flow-")), key = randomBytes(32);
  let vault = await StudentVault.open(dir, key);
  const owner = { tenantId: "masterskaya", sub: "synthetic-owner" }, other = { ...owner, sub: "synthetic-other" };
  const config: ProductConfig = { product: "instagram", key: "instagram-login", provider: "instagram_login", appId: "123", appSecret: "synthetic-app-secret", apiVersion: "v27.0", callbackUrl: "https://broker.example/meta/oauth/callback", admission: "test", testSubjects: [owner.sub] };
  let providerCalls = 0, mismatchedProfile = false;
  const provider = new MetaStudentProvider(async (url, init) => {
    providerCalls++;
    if (url.hostname === "api.instagram.com") {
      const account = String((init!.body as FormData).get("code"));
      return { data: [{ access_token: `synthetic-short-${account}`, user_id: `app-${account}`, permissions: ["instagram_business_basic"] }] };
    }
    if (url.pathname === "/access_token") return { access_token: url.searchParams.get("access_token")!.replace("short", "long"), token_type: "bearer", expires_in: 5_184_000 };
    if (url.pathname === "/v27.0/me") {
      const account = String((init!.headers as Record<string, string>).Authorization).replace("Bearer synthetic-long-", "");
      return { data: [{ id: mismatchedProfile ? "wrong-app" : `app-${account}`, user_id: mismatchedProfile ? "wrong-resource" : account, username: `profile-${account}`, access_token: "synthetic-private-profile-token" }] };
    }
    throw new Error("unexpected synthetic provider request");
  });
  const makeBroker = () => new StudentBroker(vault, new StudentRegistry([config]), provider, "https://platform.example");
  try {
    let broker = makeBroker();
    expect(await broker.callback({ code: "one" })).toBe("https://platform.example/social?meta=error");
    expect(providerCalls).toBe(0);
    await expect(broker.begin(other, "instagram")).rejects.toThrow("review_required");
    for (const account of ["one", "two", "one"]) {
      const begin = await broker.begin(owner, "instagram"), auth = new URL(begin.authorizationUrl);
      expect(auth.origin + auth.pathname).toBe("https://www.instagram.com/oauth/authorize");
      expect(auth.searchParams.has("config_id")).toBe(false);
      const state = auth.searchParams.get("state")!;
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await broker.callback({ state, code: account })).toBe("https://platform.example/social?meta=connected");
      const beforeReplay = providerCalls;
      expect(await broker.callback({ state, code: account })).toBe("https://platform.example/social?meta=error");
      expect(providerCalls).toBe(beforeReplay);
    }
    expect((await broker.list(owner)).connections.map((c) => c.status)).toEqual(["connected", "connected"]);
    const preserved = await broker.list(owner), grantsBefore = (await vault.snapshot()).grants;
    const retry = await broker.begin(owner, "instagram"); mismatchedProfile = true;
    expect(await broker.callback({ state: new URL(retry.authorizationUrl).searchParams.get("state")!, code: "one" })).toBe("https://platform.example/social?meta=error");
    expect(await broker.list(owner)).toEqual(preserved);
    expect((await vault.snapshot()).grants).toEqual(grantsBefore);
    mismatchedProfile = false;
    await vault.close();
    vault = await StudentVault.open(dir, key); broker = makeBroker();
    const connections = (await broker.list(owner)).connections;
    expect(connections.map((c) => c.account.id)).toEqual(["one", "two"]);
    for (const connection of connections) {
      expect((await broker.read(owner, { connectionId: connection.id, operation: "account" })).data).toEqual({ user_id: connection.account.id, username: `profile-${connection.account.id}` });
      await expect(broker.read(owner, { connectionId: connection.id, operation: "inbox" })).rejects.toThrow("operation_unavailable");
      await expect(broker.read(other, { connectionId: connection.id, operation: "account" })).rejects.toThrow("connection_not_found");
    }
    expect((await broker.list(other)).connections).toEqual([]);
    expect(JSON.stringify(await broker.list(owner))).not.toMatch(/synthetic-(?:short|long|private)|synthetic-app-secret|credential|app-one|app-two/);
    expect(await readFile(join(dir, "vault.json"), "utf8")).not.toMatch(/synthetic-(?:short|long)|profile-one|profile-two/);
  } finally { await vault.close(); key.fill(0); await rm(dir, { recursive: true, force: true }); }
});
