#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeManifest, getRegistrationPaths, HOST_NAME, registerNativeHost } from "./register-native-host.mjs";

const fixture = await mkdtemp(join(tmpdir(), "instagram native host registration "));
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const sampleKey = "fixture-private-bridge-token-never-copy";

try {
  const home = join(fixture, "user home with spaces");
  const installRoot = join(home, "application folder with spaces");
  const configFile = join(home, "private config", "browser bridge.json");
  const paths = getRegistrationPaths({ platform: "linux", home, installRoot, configFile, nodePath: process.execPath, extensionId });
  await mkdir(join(installRoot, "dist", "companion"), { recursive: true });
  await mkdir(join(home, "private config"), { recursive: true });
  await writeFile(paths.hostScript, "// fixture host\n");
  await writeFile(configFile, JSON.stringify({ bearerToken: sampleKey }));
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
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") } });
    assert.equal(cliOutput.split(/\r?\n/).filter(Boolean).length, 1, "helper stdout should be one machine-readable status line");
    assert.match(cliOutput, /^DRY_RUN \{/);
    assert.equal(cliOutput.includes(sampleKey), false);
  }

  await registerNativeHost({ platform: "linux", home, installRoot, configFile, extensionId, nodePath: process.execPath });
  const manifestText = await readFile(paths.manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(manifestText.includes(sampleKey), false);
  const launcherText = await readFile(paths.hostPath, "utf8");
  assert.match(launcherText, /INSTAGRAM_MCP_BRIDGE_CONFIG=/);
  assert.equal(paths.hostScript.endsWith(join("dist", "companion", "browser-native-host.js")), true);
  const registeredHostScript = join(await realpath(installRoot), "dist", "companion", "browser-native-host.js");
  assert.equal(launcherText.includes(registeredHostScript), true);
  assert.equal(launcherText.includes(sampleKey), false);
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
  await assert.rejects(registerNativeHost({ platform: "linux", home: conflictRoot, installRoot, configFile, extensionId, nodePath: process.execPath, dryRun: true }),
    /EXISTING_REGISTRATION_CONFLICT/, "dry-run must detect foreign manifests before setup writes config");
  const pendingHome = join(fixture, "pending home");
  const pendingConfig = join(pendingHome, "private", "bridge.json");
  await registerNativeHost({ platform: "linux", home: pendingHome, installRoot, configFile: pendingConfig, extensionId, nodePath: process.execPath, dryRun: true, pendingConfig: true });
  await assert.rejects(readFile(pendingConfig), { code: "ENOENT" }, "planning a pending config must not create it");
  await assert.rejects(registerNativeHost({ platform: "linux", home: pendingHome, installRoot, configFile: pendingConfig, extensionId, nodePath: process.execPath, pendingConfig: true }),
    /PENDING_CONFIG_REQUIRES_DRY_RUN/, "apply cannot bypass the existing private config guard");
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
  await mkdir(join(windowsHome, "AppData", "Local", "MetaInstagramCompanion"), { recursive: true });
  await writeFile(windowsPaths.configFile, JSON.stringify({ bearerToken: sampleKey }), { mode: 0o600 });
  if (process.platform === "win32") await (await import("../dist/private-fs.js")).ensurePrivateFile(windowsPaths.configFile);
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
  const { defaultRegistryAdapter } = await import("./register-native-host.mjs");
  assert.equal(typeof defaultRegistryAdapter, "function", "registry guard must have a separately testable executor boundary");
  const key = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\sample";
  const adds = [];
  const deniedExecutor = () => { throw new Error("sample access denied"); };
  await assert.rejects(defaultRegistryAdapter(deniedExecutor).ensureOwnedOrEmpty(key, "/sample/manifest.json"), /REGISTRY_READ_FAILED/);
  assert.equal(adds.length,0,"reader failure never allows replacement");
  const missingExecutor = (command,args) => {
    if (command === "reg.exe") { adds.push(args); return ""; }
    return JSON.stringify({state:"missing"});
  };
  await defaultRegistryAdapter(missingExecutor).setDefault(key,"/sample/manifest.json");
  assert.equal(adds.length,1); assert.equal(adds[0].includes("/f"),false,"a concurrent owner cannot be force-overwritten");
  const ownedPath = "/sample/русский путь/manifest.json";
  const ownedExecutor = (command) => {
    if(command === "reg.exe") throw new Error("owned value must not be rewritten");
    return JSON.stringify({state:"present",kind:"String",value:ownedPath});
  };
  await defaultRegistryAdapter(ownedExecutor).setDefault(key,ownedPath);
  await assert.rejects(defaultRegistryAdapter(()=>JSON.stringify({state:"present",kind:"DWord",value:1})).ensureOwnedOrEmpty(key,ownedPath),/REGISTRY_READ_FAILED/);
  await assert.rejects(defaultRegistryAdapter(()=>JSON.stringify({state:"present",kind:"String",value:"/sample/foreign.json"})).ensureOwnedOrEmpty(key,ownedPath),/EXISTING_REGISTRY_CONFLICT/);
  if (process.platform === "win32" && process.env.CI === "true") {
    // Only our unique disposable fixture key, never Chrome's registration key.
    const parentKey = `HKCU\\Software\\MetaInstagramMcpFixture-${randomUUID()}`;
    const disposableKey = `${parentKey}\\NativeMessagingHost`;
    const adapter = defaultRegistryAdapter();
    const unicodeManifest = join(fixture,"русский путь","manifest.json");
    await adapter.ensureOwnedOrEmpty(disposableKey, unicodeManifest);
    try {
      await adapter.setDefault(disposableKey, unicodeManifest);
      await adapter.ensureOwnedOrEmpty(disposableKey, unicodeManifest);
      await adapter.setDefault(disposableKey, unicodeManifest);
      execFileSync("reg.exe",["add",disposableKey,"/ve","/t","REG_SZ","/d",join(fixture,"sample foreign.json"),"/f"],{stdio:"ignore"});
      await assert.rejects(adapter.ensureOwnedOrEmpty(disposableKey,windowsPaths.manifestPath),/EXISTING_REGISTRY_CONFLICT/);
      await assert.rejects(adapter.setDefault(disposableKey,windowsPaths.manifestPath),/EXISTING_REGISTRY_CONFLICT/);
    } finally {
      execFileSync("reg.exe",["delete",parentKey,"/f"],{stdio:"ignore"});
    }
  }
  process.stdout.write("native registration fixtures: PASS (exact origin, spaced paths, private files, owned update backup, conflict/symlink refusal, Windows HKCU plan, secret exclusion)\n");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
