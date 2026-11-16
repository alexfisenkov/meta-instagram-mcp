#!/usr/bin/env node
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigDirectory, loadExternalConfig } from "./run.mjs";
import { registerNativeHost } from "./register-native-host.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "meta-instagram-mcp-browser-setup";
const CAPABILITIES = ["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies"];
const fail = (code) => { throw new Error(code); };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const samePath = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

async function fileSnapshot(path, privateFs) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return undefined; fail("BROWSER_SETUP_PATH_UNSAFE"); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 262_144) fail("BROWSER_SETUP_PATH_UNSAFE");
  await privateFs.assertPrivateFile(path);
  return await readFile(path, "utf8");
}

async function canonicalDirectory(path) {
  let current = resolve(path); const missing = [];
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("BROWSER_SETUP_PATH_UNSAFE");
      return resolve(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current); if (parent === current) fail("BROWSER_SETUP_PATH_UNSAFE");
      missing.push(current.slice(parent === sep ? parent.length : parent.length + 1)); current = parent;
    }
  }
}

async function privateWrite(path, contents, privateFs, expected) {
  const actual = await fileSnapshot(path, privateFs);
  if (actual !== expected) fail("BROWSER_SETUP_CONFIG_CHANGED");
  await privateFs.ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await privateFs.ensurePrivateFile(temporary);
    await file.writeFile(contents, "utf8"); await file.sync(); await file.close();
    if (await fileSnapshot(path, privateFs) !== expected) fail("BROWSER_SETUP_CONFIG_CHANGED");
    if (expected === undefined) { await link(temporary, path); await rm(temporary); }
    else await rename(temporary, path);
  } catch (error) { await file.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

function assertCompatible(values, name, desired) {
  if (Object.hasOwn(values, name) && values[name] !== desired) fail("BROWSER_SETUP_CONFIG_CONFLICT");
}

/** Preflight is read-only; apply writes only this user's external browser config and owned Chrome host registration. */
export async function setupBrowser(options = {}) {
  const platform = options.platform ?? process.platform;
  const windows = platform === "windows" || platform === "win32";
  const home = options.home ?? homedir();
  const installRoot = options.installRoot ?? packageRoot;
  const configDirectory = options.configDirectory ?? defaultConfigDirectory();
  const extensionId = options.extensionId;
  const accountHandle = options.accountHandle?.replace(/^@/, "");
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) fail("INVALID_EXTENSION_ID");
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(accountHandle ?? "")) fail("EXPECTED_INSTAGRAM_HANDLE_REQUIRED");
  if (!isAbsolute(installRoot) || !isAbsolute(configDirectory)) fail("BROWSER_SETUP_ABSOLUTE_PATH_REQUIRED");
  if ([installRoot, configDirectory, home].some((value) => /[\r\n]/.test(value))) fail("BROWSER_SETUP_PATH_UNSAFE");
  const install = await canonicalDirectory(installRoot); const configDir = await canonicalDirectory(configDirectory);
  const canonicalHome = await canonicalDirectory(home);
  if (samePath(configDir, dirname(configDir)) || samePath(configDir, canonicalHome) || samePath(install, dirname(install)) || samePath(install, canonicalHome)) fail("BROWSER_SETUP_PATH_UNSAFE");
  const rel = relative(install, configDir); const reverse = relative(configDir, install);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) || (reverse !== ".." && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))) fail("BROWSER_SETUP_CONFIG_MUST_BE_EXTERNAL");
  const privateFs = await import("../dist/private-fs.js");
  const envPath = join(configDir, ".env");
  const envBefore = await fileSnapshot(envPath, privateFs);
  const values = envBefore === undefined ? {} : loadExternalConfig(configDir).values;
  if (["INSTAGRAM_MCP_REMOTE_CONFIG", "INSTAGRAM_MCP_REMOTE_URL", "INSTAGRAM_MCP_REMOTE_BEARER_TOKEN"].some((key) => values[key]?.trim())) fail("BROWSER_SETUP_CONFIG_CONFLICT");
  if (values.INSTAGRAM_MCP_TRANSPORT && values.INSTAGRAM_MCP_TRANSPORT !== "stdio") fail("BROWSER_SETUP_CONFIG_CONFLICT");
  if (values.INSTAGRAM_MCP_HTTP_HOST && values.INSTAGRAM_MCP_HTTP_HOST !== "127.0.0.1") fail("BROWSER_SETUP_CONFIG_CONFLICT");
  const rawPort = options.port ?? values.INSTAGRAM_MCP_HTTP_PORT ?? 8788;
  if (!/^[1-9]\d{0,4}$/.test(String(rawPort)) || Number(rawPort) > 65535) fail("BROWSER_SETUP_PORT_INVALID");
  const port = Number(rawPort);
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const bridgePath = windows ? join(localAppData, "MetaInstagramCompanion", "browser-bridge.json") : join(configDir, "browser-bridge.json");
  const markerPath = join(configDir, ".browser-setup.json");
  const bridgeBefore = await fileSnapshot(bridgePath, privateFs); const markerBefore = await fileSnapshot(markerPath, privateFs);
  let marker; let bridge;
  try { marker = markerBefore === undefined ? undefined : JSON.parse(markerBefore); bridge = bridgeBefore === undefined ? undefined : JSON.parse(bridgeBefore); }
  catch { fail("BROWSER_SETUP_BRIDGE_CONFLICT"); }
  if ((markerBefore !== undefined && (!marker || typeof marker !== "object" || Array.isArray(marker) || typeof marker.installRoot !== "string" || typeof marker.bridgePath !== "string")) || (bridgeBefore !== undefined && (!bridge || typeof bridge !== "object" || Array.isArray(bridge)))) fail("BROWSER_SETUP_BRIDGE_CONFLICT");
  if ((bridge !== undefined && !marker) || (marker && (marker.owner !== OWNER || marker.version !== 1 || marker.extensionId !== extensionId || marker.accountHandle !== accountHandle || marker.port !== port || !samePath(marker.installRoot, install) || !samePath(marker.bridgePath, bridgePath)))) fail("BROWSER_SETUP_BRIDGE_CONFLICT");
  if (marker && !bridge) fail("BROWSER_SETUP_BRIDGE_CONFLICT");
  const bearerToken = bridge?.bearerToken ?? values.INSTAGRAM_MCP_HTTP_BEARER_TOKEN ?? randomBytes(32).toString("base64url");
  if (typeof bearerToken !== "string" || Buffer.byteLength(bearerToken) < 32) fail("BROWSER_SETUP_BEARER_INVALID");
  const accountBinding = bridge?.accountBinding ?? `instagram:browser:${randomBytes(12).toString("hex")}`;
  if (typeof accountBinding !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(accountBinding)) fail("BROWSER_SETUP_BRIDGE_CONFLICT");
  const baseUrl = `http://127.0.0.1:${port}`;
  if (bridge && (bridge.baseUrl !== baseUrl || bridge.mode !== "browser_native_host" || bridge.source !== "browser" || bridge.expectedAccountHandle !== accountHandle || bridge.allowLoopbackHttp !== true || bridge.allowBrowserWrites !== false || marker.bearerHash !== digest(bearerToken) || marker.accountBinding !== accountBinding || !Array.isArray(bridge.capabilities) || bridge.capabilities.some((capability) => !CAPABILITIES.includes(capability)))) fail("BROWSER_SETUP_BRIDGE_CONFLICT");
  const additions = { INSTAGRAM_MCP_BROWSER_BRIDGE: "true", INSTAGRAM_MCP_HTTP_HOST: "127.0.0.1", INSTAGRAM_MCP_HTTP_PORT: String(port),
    INSTAGRAM_MCP_HTTP_BEARER_TOKEN: bearerToken, INSTAGRAM_MCP_BRIDGE_CONFIG: bridgePath, INSTAGRAM_MCP_HUB_STATE_PATH: join(configDir, "browser-hub.json") };
  for (const [name, desired] of Object.entries(additions)) assertCompatible(values, name, desired);
  const registrationOptions = { platform, home, installRoot: install, configFile: bridgePath, extensionId, nodePath: process.execPath,
    localAppData, ...(options.registryAdapter ? { registryAdapter: options.registryAdapter } : {}) };
  const registration = await registerNativeHost({ ...registrationOptions, dryRun: true, pendingConfig: bridgeBefore === undefined });
  if (windows) {
    const expectedHash = options.windowsExeSha256;
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) fail("WINDOWS_HOST_CHECKSUM_REQUIRED");
    if (digest(await readFile(registration.plan.hostPath)) !== expectedHash.toLowerCase()) fail("WINDOWS_HOST_CHECKSUM_MISMATCH");
  }
  const plan = { configDirectory: configDir, bridgeConfig: bridgePath, nativeHost: registration.plan, port, writeEnabled: false,
    requiresManualInstagramLogin: true, needsClientRestart: true };
  if (options.apply !== true) return { status: "DRY_RUN", plan };

  await privateFs.ensurePrivateDirectory(configDir);
  const lockPath = join(configDir, ".browser-setup.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); } catch { fail("BROWSER_SETUP_LOCKED"); }
  try {
  await privateFs.ensurePrivateFile(lockPath);
  if (await fileSnapshot(envPath, privateFs) !== envBefore || await fileSnapshot(bridgePath, privateFs) !== bridgeBefore || await fileSnapshot(markerPath, privateFs) !== markerBefore) fail("BROWSER_SETUP_CONFIG_CHANGED");
  const bridgeText = `${JSON.stringify({ baseUrl, bearerToken, mode: "browser_native_host", source: "browser", accountBinding,
    expectedAccountHandle: accountHandle, capabilities: CAPABILITIES, allowLoopbackHttp: true, allowBrowserWrites: false }, null, 2)}\n`;
  const markerText = `${JSON.stringify({ owner: OWNER, version: 1, extensionId, accountHandle, port, installRoot: install, bridgePath,
    accountBinding, bearerHash: digest(bearerToken) }, null, 2)}\n`;
  if (bridgeBefore === undefined) await privateWrite(bridgePath, bridgeText, privateFs, undefined);
  if (markerBefore === undefined) await privateWrite(markerPath, markerText, privateFs, undefined);
  await registerNativeHost(registrationOptions);
  const newEntries = Object.entries(additions).filter(([name]) => !Object.hasOwn(values, name));
  if (newEntries.length) {
    if (envBefore !== undefined) await privateWrite(`${envPath}.backup-${Date.now()}-${randomUUID()}`, envBefore, privateFs, undefined);
    const prefix = envBefore ?? "";
    const updated = `${prefix}${prefix && !prefix.endsWith("\n") ? "\n" : ""}# Local read-only Instagram browser bridge\n${newEntries.map(([name, value]) => `${name}="${value}"`).join("\n")}\n`;
    await privateWrite(envPath, updated, privateFs, envBefore);
  }
  return { status: "APPLIED", plan };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

function parseArgs(argv) {
  const options = {}; const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (seen.has(key) || (["--apply", "--dry-run"].includes(key) && (seen.has("--apply") || seen.has("--dry-run")))) fail("INVALID_ARGUMENTS");
    seen.add(key);
    if (key === "--apply") { options.apply = true; continue; }
    if (key === "--dry-run") { options.apply = false; continue; }
    const names = { "--extension-id": "extensionId", "--account-handle": "accountHandle", "--install-root": "installRoot", "--config-dir": "configDirectory", "--port": "port", "--windows-exe-sha256": "windowsExeSha256" };
    if (!names[key] || !argv[index + 1] || argv[index + 1].startsWith("--")) fail("INVALID_ARGUMENTS");
    options[names[key]] = argv[++index];
  }
  return options;
}

export async function runBrowserSetupCli(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write("Usage: node tools/cli.mjs browser-setup --extension-id ID --account-handle HANDLE [--install-root ABS] [--config-dir ABS] [--port 8788] [--windows-exe-sha256 SHA256] [--apply]\nDefault: dry-run; no Chrome login or client configuration changes.\n");
    return;
  }
  try { const result = await setupBrowser(parseArgs(argv)); process.stdout.write(`${JSON.stringify(result)}\n`); }
  catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "BROWSER_SETUP_FAILED";
    process.stderr.write(`browser setup: ${code}\n`); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runBrowserSetupCli();
