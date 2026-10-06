import { copyFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-fs.js";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { buildAuthUrl, defaultScopesForAuthMode, exchangeCodeForLongLivedToken, type OAuthToken } from "./oauth.js";
import { createOAuthStateStore, type OAuthStateBinding, type OAuthStateStore } from "./oauth-state.js";
import { loadStoredToken, saveStoredToken, type StoredInstagramToken } from "./token-store.js";

export type ParsedCallback =
  | { type: "code"; code: string; state?: string }
  | { type: "error"; error: string; reason?: string; description?: string; state?: string }
  | { type: "ignored" };
export type CallbackHtmlModel =
  | { type: "success"; title: string; details: Record<string, unknown> }
  | { type: "error"; title: string; details: Record<string, unknown> };

export interface OAuthCallbackServiceOptions {
  stateStore: OAuthStateStore;
  binding: OAuthStateBinding;
  exchangeCode(code: string): Promise<OAuthToken>;
  readCurrentToken?(): Promise<StoredInstagramToken | undefined>;
  backupToken?(token: StoredInstagramToken): Promise<void>;
  saveToken(token: OAuthToken): Promise<void>;
}
export interface OAuthCallbackService {
  issueState(): Promise<string>;
  handleCallback(input: { url: string }): Promise<{ status: "success" | "failed"; message: string }>;
}

export function parseCallbackRequest(requestUrl: string, expectedPath: string): ParsedCallback {
  const url = new URL(requestUrl);
  if (url.pathname !== expectedPath) return { type: "ignored" };
  const states = url.searchParams.getAll("state");
  const state = states.length === 1 ? states[0] : undefined;
  const error = url.searchParams.get("error");
  if (error) return { type: "error", error, reason: url.searchParams.get("error_reason") ?? undefined, description: url.searchParams.get("error_description") ?? undefined, state };
  const codes = url.searchParams.getAll("code");
  if (codes.length === 1 && codes[0] && codes[0].length <= 4096) return { type: "code", code: codes[0], state };
  return { type: "error", error: "missing_code", description: "Missing authorization code.", state };
}

export function createOAuthCallbackService(options: OAuthCallbackServiceOptions): OAuthCallbackService {
  return {
    issueState: () => options.stateStore.issue(options.binding),
    async handleCallback(input) {
      let url: URL;
      try {
        url = new URL(input.url);
        if (!matchesRedirect(url, options.binding.redirectUri)) return failed();
      } catch { return failed(); }
      const parsed = parseCallbackRequest(url.href, new URL(options.binding.redirectUri).pathname);
      if (parsed.type === "ignored" || !parsed.state) return failed();
      const consumed = await safeConsume(options.stateStore, parsed.state, options.binding);
      if (!consumed) return failed();
      if (parsed.type !== "code" || !parsed.code) return failed();

      try {
        const current = await options.readCurrentToken?.();
        if (current?.authMode && current.authMode !== options.binding.authMode) return failed();
        if (options.binding.expectedAccountId && current?.userId && !constantStringEqual(options.binding.expectedAccountId, current.userId)) return failed();
        const next = await options.exchangeCode(parsed.code);
        if (next.authMode && next.authMode !== options.binding.authMode) return failed();
        const expectedAccountId = options.binding.expectedAccountId ?? current?.userId;
        if (expectedAccountId && next.userId && !constantStringEqual(expectedAccountId, next.userId)) return failed();
        if (current?.accessToken) {
          if (!options.backupToken) return failed();
          await options.backupToken(current);
        }
        const merged: OAuthToken = {
          ...next,
          authMode: options.binding.authMode,
          ...(next.userId || !current?.userId ? {} : { userId: current.userId }),
          ...(next.pageId || !current?.pageId ? {} : { pageId: current.pageId }),
          ...(next.permissions || !current?.permissions ? {} : { permissions: current.permissions }),
        };
        await options.saveToken(merged);
        return { status: "success", message: "Authorization complete." };
      } catch { return failed(); }
    },
  };
}

/** HTTP adapter for Ticket 03/08; caller owns auth, TLS termination, and access-log policy. */
export function createOAuthCallbackHandler(service: OAuthCallbackService, redirectUri: string) {
  const registered = new URL(redirectUri);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const incoming = new URL(request.url ?? "/", registered.origin);
    if (request.method !== "GET" || incoming.pathname !== registered.pathname) { writeResponse(response, 404, "Not found."); return; }
    const result = await service.handleCallback({ url: incoming.href });
    writeResponse(response, result.status === "success" ? 200 : 400, result.message);
  };
}

