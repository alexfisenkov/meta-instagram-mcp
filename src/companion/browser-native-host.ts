import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { loadBridgeClientConfig, OutboundBridgeClient } from "../bridge-client.js";
import type { BridgeTask } from "../companion-hub.js";
import { NativeFrameDecoder, encodeNativeFrame } from "./native-framing.js";
import { approvalPayloadHash, verifyUiApproval, type SignedUiApproval, type UiApprovalClaims } from "../ui-approval.js";

export interface BrowserBridgeClient {
  register(): Promise<{ bridgeId: string }>;
  heartbeat(bridgeId?: string, status?: unknown): Promise<void>;
  poll(bridgeId: string, maxTasks: number): Promise<BridgeTask[]>;
  submit(bridgeId: string, taskId: string, result: unknown, contextHash?: string): Promise<void>;
}

export interface BrowserNativeHostOptions {
  client: BrowserBridgeClient;
  accountBinding: string;
  expectedAccountHandle: string;
  input?: Readable;
  output?: Writable;
  log?: (message: string) => void;
  pollIntervalMs?: number;
  allowWrites?: boolean;
  /** Trusted server-side adapter: returns only after common MutationSafety approval and durable ATTEMPT. */
  authorizeWriteLease?: (task: BridgeTask, bridgeId: string) => Promise<BrowserWriteApproval | undefined>;
}

export interface BrowserWriteApproval {
  taskId: string;
  bridgeId: string;
  requestId: string;
  fingerprint: string;
  expectedFingerprint: string;
  contextHash: string;
  expiresAt: string;
  source: "browser";
  accountBinding: string;
  operation: string;
  target: Record<string, string>;
  payloadHash: string;
  signature: string;
}

export interface BrowserNativeHost {
  start(): Promise<void>;
  close(): void;
}

type HostMessage =
  | { kind: "hello"; version: 1 }
  | { kind: "result"; taskId: string; result: unknown; contextHash?: string };

const ALLOWED_OPERATIONS = new Set([
  "account.inspect", "account.snapshot",
  "inbox.list", "conversation.read", "comments.list", "comments.replies", "insights.read",
  "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply",
  "comment.like", "comment.unlike"
]);
const BROWSER_CAPABILITIES = new Set([
  "account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies",
  "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"
]);

