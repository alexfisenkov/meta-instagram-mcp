#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SUPPORTED_CONFIG_NAMES = new Set([
  "META_AUTH_MODE", "META_INSTAGRAM_AUTH_MODE", "META_INSTAGRAM_APP_ID", "META_INSTAGRAM_APP_SECRET",
  "META_INSTAGRAM_REDIRECT_URI", "META_INSTAGRAM_SCOPES", "META_INSTAGRAM_ACCESS_TOKEN",
  "META_INSTAGRAM_USER_ID", "META_FACEBOOK_PAGE_ID", "META_GRAPH_API_VERSION", "META_TOKEN_STORE_PATH",
  "META_INSTAGRAM_WRITE", "META_INSTAGRAM_DELETE", "META_INSTAGRAM_PUBLISH_LOG", "META_GRAPH_FALLBACK_IPS",
  "META_GRAPH_TIMEOUT_MS", "META_GRAPH_PREFER_FALLBACK", "META_WEBHOOK_VERIFY_TOKEN", "META_WEBHOOK_ACCOUNT_IDS",
  "META_WEBHOOK_PATH", "META_WEBHOOK_JOURNAL_PATH", "INSTAGRAM_MCP_TRANSPORT", "INSTAGRAM_MCP_HUB_STATE_PATH",
  "INSTAGRAM_MCP_BROWSER_WRITES", "INSTAGRAM_MCP_PHONE_WRITES", "INSTAGRAM_MCP_PHONE_CONFIG",
  "INSTAGRAM_MCP_BRIDGE_CONFIG", "INSTAGRAM_MCP_EXTENSION_ID", "INSTAGRAM_MCP_HTTP_PORT",
  "INSTAGRAM_MCP_HTTP_HOST", "INSTAGRAM_MCP_HTTP_BEARER_TOKEN", "INSTAGRAM_MCP_HTTP_ALLOWED_HOSTS",
  "INSTAGRAM_MCP_HTTP_ALLOWED_ORIGINS", "INSTAGRAM_MCP_HTTP_MAX_REQUEST_BYTES", "INSTAGRAM_MCP_REMOTE_CONFIG",
  "INSTAGRAM_MCP_REMOTE_URL", "INSTAGRAM_MCP_REMOTE_BEARER_TOKEN"
]);

export function serverEntrypoint(packageRoot, env = process.env) {
  const remoteConfigured = [env.INSTAGRAM_MCP_REMOTE_CONFIG, env.INSTAGRAM_MCP_REMOTE_URL, env.INSTAGRAM_MCP_REMOTE_BEARER_TOKEN]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  return join(packageRoot, "dist", remoteConfigured ? "cli/remote-proxy.js" : "server.js");
}

export function defaultConfigDirectory(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  return resolve(env.META_MCP_CONFIG_DIR || join(xdg, "meta-instagram-mcp"));
}

export function loadExternalConfig(configDirectory = defaultConfigDirectory()) {
  const configPath = join(configDirectory, ".env");
  if (!existsSync(configPath)) return { configPath, loaded: false, values: {} };

  const stat = statSync(configPath);
  if (!stat.isFile()) throw new Error("CONFIG_FILE_NOT_REGULAR");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("CONFIG_FILE_PERMISSIONS");
  }

  const values = {};
  const text = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`CONFIG_LINE_INVALID_${index + 1}`);
    const name = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`CONFIG_NAME_INVALID_${index + 1}`);
    if (!SUPPORTED_CONFIG_NAMES.has(name)) throw new Error(`CONFIG_NAME_UNSUPPORTED_${index + 1}`);
    if (Object.hasOwn(values, name)) throw new Error(`CONFIG_NAME_DUPLICATE_${index + 1}`);
    let value = line.slice(separator + 1).trim();
    if (value.startsWith("\"") || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error(`CONFIG_VALUE_INVALID_${index + 1}`);
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return { configPath, loaded: true, values };
}

export function applyExternalConfig(configDirectory = defaultConfigDirectory()) {
  const result = loadExternalConfig(configDirectory);
  for (const [name, value] of Object.entries(result.values)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  if (!process.env.META_TOKEN_STORE_PATH?.trim()) process.env.META_TOKEN_STORE_PATH = join(configDirectory, "token.json");
  if (!process.env.META_INSTAGRAM_PUBLISH_LOG?.trim()) process.env.META_INSTAGRAM_PUBLISH_LOG = join(configDirectory, "publish-log.jsonl");
  return result;
}

async function startServer() {
  const configDirectory = defaultConfigDirectory();
  try {
    applyExternalConfig(configDirectory);
    const serverPath = serverEntrypoint(packageRoot, process.env);
    if (!existsSync(serverPath)) throw new Error("BUILD_MISSING");
    await runServerProcess(serverPath);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "START_FAILED";
    process.stderr.write(`meta-instagram-mcp: ${code}\n`);
    process.exitCode = 1;
  }
}

async function runServerProcess(serverPath) {
  const child = spawn(process.execPath, [serverPath], { cwd: packageRoot, env: process.env, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  let receivedSignal;
  const handlers = new Map(signals.map((signal) => [signal, () => {
    receivedSignal = signal;
    if (child.exitCode === null) child.kill(signal);
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
    process.stderr.write("meta-instagram-mcp: START_FAILED\n");
  });
  const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (spawnFailed) process.exitCode = 1;
  else if (receivedSignal && process.platform !== "win32") process.kill(process.pid, receivedSignal);
  else if (receivedSignal) process.exitCode = ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[receivedSignal] ?? 1;
  else if (result.signal && process.platform !== "win32") process.kill(process.pid, result.signal);
  else if (result.signal) process.exitCode = ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[result.signal] ?? 1;
  else process.exitCode = result.code ?? 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await startServer();
}
