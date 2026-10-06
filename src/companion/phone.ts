import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadBridgeClientConfig, OutboundBridgeClient } from "../bridge-client.js";
import type { BridgeTask } from "../companion-hub.js";
import type { MutationIntent, MutationResult, TargetRef } from "../domain-types.js";
import { verifyUiApproval, type SignedUiApproval } from "../ui-approval.js";
import { createPhoneUiProvider, type PhoneUiOperation, type PhoneUiProvider } from "../providers/phone-ui.js";
import { createAppiumClient, type AppiumDeviceConfig, type AppiumReadiness } from "../providers/appium-client.js";
import { assertOutsideDirectory, assertPrivateFile } from "../private-fs.js";

export interface PhoneBridgeClient {
  register(capabilities?: readonly string[]): Promise<{ bridgeId: string; approvalPublicKey?: string }>;
  heartbeat(bridgeId: string, status?: unknown): Promise<void>;
  poll(bridgeId: string, maxTasks: number): Promise<BridgeTask[]>;
  submit(bridgeId: string, taskId: string, result: unknown, contextHash?: string): Promise<void>;
}
export interface PhoneAppiumLifecycle {
  readiness(): Promise<AppiumReadiness>;
  createSession(): Promise<unknown>;
  close(): Promise<void>;
}
export interface PhoneCompanionOptions {
  appium: PhoneAppiumLifecycle;
  provider: PhoneUiProvider;
  client: PhoneBridgeClient;
  accountBinding: string;
  expectedAccountHandle: string;
  trustedApprovalPublicKey?: string;
  pollIntervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}
export interface PhoneCompanion {
  start(): Promise<AppiumReadiness>;
  close(): Promise<void>;
  handleTask(task: BridgeTask): Promise<void>;
  readonly bridgeId?: string;
}

const PHONE_OPERATIONS = new Set([
  "inbox.list", "conversation.read", "comments.list", "comments.replies", "insights.read", "context.refresh",
  "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply",
  "comment.like", "comment.unlike"
]);
const ACTIONS = new Set(["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"]);

