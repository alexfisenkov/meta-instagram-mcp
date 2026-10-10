import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { verifyUiApproval, type SignedUiApproval } from "./ui-approval.js";
import type { Availability } from "./domain-types.js";
import { assertOutsideDirectory, assertPrivateFile, ensurePrivateDirectory, ensurePrivateFile } from "./private-fs.js";

export type BridgeMode = "browser_native_host" | "phone_standalone";
export type BridgeSource = "browser" | "phone";
export type BridgeTaskKind = "read" | "preview" | "write";
export type BridgeOperation =
  | "account.inspect" | "account.snapshot" | "inbox.list" | "conversation.read" | "comments.list" | "comments.replies" | "insights.read"
  | "context.refresh"
  | "message.send" | "message.react" | "message.unreact" | "comment.reply"
  | "comment.private_reply" | "comment.hide" | "comment.show" | "comment.delete"
  | "comment.like" | "comment.unlike";

export interface BridgeTask {
  id: string;
  kind: BridgeTaskKind;
  source: BridgeSource;
  bridgeId: string;
  operation: BridgeOperation;
  accountBinding: string;
  targetRefs: Array<Record<string, string>>;
  payload: Readonly<Record<string, unknown>>;
  expiresAt: string;
  contextHash?: string;
  requestId?: string;
  fingerprint?: string;
  writeApproval?: SignedUiApproval;
}

interface CompanionHubOptions {
  storagePath: string;
  leaseMs?: number;
  taskTtlMs?: number;
  bridgeTtlMs?: number;
  maxTasks?: number;
  maxPayloadBytes?: number;
  maxResultBytes?: number;
  lockTimeoutMs?: number;
  approvalPublicKey?: string;
  now?: () => number;
}
interface RegisterInput {
  mode: BridgeMode; source?: BridgeSource; accountBinding: string; capabilities: string[];
}
interface EnqueueInput {
  kind: BridgeTaskKind; source: BridgeSource; accountBinding: string; operation: BridgeOperation;
  bridgeId?: string;
  payload: Readonly<Record<string, unknown>>; targetRefs: Array<Record<string, string>>;
  contextHash?: string; ttlMs?: number;
  requestId?: string; fingerprint?: string;
}
interface BridgeRecord {
  id: string; mode: BridgeMode; source: BridgeSource; accountBinding: string;
  capabilities: string[]; tokenHash: string; lastSeenAt: string;
  liveStatus?: { availability: "ready" | "offline" | "not_connected" | "unsupported" | "unsupported_ui_version" | "needs_selection" | "missing_scope" | "permission_blocked"; capabilities: string[]; accountHandle?: string; surface?: "instagram" };
}
interface StoredTask extends BridgeTask {
  status: "queued" | "leased" | "complete" | "outcome_unknown" | "expired";
  leaseUntil?: number; result?: unknown; resultHash?: string;
}
interface HubState {
  version: 1; bridges: BridgeRecord[]; tasks: StoredTask[];
  audit: Array<{ at: string; event: string; bridgeId?: string; taskId?: string; status?: string }>;
}

const READS = new Set<BridgeOperation>(["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies", "insights.read", "context.refresh"]);
const WRITES = new Set<BridgeOperation>([
  "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply",
  "comment.hide", "comment.show", "comment.delete", "comment.like", "comment.unlike"
]);
const EMPTY: HubState = { version: 1, bridges: [], tasks: [], audit: [] };
const SENSITIVE_RESULT_KEYWORDS = new Set([
  "token", "secret", "authorization", "cookie", "cookies", "password", "passwd", "passphrase", "pwd",
  "credential", "credentials", "session", "storage", "localstorage", "sessionstorage", "udid", "imei", "sim"
]);
const bytes = (value: unknown) => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("value is not JSON serializable");
  return Buffer.byteLength(json, "utf8");
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class HubLockError extends Error {
  constructor(message: string, readonly lockPath: string) { super(message); this.name = "HubLockError"; }
}
interface HubLockOwner { version: 1; token: string; pid: number; acquiredAt: string }

