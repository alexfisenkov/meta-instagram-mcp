import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthMode } from "./oauth.js";

export interface MetaInstagramConfig {
  authMode: AuthMode;
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  userId?: string;
  pageId?: string;
  defaultScopes?: string[];
  graphApiVersion: string;
  tokenStorePath: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): MetaInstagramConfig {
  const effectiveEnv = env === process.env ? { ...loadProjectDotEnv(), ...process.env } : env;
  const home = effectiveEnv.HOME ?? process.env.HOME ?? ".";
  return {
    authMode: parseAuthMode(effectiveEnv.META_AUTH_MODE ?? effectiveEnv.META_INSTAGRAM_AUTH_MODE),
    appId: blankToUndefined(effectiveEnv.META_INSTAGRAM_APP_ID),
    appSecret: blankToUndefined(effectiveEnv.META_INSTAGRAM_APP_SECRET),
    redirectUri: blankToUndefined(effectiveEnv.META_INSTAGRAM_REDIRECT_URI),
    accessToken: blankToUndefined(effectiveEnv.META_INSTAGRAM_ACCESS_TOKEN),
    userId: blankToUndefined(effectiveEnv.META_INSTAGRAM_USER_ID),
    pageId: blankToUndefined(effectiveEnv.META_FACEBOOK_PAGE_ID),
    defaultScopes: parseList(effectiveEnv.META_INSTAGRAM_SCOPES),
    graphApiVersion: blankToUndefined(effectiveEnv.META_GRAPH_API_VERSION) ?? "v25.0",
    tokenStorePath: blankToUndefined(effectiveEnv.META_TOKEN_STORE_PATH) ?? join(home, ".config", "meta-instagram-mcp", "token.json")
  };
}

export function redactToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (token.length < 9) return "[redacted]";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseList(value: string | undefined): string[] | undefined {
  const parsed = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return parsed?.length ? parsed : undefined;
}

function parseAuthMode(value: string | undefined): AuthMode {
  const mode = blankToUndefined(value)?.toLowerCase();
  return mode === "facebook" ? "facebook" : "instagram";
}

function loadProjectDotEnv(): Env {
  const path = join(projectRoot(), ".env");
  if (!existsSync(path)) return {};
  const env: Env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    if (!key) continue;
    env[key] = unquote(value);
  }
  return env;
}

function projectRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return ["src", "dist"].includes(basename(moduleDir)) ? dirname(moduleDir) : process.cwd();
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