/** Standalone phone service: it registers only after device, Appium, WDA and account are proven. */
export function createPhoneCompanion(options: PhoneCompanionOptions): PhoneCompanion {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 30_000) throw new Error("invalid phone poll interval");
  let bridgeId: string | undefined;
  let verifiedAccountHandle: string | undefined;
  let trustedApprovalPublicKey = options.trustedApprovalPublicKey;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let busy = false;
  const inflight = new Set<string>();
  const completedReads = new Map<string, unknown>();
  const attemptedWrites = new Set<string>();
  const submitted = new Set<string>();
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  const handleTask = async (task: BridgeTask): Promise<void> => {
    if (!bridgeId || closed || !validAssignedTask(task, bridgeId, options.accountBinding)) return;
    if (submitted.has(task.id) || inflight.has(task.id)) return;
    if (task.kind === "write" && attemptedWrites.has(task.id)) return;
    if (task.kind !== "write" && completedReads.has(task.id)) {
      await submitOnce(task, completedReads.get(task.id));
      return;
    }
    inflight.add(task.id);
    if (task.kind === "write") attemptedWrites.add(task.id);
    let result: unknown;
    try {
      const expired = !Number.isFinite(Date.parse(task.expiresAt)) || Date.parse(task.expiresAt) <= (options.now ?? Date.now)();
      result = expired ? { status: task.kind === "write" ? "OUTCOME_UNKNOWN" : "FAILED", reason: "phone task expired before execution" }
        : await executeTask(task);
      if (task.kind !== "write") completedReads.set(task.id, result);
    } catch {
      result = task.kind === "write"
        ? { status: "OUTCOME_UNKNOWN", reason: "phone task dispatch outcome is uncertain; no retry was made" }
        : unavailableResult("phone task could not be completed");
      if (task.kind !== "write") completedReads.set(task.id, result);
    } finally { inflight.delete(task.id); }
    await submitOnce(task, result);
  };

  async function executeTask(task: BridgeTask): Promise<unknown> {
    if (task.kind === "read") {
      if (task.operation === "context.refresh") {
        const intent = contextRefreshIntent(task, options.accountBinding);
        if (!intent) return unavailableResult("phone context refresh request is malformed");
        const fresh = await options.provider.refreshContext(intent);
        return { source: "phone", accountBinding: options.accountBinding, target: fresh.target, contextHash: fresh.contextHash, availability: fresh.availability };
      }
      const operation = readOperation(task);
      return operation ? options.provider.observe(operation) : unavailableResult("phone operation is unsupported or malformed");
    }
    if (!ACTIONS.has(task.operation) || !task.contextHash) return { status: "FAILED", reason: "phone write task is missing its approved action context" };
    const intent = mutationIntent(task, options.accountBinding);
    if (!intent) return { status: "FAILED", reason: "phone write payload or target is invalid" };
    const fresh = await options.provider.refreshContext(intent);
    if (fresh.availability !== "ready" || fresh.contextHash !== task.contextHash) return { status: "FAILED", reason: "phone target or source context changed after preview" };
    if (task.kind === "preview") return { status: "PREVIEW", source: "phone", target: safeTarget(task.targetRefs[0]), contextHash: fresh.contextHash };
    if (!task.writeApproval || !trustedApprovalPublicKey || !verifyUiApproval(task, task.writeApproval as SignedUiApproval, trustedApprovalPublicKey,
        { bridgeId: task.bridgeId, source: "phone", now: (options.now ?? Date.now)() })) {
      return { status: "FAILED", reason: "phone write has no valid source-bound signed MutationSafety grant" };
    }
    const outcome: MutationResult = await options.provider.execute(intent, task.requestId!, task.contextHash);
    return validMutationResult(outcome) ? outcome : { status: "OUTCOME_UNKNOWN", reason: "phone executor returned no confirmed outcome" };
  }

  async function submitOnce(task: BridgeTask, result: unknown): Promise<void> {
    if (submitted.has(task.id) || !bridgeId) return;
    submitted.add(task.id);
    try { await options.client.submit(bridgeId, task.id, result, task.contextHash); }
    catch { log(`phone result submit failed (${task.kind}); no automatic retry`); }
  }

  const pump = async () => {
    if (closed || !bridgeId || busy) return;
    busy = true;
    try {
      const readiness = await options.provider.readiness();
      await options.client.heartbeat(bridgeId, { availability: readiness.availability, capabilities: readiness.capabilities,
        ...(verifiedAccountHandle ? { accountBinding: options.accountBinding, accountHandle: verifiedAccountHandle, surface: "instagram" } : {}) });
      const tasks = await options.client.poll(bridgeId, 10);
      for (const task of tasks) await handleTask(task);
    } catch { log("phone bridge poll failed; local task outcome was not inferred"); }
    finally { busy = false; }
  };

  return {
    get bridgeId() { return bridgeId; },
    async start() {
      if (closed) return phoneReadiness("offline", [], "phone companion is closed");
      const transport = await options.appium.readiness();
      if (!transport.transportReady) return transport;
      try { await options.appium.createSession(); }
      catch { return phoneReadiness("not_connected", [], "selected phone session could not be established", true); }
      const ready = await options.appium.readiness();
      if (ready.availability !== "ready" || ready.selectedDeviceIdentity !== "verified") {
        await options.appium.close();
        return phoneReadiness("not_connected", [], ready.reason ?? "selected-device identity was not verified after W3C session creation", ready.transportReady, ready.selectedDeviceIdentity);
      }
      const account = await options.provider.observe({ op: "account.snapshot" });
      if (account.availability !== "ready" || !isExpectedAccount(account.data, options.expectedAccountHandle)) {
        await options.appium.close();
        return phoneReadiness("unsupported", [], "Instagram account identity could not be verified", true, "verified");
      }
      verifiedAccountHandle = options.expectedAccountHandle;
      const capabilities = (await options.provider.readiness()).capabilities;
      try {
        const registration = await options.client.register(capabilities);
        bridgeId = registration.bridgeId;
        trustedApprovalPublicKey ??= registration.approvalPublicKey;
      }
      catch {
        await options.appium.close();
        return phoneReadiness("offline", [], "phone bridge registration failed", true, "verified");
      }
      if (!bridgeId) { await options.appium.close(); return phoneReadiness("offline", [], "phone bridge returned no id", true, "verified"); }
      void pump();
      timer = setInterval(() => { void pump(); }, pollIntervalMs);
      return phoneReadiness("ready", capabilities, undefined, true, "verified");
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await options.appium.close();
    },
    handleTask
  };
}

