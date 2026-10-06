#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeManifest, getRegistrationPaths, HOST_NAME, registerNativeHost } from "./register-native-host.mjs";

const fixture = await mkdtemp(join(tmpdir(), "instagram native host registration "));
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const secretCanary = "fixture-private-bridge-token-never-copy";

try {
  const home = join(fixture, "user home with spaces");
  const installRoot = join(home, "application folder with spaces");
  const configFile = join(home, "private config", "browser bridge.json");
  const paths = getRegistrationPaths({ platform: "linux", home, installRoot, configFile, nodePath: process.execPath, extensionId });
  await mkdir(join(installRoot, "dist", "companion"), { recursive: true });
  await mkdir(join(home, "private config"), { recursive: true });
  await writeFile(paths.hostScript, "// fixture host\n");
  await writeFile(configFile, JSON.stringify({ bearerToken: secretCanary }));
  await chmod(configFile, 0o600);
  const dry = await registerNativeHost({ platform: "linux", home, installRoot, configFile, extensionId, nodePath: process.execPath, dryRun: true });
  assert.equal(dry.manifest.name, HOST_NAME);
  assert.deepEqual(dry.manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(dry.manifest.type, "stdio");
  assert.equal(dry.plan.manifestPath.includes(" "), true);
  assert.equal(dry.plan.hostPath.includes(" "), true);
  if (process.platform !== "win32") {
    const cliOutput = execFileSync(process.execPath, [fileURLToPath(new URL("./register-native-host.mjs", import.meta.url)),
      "--dry-run", "--platform", "linux", "--install-root", installRoot, "--config-file", configFile, "--extension-id", extensionId],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(cliOutput.split(/\r?\n/).filter(Boolean).length, 1, "helper stdout should be one machine-readable status line");
    assert.match(cliOutput, /^DRY_RUN \{/);
    assert.equal(cliOutput.includes(secretCanary), false);
  }

  await registerNativeHost({ platform: "linux", home, installRoot, configFile, extensionId, nodePath: process.execPath });
  const manifestText = await readFile(paths.manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(manifestText.includes(secretCanary), false);
  const launcherText = await readFile(paths.hostPath, "utf8");
  assert.match(launcherText, /INSTAGRAM_MCP_BRIDGE_CONFIG=/);
  assert.match(launcherText, /dist\/companion\/browser-native-host\.js/);
  assert.equal(launcherText.includes(secretCanary), false);
  if (process.platform !== "win32") {
    assert.equal((await (await import("node:fs/promises")).stat(paths.hostPath)).mode & 0o777, 0o700);
    assert.equal((await (await import("node:fs/promises")).stat(paths.manifestPath)).mode & 0o777, 0o600);
  }

  await registerNativeHost({ platform: "linux", home, installRoot, configFile, extensionId, nodePath: process.execPath });
  assert.equal((await readdir(join(home, "private config", "native-host"))).some((name) => name.includes(".backup.")), true);
  const conflictRoot = join(fixture, "conflict home");
  const conflictPaths = getRegistrationPaths({ platform: "linux", home: conflictRoot, installRoot, configFile, nodePath: process.execPath, extensionId });
  const priorLauncher = await readFile(conflictPaths.hostPath, "utf8");
  await mkdir(join(installRoot, "dist", "companion"), { recursive: true });
  await mkdir(join(conflictRoot, ".config", "google-chrome", "NativeMessagingHosts"), { recursive: true });
  await writeFile(conflictPaths.manifestPath, "{\"name\":\"another-owner\"}\n");
  await assert.rejects(registerNativeHost({ platform: "linux", home: conflictRoot, installRoot, configFile, extensionId, nodePath: process.execPath }),
    /EXISTING_REGISTRATION_CONFLICT/);
  assert.equal(await readFile(conflictPaths.hostPath, "utf8"), priorLauncher, "a foreign manifest conflict must leave the existing launcher untouched");
  assert.equal(await readFile(conflictPaths.manifestPath, "utf8"), "{\"name\":\"another-owner\"}\n");

  if (process.platform !== "win32") {
    const symlinkHome = join(fixture, "symlink home");
    const symlinkPaths = getRegistrationPaths({ platform: "linux", home: symlinkHome, installRoot, configFile, nodePath: process.execPath, extensionId });
    await mkdir(join(symlinkHome, ".config", "google-chrome", "NativeMessagingHosts"), { recursive: true });
    await symlink(conflictPaths.manifestPath, symlinkPaths.manifestPath);
    await assert.rejects(registerNativeHost({ platform: "linux", home: symlinkHome, installRoot, configFile, extensionId, nodePath: process.execPath }),
      /EXISTING_REGISTRATION_CONFLICT/);
    assert.equal(await readFile(conflictPaths.manifestPath, "utf8"), "{\"name\":\"another-owner\"}\n", "a manifest symlink must not mutate its target");
  }

  const windowsHome = join(fixture, "windows home");
  const windowsRoot = join(windowsHome, "app with spaces");
  const windowsPaths = getRegistrationPaths({ platform: "windows", home: windowsHome, installRoot: windowsRoot, extensionId });
  await mkdir(join(windowsRoot, "tools", "native-host"), { recursive: true });
  await writeFile(windowsPaths.hostPath, "fixture self-contained launcher");
  const registry = new Map();
  const registryAdapter = {
    async ensureOwnedOrEmpty(key, manifestPath) {
      const current = registry.get(key);
      if (current && current.toLowerCase() !== manifestPath.toLowerCase()) throw new Error("EXISTING_REGISTRY_CONFLICT");
    },
    async setDefault(key, manifestPath) { registry.set(key, manifestPath); }
  };
  const windows = await registerNativeHost({ platform: "windows", home: windowsHome, installRoot: windowsRoot, extensionId,
    pathsOverride: windowsPaths, registryAdapter });
  assert.equal(windows.plan.registryKey, `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
  assert.equal(registry.get(windowsPaths.registryKey), windowsPaths.manifestPath);
  assert.equal(JSON.parse(await readFile(windowsPaths.manifestPath, "utf8")).path, windowsPaths.hostPath);

  const foreignRegistry = new Map([[windowsPaths.registryKey, join(fixture, "foreign manifest.json")]]);
  const foreignAdapter = { ...registryAdapter, async ensureOwnedOrEmpty(key, manifestPath) {
    if (foreignRegistry.get(key)?.toLowerCase() !== manifestPath.toLowerCase()) throw new Error("EXISTING_REGISTRY_CONFLICT");
  } };
  await assert.rejects(registerNativeHost({ platform: "windows", home: windowsHome, installRoot: windowsRoot, extensionId,
    pathsOverride: windowsPaths, registryAdapter: foreignAdapter }), /EXISTING_REGISTRY_CONFLICT/);

  assert.throws(() => buildNativeManifest({ platform: "linux", extensionId: "bad", hostPath: "/tmp/host" }), /INVALID_EXTENSION_ID/);
  process.stdout.write("native registration fixtures: PASS (exact origin, spaced paths, private files, owned update backup, conflict/symlink refusal, Windows HKCU plan, secret exclusion)\n");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