export class CompanionHub {
  private readonly options: Required<Omit<CompanionHubOptions, "now" | "approvalPublicKey">> & Pick<CompanionHubOptions, "now" | "approvalPublicKey">;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CompanionHubOptions) {
    if (!isAbsolute(options.storagePath)) throw new Error("hub storage path must be absolute");
    assertOutsideDirectory(resolve(process.cwd()), resolve(options.storagePath), "hub storage must be outside the project directory");
    this.options = {
      ...options,
      leaseMs: options.leaseMs ?? 30_000,
      taskTtlMs: options.taskTtlMs ?? 5 * 60_000,
      bridgeTtlMs: options.bridgeTtlMs ?? 90_000,
      maxTasks: options.maxTasks ?? 1_000,
      maxPayloadBytes: options.maxPayloadBytes ?? 16_384,
      maxResultBytes: options.maxResultBytes ?? 65_536,
      lockTimeoutMs: options.lockTimeoutMs ?? 5_000
    };
  }

  /** Installs the runtime-owned verifier pin before companions are allowed to register. */
  setApprovalPublicKey(publicKey: string): void {
    if (typeof publicKey !== "string" || !publicKey.includes("BEGIN PUBLIC KEY") || publicKey.length > 2_000) throw new Error("invalid approval public key");
    if (this.options.approvalPublicKey && this.options.approvalPublicKey !== publicKey) throw new Error("approval public key is already pinned");
    this.options.approvalPublicKey = publicKey;
  }

  async register(input: RegisterInput): Promise<{ bridgeId: string; bridgeToken: string; approvalPublicKey?: string }> {
    if (!input || !["browser_native_host", "phone_standalone"].includes(input.mode)) throw new Error("invalid bridge mode");
    const source = input.source ?? (input.mode === "browser_native_host" ? "browser" : "phone");
    if ((input.mode === "browser_native_host" && source !== "browser") || (input.mode === "phone_standalone" && source !== "phone")) throw new Error("bridge mode/source mismatch");
    if (!validBinding(input.accountBinding) || !Array.isArray(input.capabilities) || input.capabilities.length > 64 || input.capabilities.some((v) => typeof v !== "string" || !isOperation(v))) throw new Error("invalid bridge registration");
    const bridgeId = randomUUID();
      const bridgeToken = randomBytes(32).toString("base64url");
      await this.change((state) => {
      if (state.bridges.length >= 128) throw new Error("bridge registry is full");
      state.bridges.push({ id: bridgeId, mode: input.mode, source, accountBinding: input.accountBinding, capabilities: [...new Set(input.capabilities)], tokenHash: hash(bridgeToken), lastSeenAt: this.isoNow() });
      this.audit(state, "bridge.registered", bridgeId);
    });
    return { bridgeId, bridgeToken, ...(this.options.approvalPublicKey ? { approvalPublicKey: this.options.approvalPublicKey } : {}) };
  }

  async heartbeat(input: { bridgeId: string; bridgeToken: string; source?: BridgeSource; status?: unknown }): Promise<void> {
    await this.change((state) => {
      const bridge = this.authBridge(state, input.bridgeId, input.bridgeToken, input.source);
      bridge.lastSeenAt = this.isoNow();
      bridge.liveStatus = safeLiveStatus(input.status, bridge.capabilities, bridge.accountBinding);
      this.audit(state, "bridge.heartbeat", bridge.id);
    });
  }

  async enqueue(input: EnqueueInput): Promise<BridgeTask> {
    if (input?.kind === "write") throw new Error("UI writes require the internal signed-approval enqueue path.");
    return this.enqueueInternal(input);
  }

  async enqueueApprovedWrite(input: EnqueueInput, signApproval: (task: BridgeTask) => SignedUiApproval): Promise<BridgeTask> {
    if (input?.kind !== "write" || !this.options.approvalPublicKey) throw new Error("UI write approvals are not configured.");
    return this.enqueueInternal(input, signApproval);
  }

  async sourceStatus(source: BridgeSource, accountBinding?: string, selectedBridgeId?: string): Promise<{ source: BridgeSource; availability: Availability; capabilities: string[]; accountBinding?: string; accountHandle?: string; surface?: "instagram"; bridgeId?: string; reason?: string }> {
    return this.read((state) => {
      const now = this.now();
      const candidates = state.bridges.filter((bridge) => bridge.source === source && (!selectedBridgeId || bridge.id === selectedBridgeId) &&
        (!accountBinding || bridge.accountBinding === accountBinding) && now - Date.parse(bridge.lastSeenAt) <= this.options.bridgeTtlMs);
      if (!candidates.length) return { source, availability: "not_connected", capabilities: [], ...(accountBinding ? { accountBinding } : {}),
        reason: selectedBridgeId ? "The selected companion is no longer registered or live." : "No live companion is registered for this source." };
      const bindings = [...new Set(candidates.map((bridge) => bridge.accountBinding))];
      if (!accountBinding && bindings.length > 1) return { source, availability: "needs_selection", capabilities: [], reason: "More than one account is connected for this source." };
      const bridge = candidates.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]!;
      const liveStatus = bridge.liveStatus;
      return { source, availability: liveStatus?.availability ?? "offline", capabilities: liveStatus?.capabilities ?? [], accountBinding: bridge.accountBinding, bridgeId: bridge.id,
        ...(liveStatus?.accountHandle ? { accountHandle: liveStatus.accountHandle } : {}), ...(liveStatus?.surface ? { surface: liveStatus.surface } : {}),
        ...(!liveStatus ? { reason: "The companion has not reported verified runtime readiness." } : {}) };
    });
  }

  private async enqueueInternal(input: EnqueueInput, signApproval?: (task: BridgeTask) => SignedUiApproval): Promise<BridgeTask> {
    validateTaskInput(input, this.options.maxPayloadBytes);
    const task = await this.change((state) => {
      const bridge = state.bridges.find((candidate) => candidate.source === input.source && candidate.accountBinding === input.accountBinding && (!input.bridgeId || candidate.id === input.bridgeId) && candidate.capabilities.includes(input.operation) && this.now() - Date.parse(candidate.lastSeenAt) <= this.options.bridgeTtlMs);
      if (!bridge) throw new Error("no assigned bridge available");
      this.prune(state);
      if (state.tasks.length >= this.options.maxTasks) throw new Error("hub queue is full");
      const now = this.now();
      const maxTtlMs = input.kind === "write"
        ? Math.min(input.ttlMs ?? 30_000, 30_000, this.options.taskTtlMs)
        : Math.min(input.ttlMs ?? this.options.taskTtlMs, this.options.taskTtlMs);
      const task: StoredTask = {
        id: randomUUID(), kind: input.kind, source: input.source, bridgeId: bridge.id,
        operation: input.operation, accountBinding: input.accountBinding,
        targetRefs: normalizeTargets(input.targetRefs), payload: structuredClone(input.payload),
        expiresAt: new Date(now + maxTtlMs).toISOString(),
        ...(input.contextHash ? { contextHash: input.contextHash } : {}),
        ...(input.kind === "write" ? { requestId: input.requestId, fingerprint: input.fingerprint } : {}), status: "queued"
      };
      if (input.kind === "write") {
        if (!signApproval) throw new Error("UI writes require an approved safety attempt.");
        const approval = signApproval(task);
        if (!this.options.approvalPublicKey || !verifyUiApproval(task, approval, this.options.approvalPublicKey, { bridgeId: task.bridgeId, source: task.source, now })) {
          throw new Error("UI write approval did not match the selected bridge task.");
        }
        task.writeApproval = structuredClone(approval);
      }
      state.tasks.push(task);
      this.audit(state, "task.queued", bridge.id, task.id);
      return publicTask(task);
    });
    return task;
  }

  async poll(bridgeId: string, maxTasks: number, bridgeToken?: string, source?: BridgeSource): Promise<BridgeTask[]> {
    return this.change((state) => {
      const bridge = this.authBridge(state, bridgeId, bridgeToken, source);
      if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 20) throw new Error("invalid poll limit");
      const now = this.now();
      const picked: BridgeTask[] = [];
      for (const task of state.tasks) {
        if (task.bridgeId !== bridge.id || task.status === "complete" || task.status === "expired" || task.status === "outcome_unknown") continue;
        if (Date.parse(task.expiresAt) <= now) { task.status = task.kind === "write" ? "outcome_unknown" : "expired"; this.audit(state, task.status === "expired" ? "task.expired" : "task.outcome_unknown", bridge.id, task.id, task.status); continue; }
        if (task.status === "leased") {
          if (task.kind === "read" && (task.leaseUntil ?? 0) <= now) { task.leaseUntil = now + this.options.leaseMs; picked.push(publicTask(task)); }
          else if (task.kind === "write" && (task.leaseUntil ?? 0) <= now) { task.status = "outcome_unknown"; this.audit(state, "task.outcome_unknown", bridge.id, task.id, task.status); }
          else if (task.kind === "read") picked.push(publicTask(task));
          if (picked.length >= maxTasks) break;
          continue;
        }
        if (task.status === "queued") {
          task.status = "leased"; task.leaseUntil = now + this.options.leaseMs;
          picked.push(publicTask(task));
          if (task.kind === "write") task.status = "leased";
          if (picked.length >= maxTasks) break;
        }
      }
      this.audit(state, "bridge.poll", bridge.id);
      return picked;
    });
  }

  async submit(bridgeId: string, taskId: string, result: unknown, contextHash?: string, bridgeToken?: string, source?: BridgeSource): Promise<void> {
    if (bytes(result) > this.options.maxResultBytes) throw new Error("result exceeds size limit");
    assertSafeResult(result);
    const failure = await this.change((state) => {
      const bridge = this.authBridge(state, bridgeId, bridgeToken, source);
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.bridgeId !== bridge.id || task.source !== bridge.source || task.accountBinding !== bridge.accountBinding) return "task assignment mismatch";
      if (Date.parse(task.expiresAt) <= this.now() || task.status === "expired") {
        task.status = task.kind === "write" && task.status === "leased" ? "outcome_unknown" : "expired";
        this.audit(state, task.status === "expired" ? "task.expired" : "task.outcome_unknown", bridge.id, task.id, task.status);
        return "task expired";
      }
      if (task.status === "complete" || task.status === "outcome_unknown") return "task is no longer accepting results";
      if (task.status !== "leased") return "task has not been leased";
      if ((task.contextHash ?? "") !== (contextHash ?? "")) {
        if (task.kind === "write") task.status = "outcome_unknown";
        this.audit(state, "task.context_mismatch", bridge.id, task.id, task.status);
        return "task context mismatch";
      }
      task.resultHash = hash(JSON.stringify(result));
      task.result = structuredClone(result);
      task.status = "complete";
      delete task.leaseUntil;
      this.audit(state, "task.completed", bridge.id, task.id, "complete");
      return null;
    });
    if (failure) throw new Error(failure);
  }

  async result(taskId: string): Promise<{ status: string; result?: unknown }> {
    return this.read((state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task) return { status: "unknown" };
      if (Date.parse(task.expiresAt) <= this.now() && task.status !== "complete") return { status: task.kind === "write" && task.status === "leased" ? "outcome_unknown" : "expired" };
      return { status: task.status, ...(task.status === "complete" ? { result: structuredClone(task.result) } : {}) };
    });
  }

  /** Cancels only a queued/leased read; write attempts and completed tasks are never changed. */
  async cancelReadTask(taskId: string): Promise<boolean> {
    return this.change((state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.kind !== "read" || !["queued", "leased"].includes(task.status)) return false;
      task.status = "expired";
      delete task.leaseUntil;
      this.audit(state, "task.read_cancelled", task.bridgeId, task.id, "expired");
      return true;
    });
  }

  private async read<T>(fn: (state: HubState) => T): Promise<T> {
    return this.serial(() => this.withFileLock(async () => fn(await this.load())));
  }
  private async change<T>(fn: (state: HubState) => T): Promise<T> {
    return this.serial(() => this.withFileLock(async () => { const state = await this.load(); const result = fn(state); await this.save(state); return result; }));
  }
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireFileLock();
    try { return await fn(); } finally { await release(); }
  }
  private async acquireFileLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.options.storagePath}.lock`;
    await ensurePrivateDirectory(dirname(this.options.storagePath));
    const owner: HubLockOwner = { version: 1, token: randomBytes(32).toString("base64url"), pid: process.pid, acquiredAt: this.isoNow() };
    const temporaryPath = `${lockPath}.${owner.token}.pending`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await ensurePrivateFile(temporaryPath);
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    } finally { await handle.close().catch(() => undefined); }
    const deadline = Date.now() + this.options.lockTimeoutMs;
    let acquired = false;
    try {
      while (!acquired) {
        try {
          await link(temporaryPath, lockPath);
          acquired = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await readLockOwner(lockPath);
          if (existing === null) continue;
          if (Date.now() >= deadline) {
            throw new HubLockError(`CompanionHub ledger lock is held or stale; inspect ${lockPath} and recover it manually only after confirming its owner stopped.`, lockPath);
          }
          await sleep(10 + Math.floor(Math.random() * 20));
        }
      }
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => { if (cleanupError.code !== "ENOENT") throw cleanupError; });
      throw error;
    }
    await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => { if (cleanupError.code !== "ENOENT") throw cleanupError; });
    let released = false;
    return async () => {
      if (released) return;
      const current = await readLockOwner(lockPath);
      if (!current || current.token !== owner.token || current.pid !== owner.pid) {
        throw new HubLockError(`CompanionHub ledger lock ownership changed; refusing to remove ${lockPath}.`, lockPath);
      }
      await unlink(lockPath);
      released = true;
    };
  }
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prior = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
  }
  private async load(): Promise<HubState> {
    try {
      await assertPrivateFile(this.options.storagePath);
      const state = JSON.parse(await readFile(this.options.storagePath, "utf8")) as HubState;
      if (state.version !== 1 || !Array.isArray(state.bridges) || !Array.isArray(state.tasks) || !Array.isArray(state.audit)) throw new Error("invalid hub state");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }
  private async save(state: HubState): Promise<void> {
    await ensurePrivateDirectory(dirname(this.options.storagePath));
    state.audit = state.audit.slice(-2_000);
    const temp = `${this.options.storagePath}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await ensurePrivateFile(temp);
      await handle.writeFile(JSON.stringify(state), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    } finally { await handle.close().catch(() => undefined); }
    await rename(temp, this.options.storagePath);
    await ensurePrivateFile(this.options.storagePath);
  }
  private authBridge(state: HubState, bridgeId: string, token?: string, source?: BridgeSource): BridgeRecord {
    const bridge = state.bridges.find((candidate) => candidate.id === bridgeId);
    if (!bridge || (source !== undefined && source !== bridge.source) || !token || !constantTimeHashMatch(bridge.tokenHash, hash(token))) throw new Error("bridge authentication failed");
    return bridge;
  }
  private prune(state: HubState): void {
    const cutoff = this.now() - 24 * 60 * 60_000;
    for (const task of state.tasks) {
      if (Date.parse(task.expiresAt) <= this.now() && ["queued", "leased"].includes(task.status)) {
        task.status = task.kind === "write" && task.status === "leased" ? "outcome_unknown" : "expired";
        this.audit(state, task.status === "expired" ? "task.expired" : "task.outcome_unknown", task.bridgeId, task.id, task.status);
      }
    }
    state.tasks = state.tasks.filter((task) => Date.parse(task.expiresAt) > cutoff);
  }
  private audit(state: HubState, event: string, bridgeId?: string, taskId?: string, status?: string): void {
    state.audit.push({ at: this.isoNow(), event, ...(bridgeId ? { bridgeId } : {}), ...(taskId ? { taskId } : {}), ...(status ? { status } : {}) });
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
}