/** Standalone CLI entry point. The external JSON config contains bridge and one selected-device profile. */
export async function runPhoneCompanionCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configPath = env.INSTAGRAM_MCP_PHONE_CONFIG;
  if (!configPath || !isAbsolute(configPath)) { process.stderr.write("Phone companion configuration is unavailable.\n"); process.exitCode = 1; return; }
  try {
    assertExternalConfigPath(configPath);
    const info = await stat(configPath);
    if (!info.isFile()) throw new Error("phone config must be a private regular file");
    await assertPrivateFile(configPath);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const bridgeConfig = await loadBridgeClientConfig(configPath);
    if (bridgeConfig.mode !== "phone_standalone" || bridgeConfig.source !== "phone") throw new Error("phone bridge mode/source mismatch");
    const appium = parsePhoneAppiumConfig(raw.appium);
    const expectedAccountHandle = raw.expectedAccountHandle;
    if (typeof expectedAccountHandle !== "string" || !/^[a-zA-Z0-9._]{1,30}$/.test(expectedAccountHandle)) throw new Error("configured Instagram handle is invalid");
    const client = createAppiumClient(appium);
    const provider = createPhoneUiProvider({ client, accountBinding: bridgeConfig.accountBinding, expectedAccountHandle, writeEnabled: raw.writeEnabled === true });
    const bridge = new OutboundBridgeClient({ ...bridgeConfig, credentialsPath: configPath });
    const companion = createPhoneCompanion({ appium: client, provider, client: bridge, accountBinding: bridgeConfig.accountBinding, expectedAccountHandle,
      trustedApprovalPublicKey: bridgeConfig.trustedApprovalPublicKey });
    const ready = await companion.start();
    if (ready.availability !== "ready") {
      process.stderr.write(`Phone companion not started (${ready.availability}): ${ready.reason ?? "readiness gate failed"}.\n`);
      process.exitCode = 2;
      return;
    }
    process.once("SIGINT", () => { void companion.close(); });
    process.once("SIGTERM", () => { void companion.close(); });
  } catch {
    process.stderr.write("Phone companion failed to start; check the private local configuration and Appium readiness.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/companion/phone.js")) void runPhoneCompanionCli();

function phoneReadiness(availability: AppiumReadiness["availability"], capabilities: string[], reason?: string,
  transportReady = false, selectedDeviceIdentity: AppiumReadiness["selectedDeviceIdentity"] = "unverified"): AppiumReadiness {
  return { availability, capabilities, transportReady, selectedDeviceIdentity, ...(reason ? { reason } : {}) };
}

function readOperation(task: BridgeTask): PhoneUiOperation | undefined {
  const payload = task.payload;
  const target = task.targetRefs.length === 1 ? parseTarget(task.targetRefs[0]) : undefined;
  const limit = typeof payload.limit === "number" ? payload.limit : 20;
  if (task.operation === "inbox.list" && task.targetRefs.length === 0) return { op: "inbox.list", limit };
  if (task.operation === "conversation.read" && target) return { op: "thread.read", target, limit };
  if (task.operation === "comments.list" && target) return { op: "comments.list", target, limit };
  if (task.operation === "comments.replies" && target) return { op: "comments.replies", target, limit };
  if (task.operation === "insights.read" && task.targetRefs.length <= 1) return { op: "insights.read", ...(target ? { target } : {}), ...(typeof payload.period === "string" ? { period: payload.period } : {}) };
  return undefined;
}

function mutationIntent(task: BridgeTask, accountBinding: string): MutationIntent | undefined {
  const target = task.targetRefs.length === 1 ? parseTarget(task.targetRefs[0]) : undefined;
  if (!target || target.accountBinding !== accountBinding || !ACTIONS.has(task.operation)) return undefined;
  const action = task.operation as MutationIntent["action"];
  const payload = task.payload;
  if (["message.send", "comment.reply", "comment.private_reply"].includes(action)) {
    if (typeof payload.text !== "string" || payload.text.length > 4_000) return undefined;
    return { source: "phone", accountBinding, action, target, payload: { kind: action as "message.send" | "comment.reply" | "comment.private_reply", text: payload.text }, contextHash: task.contextHash ?? "" };
  }
  if (["message.react", "message.unreact"].includes(action)) {
    if (typeof payload.reaction !== "string" || payload.reaction.length > 32) return undefined;
    return { source: "phone", accountBinding, action, target, payload: { kind: action as "message.react" | "message.unreact", reaction: payload.reaction }, contextHash: task.contextHash ?? "" };
  }
  return { source: "phone", accountBinding, action, target, payload: { kind: action as "comment.like" | "comment.unlike" }, contextHash: task.contextHash ?? "" };
}