/** Adapts one Chrome Native Messaging connection to the shared outbound bridge client. */
export function createBrowserNativeHost(options: BrowserNativeHostOptions): BrowserNativeHost {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(options.accountBinding)) throw new Error("invalid browser account binding");
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(options.expectedAccountHandle)) throw new Error("expected Instagram account handle is required");
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 30_000) throw new Error("invalid browser host poll interval");
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const decoder = new NativeFrameDecoder();
  const emitter = new EventEmitter();
  const writesDispatched = new Set<string>();
  const writeApprovals = new Map<string, BrowserWriteApproval>();
  const activeTasks = new Map<string, BridgeTask>();
  let bridgeId = "";
  const allowWrites = options.allowWrites === true;
  let connected = false;
  let closed = false;
  let busy = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let pollingStarted = false;
  let lastHubHeartbeatAt = 0;
  let lastNativePulseAt = 0;
  let liveReadiness: { availability: string; capabilities: string[]; accountHandle?: string } = { availability: "offline", capabilities: [] };
  let beginPolling = () => {};

  const send = (value: unknown) => {
    if (!closed) output.write(encodeNativeFrame(value));
  };
  const closeNow = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    input.removeAllListeners("data");
    emitter.removeAllListeners();
  };

  const submitWithoutRetry = async (task: BridgeTask, result: unknown, contextHash?: string) => {
    activeTasks.delete(task.id);
    if (task.operation === "account.inspect" && task.kind === "read") {
      const data = isRecord(result) && isRecord(result.data) ? result.data : undefined;
      const validProbe = isRecord(result) && result.source === "browser" && result.accountBinding === options.accountBinding &&
        result.availability === "ready" && data?.username?.toString().toLowerCase() === options.expectedAccountHandle.toLowerCase() &&
        data.surface === "instagram" && Array.isArray(data.capabilities);
      const rawCapabilities = Array.isArray(data?.capabilities) ? data.capabilities : [];
      const capabilities = validProbe ? rawCapabilities.filter((item): item is string => typeof item === "string" && BROWSER_CAPABILITIES.has(item)) : [];
      liveReadiness = validProbe && capabilities.includes("inbox.list")
        ? { availability: "ready", capabilities: [...new Set(capabilities)], accountHandle: options.expectedAccountHandle }
        : { availability: isRecord(result) && typeof result.availability === "string" ? result.availability : "offline", capabilities: [] };
      void options.client.heartbeat(bridgeId, { ...liveReadiness, accountBinding: options.accountBinding, surface: "instagram" }).catch(() => {});
      lastHubHeartbeatAt = Date.now();
    }
    try { await options.client.submit(bridgeId, task.id, result, contextHash); }
    catch (error) {
      // A write submit failure can follow successful UI execution. Never resend it.
      log(`bridge result submit failed (${task.kind}); request remains unresolved`);
      if (task.kind === "write") writesDispatched.add(task.id);
      void error;
    }
  };

  const onNativeMessage = (raw: unknown) => {
    if (!isRecord(raw) || typeof raw.kind !== "string") { log("ignored malformed native message"); return; }
    if (raw.kind === "hello" && raw.version === 1) {
      if (connected) return;
      connected = true;
      send({ kind: "ready", version: 1, accountBinding: options.accountBinding, expectedAccountHandle: options.expectedAccountHandle, allowWrites });
      emitter.emit("connected");
      beginPolling();
      return;
    }
    if (raw.kind !== "result" || typeof raw.taskId !== "string" || !("result" in raw)) {
      log("ignored unsupported native message");
      return;
    }
    const task = activeTasks.get(raw.taskId);
    if (!task || typeof raw.taskId !== "string") { log("ignored result for unknown task"); return; }
    if ((task.contextHash !== undefined && raw.contextHash !== task.contextHash) ||
        !validResult(raw.result, task, options.accountBinding, options.expectedAccountHandle, writeApprovals.get(task.id))) {
      const failure = task.kind === "write"
        ? { status: "OUTCOME_UNKNOWN", reason: "browser result did not match the assigned account or context" }
        : { availability: "unsupported_ui_version", coverage: "unknown", errors: [{ code: "invalid_result", message: "browser result failed provenance validation" }] };
      void submitWithoutRetry(task, failure, task.contextHash);
      return;
    }
    if (task.kind === "write") writesDispatched.add(task.id);
    void submitWithoutRetry(task, raw.result, typeof raw.contextHash === "string" ? raw.contextHash : undefined);
  };

  input.on("data", (chunk: Buffer | Uint8Array) => {
    try { for (const message of decoder.push(chunk)) onNativeMessage(message); }
    catch (error) { log(error instanceof Error ? error.message : "native frame rejected"); closeNow(); }
  });
  input.on("end", closeNow);
  input.on("error", closeNow);

  const poll = async () => {
    if (closed || !connected || busy) return;
    busy = true;
    try {
      const now = Date.now();
      if (now - lastHubHeartbeatAt >= 15_000) {
        await options.client.heartbeat(bridgeId, { ...liveReadiness, accountBinding: options.accountBinding, surface: "instagram" });
        lastHubHeartbeatAt = now;
      }
      if (now - lastNativePulseAt >= 15_000) {
        send({ kind: "heartbeat" });
        lastNativePulseAt = now;
      }
      for (const task of await options.client.poll(bridgeId, 10)) {
        if (!validTask(task, options.accountBinding)) {
          log("ignored task outside the browser operation allowlist");
          continue;
        }
        if (task.kind === "write" && !allowWrites) {
          if (writesDispatched.has(task.id)) continue;
          writesDispatched.add(task.id);
          await submitWithoutRetry(task, { status: "FAILED", reason: "browser write gate is disabled" }, task.contextHash);
          continue;
        }
        if (activeTasks.has(task.id)) continue;
        const approval = task.kind === "write" && allowWrites && options.authorizeWriteLease
          ? await options.authorizeWriteLease(task, bridgeId).catch(() => undefined) : undefined;
        if (task.kind === "write" && !approvedWriteTask(task, bridgeId, options.accountBinding, approval)) {
          writesDispatched.add(task.id);
          await submitWithoutRetry(task, { status: "FAILED", reason: "browser write task has no verified MutationSafety approval and durable attempt" }, task.contextHash);
          continue;
        }
        if (task.kind === "write" && approval) writeApprovals.set(task.id, approval);
        activeTasks.set(task.id, task);
        send({ kind: "task", task, ...(task.kind === "write" && approval ? { approval } : {}) });
      }
    } catch (error) {
      log(`bridge poll failed: ${safeError(error)}`);
    } finally { busy = false; }
  };

  beginPolling = () => {
    if (pollingStarted || closed || !connected || !bridgeId) return;
    pollingStarted = true;
    void poll();
    pollTimer = setInterval(() => { void poll(); }, pollIntervalMs);
    pollTimer.unref?.();
  };

  return {
    async start() {
      if (closed) throw new Error("browser native host is closed");
      bridgeId = (await options.client.register()).bridgeId;
      if (!bridgeId) throw new Error("bridge registration returned no bridge id");
      emitter.once("connected", beginPolling);
      beginPolling();
    },
    close() {
      closeNow();
    }
  };
}