async function readLockOwner(lockPath: string): Promise<HubLockOwner | null> {
  let info;
  try { info = await lstat(lockPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new HubLockError(`CompanionHub ledger lock is ambiguous or has unsafe permissions; inspect ${lockPath} before manual recovery.`, lockPath);
  }
  let privateLockVerified = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await assertPrivateFile(lockPath);
      privateLockVerified = true;
      break;
    } catch {
      // The owner can release (and another contender can recreate) the path
      // while the Windows ACL check runs out of process. Retry only when the
      // lock still exists; a missing path is safe to retry in the caller, and
      // any persistent ACL/file-type failure remains fail-closed.
      try { await lstat(lockPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new HubLockError(`CompanionHub ledger lock is ambiguous or has unsafe permissions; inspect ${lockPath} before manual recovery.`, lockPath);
      }
    }
  }
  if (!privateLockVerified) throw new HubLockError(`CompanionHub ledger lock is ambiguous or has unsafe permissions; inspect ${lockPath} before manual recovery.`, lockPath);
  let contents: string;
  try { contents = await readFile(lockPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HubLockError(`CompanionHub ledger lock owner cannot be read; inspect ${lockPath} before manual recovery.`, lockPath);
  }
  try {
    const owner = JSON.parse(contents) as HubLockOwner;
    if (owner.version !== 1 || typeof owner.token !== "string" || !/^[a-zA-Z0-9_-]{40,48}$/.test(owner.token) || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))) throw new Error("invalid owner");
    return owner;
  } catch {
    throw new HubLockError(`CompanionHub ledger lock owner data is corrupt; inspect ${lockPath} before manual recovery.`, lockPath);
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function constantTimeHashMatch(left: string, right: string): boolean { return constantTimeEqual(left, right); }
function validBinding(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value); }
function isOperation(value: string): value is BridgeOperation { return READS.has(value as BridgeOperation) || WRITES.has(value as BridgeOperation); }
function validateTaskInput(input: EnqueueInput, maxPayloadBytes: number): void {
  if (!input || !["read", "preview", "write"].includes(input.kind) || !["browser", "phone"].includes(input.source) || !validBinding(input.accountBinding) || !isOperation(input.operation)) throw new Error("invalid task");
  if ((input.kind === "read") !== READS.has(input.operation)) throw new Error("task kind/operation mismatch");
  if (input.kind !== "read" && !WRITES.has(input.operation)) throw new Error("mutation operation required");
  if (input.kind === "write" && (!/^[\w-]{16,128}$/.test(input.requestId ?? "") || !/^[a-f0-9]{64}$/i.test(input.fingerprint ?? ""))) throw new Error("write task requires its common safety request id and fingerprint");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload) || bytes(input.payload) > maxPayloadBytes) throw new Error("invalid task payload");
  validatePayload(input.operation, input.payload);
  if (!Array.isArray(input.targetRefs) || input.targetRefs.length > 10) throw new Error("invalid target refs");
  const needsTarget = ["conversation.read", "comments.list", "comments.replies", "context.refresh", "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.hide", "comment.show", "comment.delete", "comment.like", "comment.unlike"].includes(input.operation);
  if (needsTarget && input.targetRefs.length === 0) throw new Error("task target is required");
  for (const target of input.targetRefs) {
    if (target.accountBinding !== input.accountBinding || Object.keys(target).every((key) => key === "accountBinding")) throw new Error("task target binding mismatch");
  }
  if (input.kind !== "read" && !input.contextHash) throw new Error("mutation tasks require a context hash");
  if (input.contextHash !== undefined && !/^[a-f0-9]{16,128}$/i.test(input.contextHash)) throw new Error("invalid context hash");
  if (input.ttlMs !== undefined && (!Number.isInteger(input.ttlMs) || input.ttlMs < 1)) throw new Error("invalid task TTL");
}
function normalizeTargets(targets: Array<Record<string, string>>): Array<Record<string, string>> {
  return targets.map((target) => {
    if (!target || typeof target !== "object" || Object.keys(target).some((key) => !["accountBinding", "nativeId", "instagramUrl", "explicitOwnerRef"].includes(key))) throw new Error("invalid target reference");
    const clean = Object.fromEntries(Object.entries(target).filter(([, value]) => typeof value === "string" && value.length > 0 && value.length <= 512));
    if (Object.keys(clean).length !== Object.keys(target).length) throw new Error("invalid target reference");
    if (clean.instagramUrl) {
      let url: URL;
      try { url = new URL(clean.instagramUrl); } catch { throw new Error("invalid target URL"); }
      if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname) || url.username || url.password) throw new Error("invalid target URL");
    }
    return clean;
  });
}
function validatePayload(operation: BridgeOperation, payload: Readonly<Record<string, unknown>>): void {
  const keys: Record<BridgeOperation, string[]> = {
    "account.inspect": [], "account.snapshot": [],
    "inbox.list": ["limit", "cursor"], "conversation.read": ["pages", "limit"],
    "comments.list": ["cursor", "limit"], "comments.replies": ["cursor", "limit"], "insights.read": ["period"], "context.refresh": ["action"],
    "message.send": ["text"], "message.react": ["reaction"], "message.unreact": ["reaction"],
    "comment.reply": ["text"], "comment.private_reply": ["text"], "comment.hide": [], "comment.show": [],
    "comment.delete": [], "comment.like": [], "comment.unlike": []
  };
  if (Object.keys(payload).some((key) => !keys[operation].includes(key))) throw new Error("unexpected task payload field");
  for (const [key, value] of Object.entries(payload)) {
    if (key === "limit" && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100)) throw new Error("invalid task limit");
    if (key === "pages" && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5)) throw new Error("invalid older-history page budget");
    if (["cursor", "olderCursor", "period"].includes(key) && (typeof value !== "string" || value.length > 256)) throw new Error("invalid task parameter");
    if (key === "text" && (typeof value !== "string" || value.length < 1 || value.length > 2_200)) throw new Error("invalid task text");
    if (key === "reaction" && (typeof value !== "string" || value.length < 1 || value.length > 16)) throw new Error("invalid task reaction");
    if (key === "action" && (typeof value !== "string" || !["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.hide", "comment.show", "comment.delete", "comment.like", "comment.unlike"].includes(value))) throw new Error("invalid context refresh action");
  }
  if (["message.send", "comment.reply", "comment.private_reply"].includes(operation) && typeof payload.text !== "string") throw new Error("task text is required");
  if (["message.react", "message.unreact"].includes(operation) && typeof payload.reaction !== "string") throw new Error("task reaction is required");
}
function assertSafeResult(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error("result nesting limit exceeded");
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("result item limit exceeded");
    for (const item of value) assertSafeResult(item, depth + 1);
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 1_000) throw new Error("result field limit exceeded");
    for (const [key, child] of entries) {
      if (isSensitiveResultKey(key)) throw new Error("sensitive result field rejected");
      assertSafeResult(child, depth + 1);
    }
  }
}
function isSensitiveResultKey(key: string): boolean {
  const words = key.normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_RESULT_KEYWORDS.has(word))) return true;
  return words.some((word, index) => word === "api" && words[index + 1] === "key"
    || word === "private" && words[index + 1] === "key"
    || word === "session" && words[index + 1] === "key"
    || word === "device" && ["id", "identifier"].includes(words[index + 1] ?? ""));
}
function publicTask(task: StoredTask): BridgeTask {
  const { status: _status, leaseUntil: _leaseUntil, result: _result, resultHash: _resultHash, ...publicValue } = task;
  return structuredClone(publicValue);
}
function safeLiveStatus(value: unknown, allowedCapabilities: readonly string[], accountBinding: string): BridgeRecord["liveStatus"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { availability: "offline", capabilities: [] };
  const record = value as Record<string, unknown>;
  const availability = record.availability;
  const allowedAvailability = ["ready", "offline", "not_connected", "unsupported", "unsupported_ui_version", "needs_selection", "missing_scope", "permission_blocked"] as const;
  if (!allowedAvailability.includes(availability as typeof allowedAvailability[number])) return { availability: "offline", capabilities: [] };
  const accountHandle = typeof record.accountHandle === "string" && /^[a-zA-Z0-9._]{1,30}$/.test(record.accountHandle) ? record.accountHandle : undefined;
  if (availability === "ready" && (record.accountBinding !== accountBinding || record.surface !== "instagram" || !accountHandle)) {
    return { availability: "offline", capabilities: [] };
  }
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((item): item is string => typeof item === "string" && allowedCapabilities.includes(item)).slice(0, 64)
    : [];
  return { availability: availability as Availability, capabilities: [...new Set(capabilities)],
    ...(availability === "ready" ? { accountHandle, surface: "instagram" as const } : {}) };
}