function validAssignedTask(task: BridgeTask, bridgeId: string, accountBinding: string): boolean {
  if (!task || typeof task.id !== "string" || task.id.length > 128 || task.source !== "phone" || task.bridgeId !== bridgeId || task.accountBinding !== accountBinding || !PHONE_OPERATIONS.has(task.operation) || !["read", "preview", "write"].includes(task.kind) || !Array.isArray(task.targetRefs) || !isRecord(task.payload)) return false;
  if (task.kind === "read") {
    if (ACTIONS.has(task.operation)) return false;
    if (task.operation === "context.refresh") return task.targetRefs.length === 1 && exactKeys(task.payload, ["action"]) &&
      ["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"].includes(String(task.payload.action));
    if (task.operation === "inbox.list") return task.targetRefs.length === 0 && exactKeys(task.payload, ["limit"]);
    if (task.operation === "insights.read") return task.targetRefs.length <= 1 && exactKeys(task.payload, ["period"]);
    return task.targetRefs.length === 1 && exactKeys(task.payload, ["limit"]);
  }
  if (!ACTIONS.has(task.operation) || task.targetRefs.length !== 1 || typeof task.contextHash !== "string") return false;
  const fields = ["message.send", "comment.reply", "comment.private_reply"].includes(task.operation) ? ["text"]
    : ["message.react", "message.unreact"].includes(task.operation) ? ["reaction"] : [];
  return exactKeys(task.payload, fields);
}

function contextRefreshIntent(task: BridgeTask, accountBinding: string): MutationIntent | undefined {
  const target = task.targetRefs.length === 1 ? parseTarget(task.targetRefs[0]) : undefined;
  const action = task.payload.action;
  if (!target || target.accountBinding !== accountBinding || typeof action !== "string" || !PHONE_OPERATIONS.has(action) ||
      !["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"].includes(action)) return undefined;
  const payload: MutationIntent["payload"] = ["message.send", "comment.reply", "comment.private_reply"].includes(action)
    ? { kind: action as "message.send" | "comment.reply" | "comment.private_reply", text: "context-refresh" }
    : ["message.react", "message.unreact"].includes(action)
      ? { kind: action as "message.react" | "message.unreact", reaction: "context-refresh" }
      : { kind: action as "comment.like" | "comment.unlike" };
  return { source: "phone", accountBinding, action: action as MutationIntent["action"], target, payload, contextHash: "context-refresh" };
}

function parseTarget(value: Record<string, string> | undefined): TargetRef | undefined {
  if (!value || !Object.keys(value).length || Object.keys(value).some((key) => !["accountBinding", "nativeId", "instagramUrl", "explicitOwnerRef"].includes(key))) return undefined;
  if (typeof value.accountBinding !== "string" || !value.accountBinding || Object.values(value).some((item) => typeof item !== "string" || item.length > 512)) return undefined;
  return {
    accountBinding: value.accountBinding,
    ...(value.nativeId ? { nativeId: value.nativeId } : {}),
    ...(value.instagramUrl ? { instagramUrl: value.instagramUrl } : {}),
    ...(value.explicitOwnerRef ? { explicitOwnerRef: value.explicitOwnerRef } : {})
  };
}
function safeTarget(value: Record<string, string> | undefined): TargetRef | undefined { return value ? parseTarget(value) : undefined; }
function validMutationResult(value: unknown): value is MutationResult { return isRecord(value) && ["ACK", "OBSERVED", "OUTCOME_UNKNOWN", "FAILED"].includes(String(value.status)); }
function unavailableResult(message: string): unknown { return { source: "phone", availability: "unsupported", coverage: "unknown", historyCompleteness: "unknown", errors: [{ code: "unsupported", message }] }; }
function isExpectedAccount(value: unknown, expected: string): boolean { return isRecord(value) && typeof value.username === "string" && value.username.toLowerCase() === expected.toLowerCase(); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function parsePhoneAppiumConfig(value: unknown): AppiumDeviceConfig {
  if (!isRecord(value) || typeof value.serverUrl !== "string" || !["iOS", "Android"].includes(String(value.platform))) throw new Error("phone Appium profile is incomplete");
  const selectedDevice = isRecord(value.selectedDevice) && typeof value.selectedDevice.id === "string"
    ? { id: value.selectedDevice.id, ...(typeof value.selectedDevice.name === "string" ? { name: value.selectedDevice.name } : {}) } : undefined;
  return {
    serverUrl: value.serverUrl,
    platform: value.platform as AppiumDeviceConfig["platform"],
    ...(selectedDevice ? { selectedDevice } : {}),
    ...(typeof value.wdaStatusUrl === "string" ? { wdaStatusUrl: value.wdaStatusUrl } : {}),
    ...(typeof value.deviceStatusUrl === "string" ? { deviceStatusUrl: value.deviceStatusUrl } : {}),
    ...(typeof value.requestTimeoutMs === "number" ? { requestTimeoutMs: value.requestTimeoutMs } : {})
  };
}
function assertExternalConfigPath(path: string): void {
  const target = resolve(path);
  assertOutsideDirectory(resolve(process.cwd()), target, "phone config must be outside the project directory");
  if (!isAbsolute(path)) throw new Error("phone config path must be absolute");
}
