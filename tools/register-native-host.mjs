#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.alexfisenkov.instagram_companion";
const HOST_EXE = "InstagramNativeHost.exe";
const markerName = ".instagram-native-host-registration.json";

function fail(code) { throw new Error(code); }
function shellQuote(value) { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!["--extension-id", "--install-root", "--config-file", "--platform", "--dry-run"].includes(key)) fail("INVALID_ARGUMENTS");
    if (key === "--dry-run") { args.dryRun = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) fail("INVALID_ARGUMENTS");
    args[key.slice(2).replaceAll("-", "")] = value;
  }
  if (!args.extensionid || !args.installroot) fail("INVALID_ARGUMENTS");
  return args;
}

function osPlatform(platform) {
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32" || platform === "windows") return "windows";
  fail("UNSUPPORTED_PLATFORM");
}

export function buildNativeManifest({ platform, extensionId, hostPath }) {
  const os = osPlatform(platform);
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) fail("INVALID_EXTENSION_ID");
  if (!isAbsolute(hostPath)) fail("HOST_PATH_MUST_BE_ABSOLUTE");
  return {
    name: HOST_NAME,
    description: "Instagram Companion Native Messaging host",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

export function getRegistrationPaths({ platform, home, localAppData, installRoot, configFile, nodePath, extensionId }) {
  const os = osPlatform(platform);
  const root = resolve(installRoot);
  if (os === "windows") {
    const hostPath = join(root, "tools", "native-host", HOST_EXE);
    return {
      platform: os,
      hostPath,
      manifestPath: join(localAppData ?? join(home, "AppData", "Local"), "MetaInstagramCompanion", "native-host.json"),
      registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      markerPath: join(localAppData ?? join(home, "AppData", "Local"), "MetaInstagramCompanion", markerName)
    };
  }
  if (!configFile || !isAbsolute(configFile)) fail("CONFIG_PATH_MUST_BE_ABSOLUTE");
  const base = os === "macos"
    ? join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : join(home, ".config", "google-chrome", "NativeMessagingHosts");
  return {
    platform: os,
    hostPath: join(dirname(configFile), "native-host", "instagram-browser-native-host"),
    manifestPath: join(base, `${HOST_NAME}.json`),
    markerPath: join(dirname(configFile), "native-host", markerName),
    hostScript: join(root, "dist", "companion", "browser-native-host.js"),
    configFile,
    nodePath
  };
}

async function assertRegularPrivateFile(path, code, { privateMode = true } = {}) {
  let info;
  try { info = await lstat(path); } catch { fail(code); }
  if (!info.isFile() || info.isSymbolicLink()) fail(code);
  if (privateMode && process.platform !== "win32" && (info.mode & 0o077) !== 0) fail("CONFIG_FILE_PERMISSIONS");
  return await realpath(path);
}

async function assertDirectoryNoSymlink(path) {
  let current = resolve(path);
  const missing = [];
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail("UNSAFE_REGISTRATION_DIRECTORY");
      const actual = await realpath(current);
      return resolve(actual, ...missing.reverse());
    } catch (error) {
      if (error instanceof Error && error.message === "UNSAFE_REGISTRATION_DIRECTORY") throw error;
      if (error?.code !== "ENOENT") fail("UNSAFE_REGISTRATION_DIRECTORY");
      const parent = dirname(current);
      if (parent === current) fail("UNSAFE_REGISTRATION_DIRECTORY");
      missing.push(current.slice(parent === sep ? parent.length : parent.length + 1));
      current = parent;
    }
  }
}

function launcherText({ nodePath, hostScript, configFile, extensionId }) {
  return [
    "#!/bin/sh",
    "set -eu",
    `export INSTAGRAM_MCP_BRIDGE_CONFIG=${shellQuote(configFile)}`,
    `export INSTAGRAM_MCP_EXTENSION_ID=${shellQuote(extensionId)}`,
    `exec ${shellQuote(nodePath)} ${shellQuote(hostScript)} \"$@\"`,
    ""
  ].join("\n");
}