export function renderCallbackHtml(model: CallbackHtmlModel): string {
  const statusColor = model.type === "success" ? "#126c43" : "#a32121";
  const details = redactDetails(model.details);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(model.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;line-height:1.45}h1{color:${statusColor}}</style></head><body><h1>${escapeHtml(model.title)}</h1><p>You can return to Codex.</p><pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre></body></html>`;
}

export async function runCallbackServer(): Promise<void> {
  const config = loadConfig();
  if (!config.appId || !config.redirectUri) throw new Error("Missing OAuth app ID or redirect URI configuration.");
  const redirectUrl = new URL(config.redirectUri);
  if (!redirectUrl.hostname || !["localhost", "127.0.0.1", "::1"].includes(redirectUrl.hostname) || redirectUrl.protocol !== "http:") {
    throw new Error("Local callback helper only supports loopback HTTP redirect URIs.");
  }
  const current = await loadStoredToken(config.tokenStorePath);
  const binding: OAuthStateBinding = {
    accountBinding: `${config.authMode}:${current?.userId ?? current?.pageId ?? "local"}`,
    authMode: config.authMode, redirectUri: config.redirectUri,
    ...(current?.userId ? { expectedAccountId: current.userId } : {}),
  };
  const stateStore = createOAuthStateStore({ directory: `${config.tokenStorePath}.oauth-state` });
  const service = createOAuthCallbackService({
    stateStore, binding,
    exchangeCode: (code) => exchangeCodeForLongLivedToken({ authMode: config.authMode, code, appId: config.appId!, appSecret: config.appSecret!, redirectUri: config.redirectUri!, graphApiVersion: config.graphApiVersion }),
    readCurrentToken: () => loadStoredToken(config.tokenStorePath),
    backupToken: () => backupTokenFile(config.tokenStorePath),
    saveToken: (token) => saveStoredToken(config.tokenStorePath, token),
  });
  const state = await service.issueState();
  const loginUrl = buildAuthUrl({ authMode: config.authMode, appId: config.appId, redirectUri: config.redirectUri, scopes: config.defaultScopes ?? defaultScopesForAuthMode(config.authMode), forceReauth: true, graphApiVersion: config.graphApiVersion });
  loginUrl.searchParams.set("state", state);
  const server = createServer(createOAuthCallbackHandler(service, config.redirectUri));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirectUrl.port || 80), redirectUrl.hostname, resolve);
  });
  console.log(`OAuth callback server listening on ${config.redirectUri}`);
  try { await launchOAuthAuthorization(loginUrl.toString()); }
  catch (error) { server.close(); throw error; }
}

/** Opens the one-time authorization URL without exposing it through routine output. */
export async function launchOAuthAuthorization(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<void> = openSystemBrowser,
): Promise<void> {
  try {
    await openBrowser(authorizationUrl);
    console.log("Authorization page opened in your browser.");
  } catch {
    throw new Error("Could not open the authorization page. Run `npm run meta:callback` in a desktop session with a browser available.");
  }
}

async function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "powershell.exe"
      : process.platform === "linux" ? "xdg-open" : undefined;
  if (!command) throw new Error("Unsupported platform.");
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", "Start-Process -LiteralPath $args[0]", url]
    : [url];
  await promisify(execFile)(command, args, { windowsHide: true });
}

async function backupTokenFile(path: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const backupPath = `${path}.backup-${Date.now()}-${randomBytes(6).toString("hex")}`;
  await copyFile(path, backupPath, fsConstants.COPYFILE_EXCL);
  await ensurePrivateFile(backupPath);
}
async function safeConsume(store: OAuthStateStore, state: string, binding: OAuthStateBinding) {
  try { return await store.consume(state, binding); } catch { return undefined; }
}
function matchesRedirect(incoming: URL, redirectUri: string): boolean {
  const registered = new URL(redirectUri);
  if (incoming.origin !== registered.origin || incoming.pathname !== registered.pathname || incoming.hash) return false;
  const allowed = new Set(["code", "state", "error", "error_reason", "error_description"]);
  for (const key of incoming.searchParams.keys()) if (!allowed.has(key) && !registered.searchParams.has(key)) return false;
  for (const [key, value] of registered.searchParams) if (incoming.searchParams.get(key) !== value) return false;
  return true;
}
function failed(): { status: "failed"; message: string } { return { status: "failed", message: "Authorization failed. Close this page and restart the authorization flow." }; }
function writeResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  response.end(renderCallbackHtml({ type: status < 400 ? "success" : "error", title: message, details: {} }));
}
function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [
    key,
    /token|secret|code|state|credential|password/i.test(key) ? "[redacted]" : redactNested(value),
  ]));
}
function redactNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNested);
  if (typeof value !== "object" || value === null) return value;
  return redactDetails(value as Record<string, unknown>);
}
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function constantStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  if (!a.length || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}
