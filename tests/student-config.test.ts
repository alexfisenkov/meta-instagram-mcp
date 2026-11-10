import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadStudentConfig } from "../src/student/config.js";
import { StudentRegistry } from "../src/student/registry.js";
it("requires independent service/subject/vault credentials and never consumes legacy tokens", async () => {
  await expect(loadStudentConfig({ META_ACCESS_TOKEN: "owner-token" })).rejects.toThrow("missing_broker_config");
  const config = await loadStudentConfig({ META_BROKER_SERVICE_TOKEN: "s".repeat(40), META_BROKER_SUBJECT_KEY: randomBytes(32).toString("base64"), META_BROKER_VAULT_KEY: randomBytes(32).toString("base64"), META_BROKER_STATE_DIR: join(tmpdir(), "broker-state"), META_BROKER_CALLBACK_URL: "https://broker.example/meta/oauth/callback", META_BROKER_PLATFORM_ORIGIN: "https://platform.example" });
  expect(config.registry.status("instagram", { tenantId: "masterskaya", sub: "a" })).toBe("not_configured");
});
it("rejects encoded mailto header injection and accepts a longer independent subject key", async () => {
  const env = { META_BROKER_SERVICE_TOKEN: "s".repeat(40), META_BROKER_SUBJECT_KEY: randomBytes(64).toString("base64"), META_BROKER_VAULT_KEY: randomBytes(32).toString("base64"), META_BROKER_STATE_DIR: join(tmpdir(), "broker-state"), META_BROKER_CALLBACK_URL: "https://broker.example/meta/oauth/callback", META_BROKER_PLATFORM_ORIGIN: "https://platform.example", META_BROKER_OPERATOR_NAME: "Operator", META_BROKER_PRIVACY_CONTACT: "privacy%0d%0aBcc@example.com" };
  await expect(loadStudentConfig(env)).rejects.toThrow("invalid_legal_config");
  expect((await loadStudentConfig({ ...env, META_BROKER_PRIVACY_CONTACT: "privacy+requests@example.com" })).auth.subjectKey.length).toBe(64);
});
it("rejects unsupported registry fields and separates missing config from review admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "broker-config-"));
  const env = { META_BROKER_SERVICE_TOKEN: "s".repeat(40), META_BROKER_SUBJECT_KEY: randomBytes(32).toString("base64"), META_BROKER_VAULT_KEY: randomBytes(32).toString("base64"), META_BROKER_STATE_DIR: dir, META_BROKER_CALLBACK_URL: "https://broker.example/meta/oauth/callback", META_BROKER_PLATFORM_ORIGIN: "https://platform.example", META_BROKER_CONFIG_FILE: join(dir, "config.json"), TEST_APP_ID: "123", TEST_APP_SECRET: "secret" };
  const product = { product: "threads", key: "threads", provider: "threads", appIdEnv: "TEST_APP_ID", appSecretEnv: "TEST_APP_SECRET", apiVersion: "v1.0" };
  try {
    await writeFile(env.META_BROKER_CONFIG_FILE, JSON.stringify({ version: 1, products: [product] }));
    const config = await loadStudentConfig(env); expect(config.registry.status("threads", { tenantId: "masterskaya", sub: "a" })).toBe("review_required");
    await writeFile(env.META_BROKER_CONFIG_FILE, JSON.stringify({ version: 1, products: [{ ...product, token: "owner-token" }] }));
    await expect(loadStudentConfig(env)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("loads YouTube from dedicated Google credential refs and a provider-specific callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youtube-registry-"));
  const path = join(dir, "config.json");
  const product = { product: "youtube", key: "youtube", provider: "youtube", googleClientIdEnv: "YOUTUBE_OAUTH_CLIENT_ID", googleClientSecretEnv: "YOUTUBE_OAUTH_CLIENT_SECRET", callbackUrlEnv: "YOUTUBE_OAUTH_REDIRECT_URL", apiVersion: "v3", admission: "test", testSubjects: ["owner"] };
  const env = { YOUTUBE_OAUTH_CLIENT_ID: "google-client-id-fixture", YOUTUBE_OAUTH_CLIENT_SECRET: "google-client-secret-fixture", YOUTUBE_OAUTH_REDIRECT_URL: "https://broker.example/youtube/oauth/callback" };
  try {
    await writeFile(path, JSON.stringify({ version: 1, products: [product] }));
    const registry = await StudentRegistry.load(path, "https://broker.example/meta/oauth/callback", env);
    expect(registry.get("youtube")).toMatchObject({ provider: "youtube", callbackUrl: env.YOUTUBE_OAUTH_REDIRECT_URL, appId: env.YOUTUBE_OAUTH_CLIENT_ID, appSecret: env.YOUTUBE_OAUTH_CLIENT_SECRET });
    expect(registry.status("youtube", { tenantId: "masterskaya", sub: "owner" })).toBe("ready");
    expect(registry.status("youtube", { tenantId: "masterskaya", sub: "student" })).toBe("review_required");
    await expect(StudentRegistry.load(path, "https://broker.example/meta/oauth/callback", { ...env, YOUTUBE_OAUTH_CLIENT_SECRET: "" })).rejects.toThrow("invalid_provider_config");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