async function writeOwnedFile(filePath, contents, mode, markerPath) {
  let existing;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) fail("EXISTING_REGISTRATION_CONFLICT");
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof Error && error.message === "EXISTING_REGISTRATION_CONFLICT") throw error;
      fail("REGISTRATION_READ_FAILED");
    }
  }
  const marker = await readMarker(markerPath);
  if (existing !== undefined && (!marker || marker.manifestPath !== filePath || marker.manifestSha256 !== await sha256(existing))) {
    fail("EXISTING_REGISTRATION_CONFLICT");
  }
  if (existing !== undefined) {
    const backup = `${filePath}.backup.${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    await copyFile(filePath, backup);
    if (process.platform !== "win32") await chmod(backup, 0o600);
  }
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, contents, { flag: "wx", mode });
  if (process.platform !== "win32") await chmod(temp, mode);
  await rename(temp, filePath);
}

async function sha256(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

/** Writes a per-user Chrome manifest/launcher. registryAdapter is used only by isolated Windows fixtures. */
export async function registerNativeHost({ platform, home, installRoot, configFile, extensionId, nodePath = process.execPath,
  localAppData = process.env.LOCALAPPDATA, registryAdapter = defaultRegistryAdapter(), dryRun = false, pathsOverride } = {}) {
  const os = osPlatform(platform ?? process.platform);
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) fail("INVALID_EXTENSION_ID");
  if (!isAbsolute(installRoot ?? "")) fail("INSTALL_ROOT_MUST_BE_ABSOLUTE");
  const resolvedHome = resolve(home ?? homedir());
  const paths = pathsOverride ?? getRegistrationPaths({ platform: os, home: resolvedHome, localAppData: localAppData ?? join(resolvedHome, "AppData", "Local"), installRoot,
    configFile, nodePath, extensionId });
  const root = await assertDirectoryNoSymlink(installRoot);
  let installEntry;
  try { installEntry = await lstat(installRoot); } catch { fail("INSTALL_ROOT_MISSING"); }
  if (installEntry.isSymbolicLink()) fail("INSTALL_ROOT_SYMLINK");
  if (!pathsOverride && os === "windows") paths.hostPath = join(root, "tools", "native-host", HOST_EXE);
  if (!pathsOverride && os !== "windows") paths.hostScript = join(root, "dist", "companion", "browser-native-host.js");
  if (os === "windows") {
    await assertRegularPrivateFile(paths.hostPath, "WINDOWS_HOST_MISSING", { privateMode: false });
    await registryAdapter.ensureOwnedOrEmpty(paths.registryKey, paths.manifestPath);
  } else {
    await assertRegularPrivateFile(paths.configFile, "BRIDGE_CONFIG_MISSING");
    await assertRegularPrivateFile(paths.hostScript, "HOST_SCRIPT_MISSING", { privateMode: false });
    if (!isAbsolute(paths.nodePath) || !isAbsolute(paths.hostScript)) fail("HOST_PATH_MUST_BE_ABSOLUTE");
  }
  const manifest = buildNativeManifest({ platform: os, extensionId, hostPath: paths.hostPath });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const plan = { hostName: HOST_NAME, manifestPath: paths.manifestPath, hostPath: paths.hostPath,
    allowedOrigin: manifest.allowed_origins[0], ...(os === "windows" ? { registryKey: paths.registryKey } : {}) };
  if (dryRun) return { plan, manifest };

  const manifestDir = await assertDirectoryNoSymlink(dirname(paths.manifestPath));
  const privateDir = await assertDirectoryNoSymlink(dirname(paths.markerPath));
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const manifestFile = join(manifestDir, paths.manifestPath.slice(dirname(paths.manifestPath).length + 1));
  const marker = JSON.stringify({ owner: "meta-instagram-mcp", manifestPath: manifestFile,
    manifestSha256: await sha256(manifestText), hostName: HOST_NAME }, null, 2) + "\n";
  const markerState = await readMarker(paths.markerPath);
  await assertOwnedOrAbsent(manifestFile, markerState);
  if (os !== "windows") {
    const launcher = launcherText({ nodePath: paths.nodePath, hostScript: paths.hostScript, configFile: paths.configFile, extensionId });
    let priorLauncher;
    try {
      const info = await lstat(paths.hostPath);
      if (!info.isFile() || info.isSymbolicLink()) fail("EXISTING_LAUNCHER_CONFLICT");
      priorLauncher = await readFile(paths.hostPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof Error && error.message === "EXISTING_LAUNCHER_CONFLICT") throw error;
        fail("REGISTRATION_READ_FAILED");
      }
    }
    if (priorLauncher !== undefined && (!markerState || markerState.manifestPath !== manifestFile)) fail("EXISTING_LAUNCHER_CONFLICT");
    if (priorLauncher !== undefined) {
      const backup = `${paths.hostPath}.backup.${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
      await copyFile(paths.hostPath, backup);
      await chmod(backup, 0o600);
    }
    const launcherTemp = `${paths.hostPath}.${process.pid}.tmp`;
    await writeFile(launcherTemp, launcher, { flag: "wx", mode: 0o700 });
    await chmod(launcherTemp, 0o700);
    await rename(launcherTemp, paths.hostPath);
  }
  await writeOwnedFile(manifestFile, manifestText, 0o600, paths.markerPath);
  const markerTemp = `${paths.markerPath}.${process.pid}.tmp`;
  await writeFile(markerTemp, marker, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(markerTemp, 0o600);
  await rename(markerTemp, paths.markerPath);
  if (os === "windows") {
    await registryAdapter.ensureOwnedOrEmpty(paths.registryKey, paths.manifestPath);
    await registryAdapter.setDefault(paths.registryKey, paths.manifestPath);
  }
  return { plan };
}

