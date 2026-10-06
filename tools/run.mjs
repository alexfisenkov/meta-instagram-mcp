#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  for (const [index, rawLine] of readFileSync(configPath, "utf8").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`CONFIG_LINE_INVALID_${index + 1}`);
    const name = line.slice(0, separator).trim();
    if (!/^META_(?!MCP_)[A-Z0-9_]+$/.test(name)) throw new Error(`CONFIG_NAME_INVALID_${index + 1}`);
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return { configPath, loaded: true, values };
}

export function applyExternalConfig(configDirectory = defaultConfigDirectory()) {
  const result = loadExternalConfig(configDirectory);
  for (const [name, value] of Object.entries(result.values)) {
    if (value !== "" && process.env[name] === undefined) process.env[name] = value;
  }
  if (!existsSync(join(packageRoot, ".env"))) {
    if (!process.env.META_TOKEN_STORE_PATH?.trim()) process.env.META_TOKEN_STORE_PATH = join(configDirectory, "token.json");
    if (!process.env.META_INSTAGRAM_PUBLISH_LOG?.trim()) process.env.META_INSTAGRAM_PUBLISH_LOG = join(configDirectory, "publish-log.jsonl");
  }
  return result;
}

async function startServer() {
  const configDirectory = defaultConfigDirectory();
  try {
    applyExternalConfig(configDirectory);
    const serverPath = join(packageRoot, "dist", "server.js");
    if (!existsSync(serverPath)) throw new Error("BUILD_MISSING");
    await import(pathToFileURL(serverPath).href);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "START_FAILED";
    process.stderr.write(`meta-instagram-mcp: ${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await startServer();
}