/** Native Messaging executable entry point; configuration remains in a private external file. */
export async function runBrowserNativeHostCli(args = process.argv.slice(2), env = process.env): Promise<void> {
  const originMatch = (args[0] ?? "").match(/^chrome-extension:\/\/([a-p]{32})\/$/);
  if (!originMatch || (env.INSTAGRAM_MCP_EXTENSION_ID && originMatch[1] !== env.INSTAGRAM_MCP_EXTENSION_ID)) {
    process.stderr.write("Instagram Native Host rejected the extension origin.\n");
    process.exitCode = 1;
    return;
  }
  const configPath = env.INSTAGRAM_MCP_BRIDGE_CONFIG;
  if (!configPath) {
    process.stderr.write("Instagram Native Host configuration is incomplete.\n");
    process.exitCode = 1;
    return;
  }
  try {
    const localConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const accountHandle = localConfig.expectedAccountHandle;
    if (typeof accountHandle !== "string" || !/^[a-zA-Z0-9._]{1,30}$/.test(accountHandle)) throw new Error("expected Instagram account handle is required");
    const config = await loadBridgeClientConfig(configPath);
    const client = new OutboundBridgeClient({ ...config, credentialsPath: configPath });
    const host = createBrowserNativeHost({ client, accountBinding: config.accountBinding, expectedAccountHandle: accountHandle,
      allowWrites: localConfig.allowBrowserWrites === true && env.INSTAGRAM_MCP_BROWSER_WRITES === "true",
      authorizeWriteLease: async (task, bridgeId) => {
        const grant = task.writeApproval as SignedUiApproval | undefined;
        const publicKey = client.approvalPublicKey;
        if (!publicKey || !verifyUiApproval(task, grant, publicKey, { bridgeId, source: "browser" })) return undefined;
        const claims = grant!.claims as UiApprovalClaims;
        return { taskId: claims.taskId, bridgeId: claims.bridgeId, requestId: claims.requestId, fingerprint: claims.fingerprint,
          expectedFingerprint: claims.fingerprint, contextHash: claims.contextHash, expiresAt: claims.expiresAt,
          source: "browser", accountBinding: claims.accountBinding, operation: claims.operation,
          target: claims.target, payloadHash: claims.payloadHash, signature: grant!.signature };
      } });
    await host.start();
    process.stdin.resume();
    process.stdin.once("end", () => host.close());
    process.stdin.once("error", () => host.close());
  } catch (error) {
    process.stderr.write(`Instagram Native Host failed to start: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/browser-native-host.js")) {
  void runBrowserNativeHostCli();
}

function validTask(value: unknown, accountBinding: string): value is BridgeTask {
  if (!isRecord(value)) return false;
  const requiresTarget = ["conversation.read", "comments.list", "comments.replies", "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"].includes(String(value.operation));
  return typeof value.id === "string" && value.id.length <= 128 &&
    ["read", "preview", "write"].includes(String(value.kind)) && value.source === "browser" &&
    typeof value.bridgeId === "string" && value.accountBinding === accountBinding &&
    typeof value.operation === "string" && ALLOWED_OPERATIONS.has(value.operation) &&
    Array.isArray(value.targetRefs) && value.targetRefs.length <= 1 && (!requiresTarget || value.targetRefs.length === 1) && value.targetRefs.every(isTargetRef) &&
    isRecord(value.payload) && !containsForbiddenKey(value.payload) && typeof value.expiresAt === "string" &&
    (value.contextHash === undefined || typeof value.contextHash === "string");
}

function approvedWriteTask(task: BridgeTask, bridgeId: string, accountBinding: string, approval?: BrowserWriteApproval): boolean {
  if (task.kind !== "write" || task.bridgeId !== bridgeId || task.accountBinding !== accountBinding ||
      !task.contextHash || !/^[a-f0-9]{16,128}$/i.test(task.contextHash) || !/^[\w-]{16,128}$/.test(task.id) ||
      Date.parse(task.expiresAt) <= Date.now() || Date.parse(task.expiresAt) - Date.now() > 30_000 ||
      !approval || approval.taskId !== task.id || approval.bridgeId !== bridgeId || !/^[\w-]{16,128}$/.test(approval.requestId) ||
      !/^[a-f0-9]{64}$/i.test(approval.fingerprint) || approval.expectedFingerprint !== approval.fingerprint ||
      approval.fingerprint !== task.fingerprint ||
      approval.contextHash !== task.contextHash || approval.expiresAt !== task.expiresAt || Date.parse(approval.expiresAt) <= Date.now() ||
      approval.source !== "browser" || approval.accountBinding !== task.accountBinding || approval.operation !== task.operation ||
      approval.payloadHash !== approvalPayloadHash(task.payload) || !/^[A-Za-z0-9_-]{80,100}$/.test(approval.signature)) return false;
  const target = task.targetRefs[0];
  if (!target || target.accountBinding !== accountBinding || !target.nativeId || stableTarget(approval.target) !== stableTarget(target)) return false;
  const payload = task.payload;
  const shape = task.operation === "message.send" || task.operation === "comment.reply" || task.operation === "comment.private_reply"
    ? { kind: task.operation, text: payload.text }
    : task.operation === "message.react" || task.operation === "message.unreact"
      ? { kind: task.operation, reaction: payload.reaction } : { kind: task.operation };
  if (("text" in shape && (typeof shape.text !== "string" || !shape.text.trim() || shape.text.length > 2_200)) ||
      ("reaction" in shape && (typeof shape.reaction !== "string" || !shape.reaction))) return false;
  return true;
}

function isTargetRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => ["accountBinding", "nativeId", "instagramUrl", "explicitOwnerRef"].includes(key)) &&
    keys.every((key) => typeof value[key] === "string" && (value[key] as string).length <= 512);
}

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item: unknown) => containsForbiddenKey(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => /cookie|token|secret|password|credential|session|storage|selector|script|shell|click|tap/i.test(key) || containsForbiddenKey(child, depth + 1));
}

function validResult(value: unknown, task: BridgeTask, accountBinding: string, expectedHandle: string, approval?: BrowserWriteApproval): boolean {
  if (task.kind === "write") return isRecord(value) && (["ACK", "OBSERVED", "FAILED"].includes(String(value.status)) ||
    (value.status === "OUTCOME_UNKNOWN" && Boolean(approval) && value.requestId === approval?.requestId && value.contextHash === task.contextHash));
  if (!isRecord(value) || value.source !== "browser" || value.accountBinding !== accountBinding ||
      typeof value.nativeRef !== "string" || typeof value.capturedAt !== "string" ||
      !["ready", "permission_blocked", "missing_scope", "offline", "not_connected", "unsupported", "unsupported_ui_version", "needs_selection"].includes(String(value.availability)) ||
      !["complete", "partial", "unknown"].includes(String(value.coverage)) ||
      !["complete", "limited", "unknown", "not_applicable"].includes(String(value.historyCompleteness)) ||
      !Array.isArray(value.errors) || containsForbiddenKey(value)) return false;
  if (value.availability === "ready") {
    const data = isRecord(value.data) ? value.data : undefined;
    if (!data || typeof data.username !== "string" || data.username.toLowerCase() !== expectedHandle.toLowerCase()) return false;
    if (task.operation === "account.inspect" && (data.surface !== "instagram" || !Array.isArray(data.capabilities) ||
        !data.capabilities.some((item) => typeof item === "string" && BROWSER_CAPABILITIES.has(item)))) return false;
  }
  const target = task.targetRefs[0];
  if (task.kind === "preview") {
    const data = isRecord(value.data) ? value.data : undefined;
    const preview = data && isRecord(data.preview) ? data.preview : undefined;
    if (!data || !preview || preview.source !== "browser" || preview.action !== task.operation ||
        preview.contextHash !== task.contextHash || !target ||
        !isRecord(preview.target) || preview.target.accountBinding !== accountBinding || preview.target.nativeId !== target.nativeId ||
        data.execution !== "disabled_pending_authenticated_ui_verification") return false;
  }
  if ((task.operation === "conversation.read" || task.operation.startsWith("message.")) && target?.nativeId) {
    if (value.nativeRef.replace(/\/$/, "") !== `/direct/t/${target.nativeId}`) return false;
  }
  if ((["comments.list", "comments.replies"].includes(task.operation) || task.operation.startsWith("comment.")) && target?.nativeId) {
    const postId = typeof target.instagramUrl === "string" ? mediaIdFromUrl(target.instagramUrl) : target.nativeId;
    if (!postId || !new RegExp(`^/(?:p|reel|tv)/${escapeRegExp(postId)}/?$`).test(value.nativeRef)) return false;
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableTarget(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function mediaIdFromUrl(value: string): string {
  try { return new URL(value).pathname.match(/^\/(?:p|reel|tv)\/([^/]+)\/?$/)?.[1] ?? ""; }
  catch { return ""; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : "unknown error";
  return message.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 200);
}