function defaultRegistryAdapter() {
  return {
    async ensureOwnedOrEmpty(key, manifestPath) {
      let value;
      try {
        const output = execFileSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        value = output.split(/\r?\n/).find((line) => /\s+REG_SZ\s+/.test(line))?.split(/\s+REG_SZ\s+/)[1]?.trim();
      } catch { return; }
      if (value && resolve(value).toLowerCase() !== resolve(manifestPath).toLowerCase()) fail("EXISTING_REGISTRY_CONFLICT");
    },
    async setDefault(key, manifestPath) {
      execFileSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: ["ignore", "ignore", "ignore"] });
    }
  };
}

async function readMarker(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail("REGISTRATION_MARKER_CONFLICT");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof Error && error.message === "REGISTRATION_MARKER_CONFLICT") throw error;
    fail("REGISTRATION_MARKER_INVALID");
  }
}

async function assertOwnedOrAbsent(filePath, marker) {
  let existing;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) fail("EXISTING_REGISTRATION_CONFLICT");
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof Error && error.message === "EXISTING_REGISTRATION_CONFLICT") throw error;
    fail("REGISTRATION_READ_FAILED");
  }
  if (existing !== undefined && (!marker || marker.manifestPath !== filePath || marker.manifestSha256 !== await sha256(existing))) {
    fail("EXISTING_REGISTRATION_CONFLICT");
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const platform = args.platform ?? process.platform;
  const home = homedir();
  const os = osPlatform(platform);
  const configFile = args.configfile ?? (os === "windows" ? undefined : "");
  if (os !== "windows" && !configFile) fail("CONFIG_PATH_MUST_BE_ABSOLUTE");
  const result = await registerNativeHost({ platform, home, localAppData: process.env.LOCALAPPDATA, installRoot: args.installroot, configFile,
    extensionId: args.extensionid, dryRun: args.dryRun });
  process.stdout.write(`${args.dryRun ? "DRY_RUN" : "REGISTERED"} ${JSON.stringify(result.plan)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safeCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "REGISTRATION_FAILED";
    process.stderr.write(`native host registration: ${safeCode}\n`);
    process.exitCode = 1;
  });
}
