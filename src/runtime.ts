import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCompanionSourceProvider } from "./companion-source-provider.js";
import { CompanionHub } from "./companion-hub.js";
import type { MetaInstagramConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { createOAuthCallbackHandler, createOAuthCallbackService, type OAuthCallbackService } from "./callback-server.js";
import { buildAuthUrl, defaultScopesForAuthMode, exchangeCodeForLongLivedToken } from "./oauth.js";
import { createOAuthStateStore, type OAuthStateBinding } from "./oauth-state.js";
import { loadStoredToken, saveStoredToken } from "./token-store.js";
import type { WebhookReceiver } from "./webhooks.js";
import { createWebhookReceiver } from "./webhooks.js";
import { WebhookJournal } from "./webhook-journal.js";
import { createLayeredToolHandlers, type HostAnalysisPort } from "./layered-tools.js";
import { createMcpServer, type ExistingToolHandlers } from "./mcp-server.js";
import { createSourceRouter, type SourceProvider, type SourceRouter } from "./source-router.js";
import { startHttpServer, type HttpOptions, type Listener } from "./http-server.js";
import { createToolHandlers } from "./tools.js";
import { MutationSafety } from "./action-safety.js";
import { createUiApprovalAuthority, type UiApprovalAuthority } from "./ui-approval.js";
import { createMutationExecutors } from "./mutation-executors.js";
import { createMutationToolHandlers } from "./mutation-tools.js";
import { copyFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { registerMutationTools, type MutationToolHandlers } from "./mutation-tools.js";
import type { MutationExecutor } from "./action-safety.js";
import { FileActionReadbackStore } from "./action-readback.js";

export interface RuntimeOptions {
  config?: MetaInstagramConfig;
  existingHandlers?: ExistingToolHandlers;
  /** When provided, this exact provider list can run browser/phone-only deployments without Meta credentials. */
  providers?: readonly SourceProvider[];
  hub?: CompanionHub;
  hubStoragePath?: string;
  approvalKeyPath?: string;
  auditPath?: string;
  readbackPath?: string;
  /** Narrow runtime seam for deterministic integration tests and custom source adapters. */
  mutationExecutors?: readonly MutationExecutor[];
  hostAnalysis?: HostAnalysisPort;
  oauth?: { service: OAuthCallbackService; redirectUri: string; path?: string };
  webhook?: { receiver: WebhookReceiver; path?: string };
}

export interface InstagramRuntime {
  readonly hub: CompanionHub;
  readonly router: SourceRouter;
  initialize(): Promise<void>;
  createMcpServer(): McpServer;
  startHttpServer(options: HttpOptions): Promise<Listener>;
}

/** Composes the legacy API handlers, layered source tools, and shared Hub for stdio or HTTP. */
export function createRuntime(options: RuntimeOptions = {}): InstagramRuntime {
  const config = options.config ?? loadConfig();
  const existingHandlers = options.existingHandlers ?? createToolHandlers({ config });
  const hub = options.hub ?? new CompanionHub({
    storagePath: options.hubStoragePath ?? process.env.INSTAGRAM_MCP_HUB_STATE_PATH ?? join(homedir(), ".config", "meta-instagram-mcp", "companion-hub.json")
  });
  const providers = options.providers ?? [
    existingHandlers.apiProvider,
    createCompanionSourceProvider({ hub, source: "browser" }),
    createCompanionSourceProvider({ hub, source: "phone" })
  ];
  const router = createSourceRouter({ providers });
  const readbackPath = options.readbackPath ?? join(dirname(config.tokenStorePath), "mutation-readback.json");
  assertPrivatePath(readbackPath);
  const readbackStore = new FileActionReadbackStore(readbackPath);
  const layeredHandlers = createLayeredToolHandlers({ router, hostAnalysis: options.hostAnalysis, actionReadbacks: readbackStore });
  const oauth = options.oauth ?? configuredOAuth(config);
  const webhook = options.webhook ?? configuredWebhook(config);
  let authorityPromise: Promise<UiApprovalAuthority> | undefined;
  const authority = () => authorityPromise ??= createUiApprovalAuthority({
    privateKeyPath: options.approvalKeyPath ?? join(dirname(config.tokenStorePath), "ui-approval-key.json")
  });
  const initialize = async () => { hub.setApprovalPublicKey((await authority()).publicKey); };
  const api = (existingHandlers as ExistingToolHandlers & { apiProvider?: import("./api-provider.js").ApiProvider }).apiProvider;
  const executors = options.mutationExecutors ?? createMutationExecutors({
    ...(api ? { api } : {}),
    browser: providers.find((provider) => provider.source === "browser"),
    phone: providers.find((provider) => provider.source === "phone"),
    hub, authority
  });
  const mutationAuditPath = options.auditPath ?? join(dirname(config.tokenStorePath), "mutation-audit.jsonl");
  assertPrivatePath(mutationAuditPath);
  const mutationHandlers: MutationToolHandlers = createMutationToolHandlers({
    safety: new MutationSafety({ executors, auditPath: mutationAuditPath,
      sourceWriteEnabled: { api: config.writeEnabled === true, browser: config.browserWriteEnabled === true, phone: config.phoneWriteEnabled === true } }),
    executors,
    readbackStore,
    deleteEnabled: config.deleteEnabled === true,
    beginOAuth: async () => {
      if (!oauth || !config.appId || !config.redirectUri) throw new Error("OAuth is not configured; the authorization route remains unavailable.");
      const state = await oauth.service.issueState();
      const loginUrl = buildAuthUrl({ authMode: config.authMode, appId: config.appId!, redirectUri: config.redirectUri!,
        scopes: config.defaultScopes ?? defaultScopesForAuthMode(config.authMode), forceReauth: true, graphApiVersion: config.graphApiVersion });
      loginUrl.searchParams.set("state", state);
      return { authorizationUrl: loginUrl.toString(), expiresInSeconds: 600 };
    }
  });
  const makeMcpServer = () => {
    const server = createMcpServer(existingHandlers, layeredHandlers);
    registerMutationTools(server, mutationHandlers);
    return server;
  };
  return {
    hub,
    router,
    initialize,
    createMcpServer: makeMcpServer,
    async startHttpServer(httpOptions) {
      await initialize();
      return startHttpServer({
        ...httpOptions,
        hub,
        mcpFactory: makeMcpServer,
        ...(oauth ? { oauthPath: options.oauth?.path ?? new URL(oauth.redirectUri).pathname, oauthHandler: createOAuthCallbackHandler(oauth.service, oauth.redirectUri) } : {}),
        ...(webhook ? { webhookPath: options.webhook?.path ?? webhook.path, webhookReceiver: webhook.receiver } : {})
      });
    }
  };
}

function configuredOAuth(config: MetaInstagramConfig): { service: OAuthCallbackService; redirectUri: string } | undefined {
  if (!config.appId || !config.appSecret || !config.redirectUri) return undefined;
  assertPrivatePath(config.tokenStorePath);
  let redirect: URL;
  try { redirect = new URL(config.redirectUri); } catch { return undefined; }
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(redirect.hostname))) return undefined;
  const expectedAccountId = config.userId;
  const binding: OAuthStateBinding = { accountBinding: `${config.authMode}:${expectedAccountId ?? "configured"}`, authMode: config.authMode,
    redirectUri: config.redirectUri, ...(expectedAccountId ? { expectedAccountId } : {}) };
  const service = createOAuthCallbackService({
    stateStore: createOAuthStateStore({ directory: `${config.tokenStorePath}.oauth-state` }), binding,
    exchangeCode: (code) => exchangeCodeForLongLivedToken({ authMode: config.authMode, code, appId: config.appId!, appSecret: config.appSecret!, redirectUri: config.redirectUri!, graphApiVersion: config.graphApiVersion }),
    readCurrentToken: () => loadStoredToken(config.tokenStorePath),
    backupToken: async () => { const backup = `${config.tokenStorePath}.backup-${Date.now()}-${randomBytes(6).toString("hex")}`; await copyFile(config.tokenStorePath, backup); await chmod(backup, 0o600); },
    saveToken: (token) => saveStoredToken(config.tokenStorePath, token)
  });
  return { service, redirectUri: config.redirectUri };
}

function configuredWebhook(config: MetaInstagramConfig): { receiver: WebhookReceiver; path: string } | undefined {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  const expectedAccountIds = (process.env.META_WEBHOOK_ACCOUNT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!config.appSecret || !verifyToken || !expectedAccountIds.length) return undefined;
  const path = process.env.META_WEBHOOK_PATH?.trim() || "/webhook";
  const journalPath = process.env.META_WEBHOOK_JOURNAL_PATH?.trim() || join(dirname(config.tokenStorePath), "webhook-events.jsonl");
  assertPrivatePath(journalPath);
  const journal = new WebhookJournal({ path: journalPath });
  return { path, receiver: createWebhookReceiver({ appSecret: config.appSecret, verifyToken, expectedAccountIds, journal, callbackPath: path }) };
}

function assertPrivatePath(path: string): void {
  if (!isAbsolute(path)) throw new Error("Webhook journal path must be absolute.");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rel = relative(root, resolve(path));
  if (rel === ".." || !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Private runtime state must be outside the project directory.");
}
