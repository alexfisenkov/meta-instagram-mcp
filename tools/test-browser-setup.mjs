#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ensurePrivateDirectory, ensurePrivateFile } from "../dist/private-fs.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupBrowser } from "./browser-setup.mjs";
import { getRegistrationPaths } from "./register-native-host.mjs";

const root = await mkdtemp(join(tmpdir(), "instagram browser setup "));
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const originalEnv = "# private unrelated configuration\nMETA_INSTAGRAM_APP_ID=fixture-app\n";
async function fixture(name, extra = {}) {
  const home = join(root, name); const installRoot = join(home, "app with spaces"); const configDirectory = join(home, "private config");
  await mkdir(join(installRoot, "dist", "companion"), { recursive: true });
  await ensurePrivateDirectory(configDirectory);
  await writeFile(join(installRoot, "dist", "companion", "browser-native-host.js"), "// synthetic host\n");
  await writeFile(join(installRoot, "dist", "server.js"), "// synthetic runtime\n");
  const envPath = join(configDirectory, ".env"); await writeFile(envPath, originalEnv, { mode: 0o600 });
  await ensurePrivateFile(envPath);
  await writeFile(join(configDirectory, "token.json"), "fixture-token-unchanged", { mode: 0o600 });
  await ensurePrivateFile(join(configDirectory, "token.json"));
  return { platform: "linux", home, localAppData: join(home, "local app data"), installRoot, configDirectory, extensionId, accountHandle: "fixture_owner", ...extra };
}
try {
  const options = await fixture("dry-run");
  const result = await setupBrowser(options);
  assert.equal(result.status, "DRY_RUN");
  assert.equal(await readFile(join(options.configDirectory, ".env"), "utf8"), originalEnv);
  await assert.rejects(access(join(options.configDirectory, "browser-bridge.json")), { code: "ENOENT" });
  const paths = getRegistrationPaths({ ...options, configFile: join(options.configDirectory, "browser-bridge.json"), nodePath: process.execPath });
  await assert.rejects(access(paths.manifestPath), { code: "ENOENT" });

  const applied = await setupBrowser({ ...options, apply: true });
  assert.equal(applied.status, "APPLIED");
  const env = await readFile(join(options.configDirectory, ".env"), "utf8");
  assert.ok(env.startsWith(originalEnv));
  assert.match(env, /INSTAGRAM_MCP_BROWSER_BRIDGE="true"/);
  const bridge = JSON.parse(await readFile(join(options.configDirectory, "browser-bridge.json"), "utf8"));
  assert.equal(bridge.baseUrl, "http://127.0.0.1:8788");
  assert.equal(bridge.allowLoopbackHttp, true);
  assert.equal(bridge.allowBrowserWrites, false);
  assert.equal(bridge.expectedAccountHandle, "fixture_owner");
  assert.ok(Buffer.byteLength(bridge.bearerToken) >= 32);
  assert.ok(!JSON.stringify(applied).includes(bridge.bearerToken));
  assert.equal(await readFile(join(options.configDirectory, "token.json"), "utf8"), "fixture-token-unchanged");
  if (process.platform !== "win32") assert.equal((await stat(join(options.configDirectory, "browser-bridge.json"))).mode & 0o777, 0o600);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.ok(!JSON.stringify(manifest).includes(bridge.bearerToken));
  bridge.bridgeId = "fixture-registered-bridge"; bridge.bridgeToken = "sample-bridge-credential";
  await writeFile(join(options.configDirectory, "browser-bridge.json"), JSON.stringify(bridge), { mode: 0o600 });
  await setupBrowser({ ...options, apply: true });
  assert.equal(await readFile(join(options.configDirectory, ".env"), "utf8"), env, "reapplying must not append duplicate config");
  assert.equal(JSON.parse(await readFile(join(options.configDirectory, "browser-bridge.json"), "utf8")).bridgeId, "fixture-registered-bridge");

  const conflict = await fixture("foreign manifest");
  const conflictPaths = getRegistrationPaths({ ...conflict, configFile: join(conflict.configDirectory, "browser-bridge.json"), nodePath: process.execPath });
  await mkdir(join(conflict.home, ".config", "google-chrome", "NativeMessagingHosts"), { recursive: true });
  await writeFile(conflictPaths.manifestPath, "foreign-manifest");
  await assert.rejects(setupBrowser({ ...conflict, apply: true }), /EXISTING_REGISTRATION_CONFLICT/);
  assert.equal(await readFile(join(conflict.configDirectory, ".env"), "utf8"), originalEnv);
  await assert.rejects(access(join(conflict.configDirectory, "browser-bridge.json")), { code: "ENOENT" });
  assert.equal(await readFile(conflictPaths.manifestPath, "utf8"), "foreign-manifest");

  for (const line of ["INSTAGRAM_MCP_HTTP_HOST=0.0.0.0", "INSTAGRAM_MCP_REMOTE_URL=https://example.invalid", "INSTAGRAM_MCP_TRANSPORT=http"]) {
    const conflicting = await fixture(`conflicting-${line.split("=")[0]}`);
    await writeFile(join(conflicting.configDirectory, ".env"), `${originalEnv}${line}\n`, { mode: 0o600 });
    await assert.rejects(setupBrowser({ ...conflicting, apply: true }), /BROWSER_SETUP_CONFIG_CONFLICT/);
    assert.equal(await readFile(join(conflicting.configDirectory, ".env"), "utf8"), `${originalEnv}${line}\n`);
  }
  const foreignBridge = await fixture("foreign bridge");
  await writeFile(join(foreignBridge.configDirectory, "browser-bridge.json"), "{}", { mode: 0o600 });
  await ensurePrivateFile(join(foreignBridge.configDirectory, "browser-bridge.json"));
  await assert.rejects(setupBrowser({ ...foreignBridge, apply: true }), /BROWSER_SETUP_BRIDGE_CONFLICT/);
  assert.equal(await readFile(join(foreignBridge.configDirectory, "browser-bridge.json"), "utf8"), "{}");

  if (process.platform !== "win32") {
    const linked = await fixture("linked-env"); const target = join(root, "untouched-env"); await writeFile(target, originalEnv, { mode: 0o600 });
    await rm(join(linked.configDirectory, ".env")); await symlink(target, join(linked.configDirectory, ".env"));
    await assert.rejects(setupBrowser({ ...linked, apply: true }), /BROWSER_SETUP_PATH_UNSAFE/);
    assert.equal(await readFile(target, "utf8"), originalEnv);
  }
  const windows = await fixture("windows missing exe", { platform: "windows" });
  await assert.rejects(setupBrowser(windows), /WINDOWS_HOST_MISSING/);
  assert.equal(await readFile(join(windows.configDirectory, ".env"), "utf8"), originalEnv);
  const windowsHost = join(windows.installRoot, "tools", "native-host", "InstagramNativeHost.exe");
  await mkdir(join(windows.installRoot, "tools", "native-host"), { recursive: true });
  await writeFile(windowsHost, "synthetic published executable bytes");
  const registry = new Map();
  const registryAdapter = {
    async ensureOwnedOrEmpty(key, manifestPath) { if (registry.has(key) && registry.get(key) !== manifestPath) throw new Error("EXISTING_REGISTRY_CONFLICT"); },
    async setDefault(key, manifestPath) { registry.set(key, manifestPath); }
  };
  await assert.rejects(setupBrowser({ ...windows, registryAdapter }), /WINDOWS_HOST_CHECKSUM_REQUIRED/);
  await assert.rejects(setupBrowser({ ...windows, registryAdapter, windowsExeSha256: "0".repeat(64), apply: true }), /WINDOWS_HOST_CHECKSUM_MISMATCH/);
  assert.equal(registry.size, 0);
  const windowsExeSha256 = createHash("sha256").update(await readFile(windowsHost)).digest("hex");
  await setupBrowser({ ...windows, registryAdapter, windowsExeSha256, apply: true });
  assert.equal(registry.size, 1);
  const windowsBridge = JSON.parse(await readFile(join(windows.localAppData, "MetaInstagramCompanion", "browser-bridge.json"), "utf8"));
  assert.equal(windowsBridge.expectedAccountHandle, "fixture_owner");
  assert.equal(windowsBridge.allowBrowserWrites, false);
  process.stdout.write("browser setup fixtures: PASS (dry-run, preserving apply, private files, owned registration, conflicts, idempotence, no credential output)\n");
} finally { await rm(root, { recursive: true, force: true }); }
