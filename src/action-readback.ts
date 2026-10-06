import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { MutationAction, MutationSource, Observation, TargetRef } from "./domain-types.js";

export type ActionReadbackStatus = "pending" | "unknown" | "observed" | "failed";
export interface ActionReadbackRecord {
  version: 1;
  requestId: string;
  fingerprint: string;
  source: MutationSource;
  bridgeId?: string;
  accountBinding: string;
  action: MutationAction;
  target: TargetRef;
  payloadHash?: string;
  attemptedAt: string;
  status: ActionReadbackStatus;
  dispatchStatus?: "ACK" | "OUTCOME_UNKNOWN" | "FAILED";
  receiptId?: string;
  responseState?: "answered" | "unknown";
  observedAt?: string;
  reason?: string;
}
export interface ActionReadbackEvidence { observation: Observation<unknown>; ownerSenderIds?: string[] }
export type ActionReadbackOutcome =
  | { status: "OBSERVED"; receiptId?: string; responseState?: "answered" | "unknown"; observedAt?: string; dispatchStatus?: "ACK" | "OUTCOME_UNKNOWN" }
  | { status: "OUTCOME_UNKNOWN"; reason: string; responseState?: "unknown"; dispatchStatus?: "ACK" | "OUTCOME_UNKNOWN" };
export interface ActionReadbackPort {
  readback(record: ActionReadbackRecord): Promise<ActionReadbackEvidence>;
}
export interface ActionReadbackStore {
  get(requestId: string): Promise<ActionReadbackRecord | undefined>;
  latestFor(source: MutationSource, target: TargetRef): Promise<ActionReadbackRecord | undefined>;
  put(record: ActionReadbackRecord): Promise<void>;
}

/** Read-only proof classifier. Positive evidence is source/target/account bound and never inferred from a write ACK. */
export function verifyActionReadback(record: ActionReadbackRecord, evidence: ActionReadbackEvidence): ActionReadbackOutcome {
  const observation = evidence.observation;
  if (!isTextReply(record.action) || !record.payloadHash || observation.source !== record.source ||
      observation.accountBinding !== record.accountBinding || observation.availability !== "ready" ||
      (observation.coverage === "unknown" && !(record.source === "browser" && record.receiptId)) || observation.errors.length || !isRecord(observation.data) ||
      !observationMatchesTarget(record, observation)) return unknown();
  if (record.action === "message.send") {
    const data = observation.data;
    const rows = Array.isArray(data.messages) ? data.messages.filter(isRecord) : [];
    const candidates = rows.filter((row) => isOwnTextReply(row, record, evidence.ownerSenderIds));
    const match = selectExactCandidate(candidates, record);
    if (!match) return unknown();
    const timestamp = messageTimestamp(match);
    return { status: "OBSERVED", ...(messageId(match) ? { receiptId: messageId(match) } : {}),
      responseState: currentDirectResponse(data, rows, match) ? "answered" : "unknown", ...(timestamp ? { observedAt: timestamp } : {}) };
  }
  if (record.action === "comment.reply") {
    if (observation.source !== "api") return unknown();
    const data = observation.data;
    const rows = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
    const candidates = rows.filter((row) => isOwnApiCommentReply(row, record, evidence.ownerSenderIds));
    const match = selectExactCandidate(candidates, record);
    if (!match) return unknown();
    const timestamp = messageTimestamp(match);
    return { status: "OBSERVED", ...(messageId(match) ? { receiptId: messageId(match) } : {}),
      responseState: "unknown",
      ...(timestamp ? { observedAt: timestamp } : {}) };
  }
  return unknown();
}

export function readbackRequest(record: ActionReadbackRecord):
  | { operation: "conversation.read"; target: TargetRef; limit: number }
  | { operation: "comments.replies"; target: TargetRef; limit: number }
  | undefined {
  if (!record.target.nativeId || record.source === "phone") return undefined;
  if (record.action === "message.send") return { operation: "conversation.read", target: record.target, limit: 20 };
  if (record.action === "comment.reply") return { operation: "comments.replies", target: record.target, limit: 100 };
  return undefined;
}

/** Private mode-0600 snapshot store for request-id reconciliation across MCP restarts. */
export class FileActionReadbackStore implements ActionReadbackStore {
  readonly #path: string;
  #records?: Map<string, ActionReadbackRecord>;
  #queue: Promise<void> = Promise.resolve();
  constructor(path: string) {
    if (!path || !isAbsolute(path)) throw new Error("Read-back state path must be absolute.");
    this.#path = resolve(path);
  }
  async get(requestId: string): Promise<ActionReadbackRecord | undefined> {
    await this.#ready();
    const record = this.#records!.get(requestId);
    return record ? structuredClone(record) : undefined;
  }
  async latestFor(source: MutationSource, target: TargetRef): Promise<ActionReadbackRecord | undefined> {
    await this.#ready();
    const key = stableTarget(target);
    const record = [...this.#records!.values()].filter((item) => item.source === source && stableTarget(item.target) === key)
      .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt))[0];
    return record ? structuredClone(record) : undefined;
  }
  async put(record: ActionReadbackRecord): Promise<void> {
    const run = this.#queue.then(async () => {
      await this.#ready();
      const previous = this.#records!.get(record.requestId);
      if (previous && bindingKey(previous) !== bindingKey(record)) throw new Error("Read-back request binding cannot change.");
      const updated = new Map(this.#records);
      updated.set(record.requestId, structuredClone(record));
      const dir = dirname(this.#path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(dir, 0o700);
      const temp = `${this.#path}.${randomBytes(8).toString("hex")}.tmp`;
      const noFollow = constants.O_NOFOLLOW ?? 0;
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, records: [...updated.values()] }), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      try {
        await rename(temp, this.#path);
        if (process.platform !== "win32") {
          await chmod(this.#path, 0o600);
          if (((await stat(this.#path)).mode & 0o777) !== 0o600) throw new Error("Read-back state permissions are not private.");
        }
        this.#records = updated;
      } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
    });
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
  async #ready(): Promise<void> {
    if (this.#records) return;
    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) throw new Error("Read-back state is not a private regular file.");
      const parsed = JSON.parse(await handle.readFile("utf8")) as { version?: unknown; records?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error("Read-back state is invalid.");
      const records = new Map<string, ActionReadbackRecord>();
      for (const item of parsed.records) {
        if (!isActionReadbackRecord(item) || records.has(item.requestId)) throw new Error("Read-back state contains an invalid or duplicate request.");
        records.set(item.requestId, item);
      }
      this.#records = records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.#records = new Map(); return; }
      throw error;
    } finally { await handle?.close().catch(() => undefined); }
  }
}

export function payloadHash(payload: { text?: string }): string | undefined {
  return typeof payload.text === "string" ? createHash("sha256").update(payload.text, "utf8").digest("hex") : undefined;
}

export function isActionReadbackRecord(value: unknown): value is ActionReadbackRecord {
  if (!isRecord(value) || value.version !== 1 || !/^[\w-]{16,128}$/.test(String(value.requestId)) ||
      !/^[a-f\d]{64}$/i.test(String(value.fingerprint)) || !["api", "browser", "phone"].includes(String(value.source)) ||
      !["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.hide", "comment.show", "comment.delete", "comment.like", "comment.unlike"].includes(String(value.action)) ||
      !isRecord(value.target) || typeof value.target.accountBinding !== "string" || value.target.accountBinding !== value.accountBinding ||
      typeof value.accountBinding !== "string" || !Number.isFinite(Date.parse(String(value.attemptedAt))) ||
      !["pending", "unknown", "observed", "failed"].includes(String(value.status))) return false;
  return (value.payloadHash === undefined || /^[a-f\d]{64}$/i.test(String(value.payloadHash))) &&
    (value.dispatchStatus === undefined || ["ACK", "OUTCOME_UNKNOWN", "FAILED"].includes(String(value.dispatchStatus)));
}

function isOwnTextReply(row: Record<string, unknown>, record: ActionReadbackRecord, ownerIds?: string[]): boolean {
  if (typeof row.text !== "string" || hash(row.text) !== record.payloadHash) return false;
  const direction = row.direction;
  if (record.source === "browser") return direction === "outbound";
  if (record.source !== "api" || !ownerIds?.length) return false;
  const from = isRecord(row.from) ? row.from : undefined;
  return direction === "outbound" && typeof from?.id === "string" && ownerIds.includes(from.id);
}
function isOwnApiCommentReply(row: Record<string, unknown>, record: ActionReadbackRecord, ownerIds?: string[]): boolean {
  const from = isRecord(row.from) ? row.from : undefined;
  const timestamp = messageTimestamp(row);
  const id = messageId(row);
  return record.source === "api" && Boolean(ownerIds?.length) && typeof from?.id === "string" && ownerIds!.includes(from.id) &&
    typeof row.text === "string" && hash(row.text) === record.payloadHash && Boolean(id) &&
    Boolean(timestamp && Date.parse(timestamp) >= Date.parse(record.attemptedAt));
}
function selectExactCandidate(rows: Record<string, unknown>[], record: ActionReadbackRecord): Record<string, unknown> | undefined {
  const idMatch = record.receiptId ? rows.filter((row) => messageId(row) === record.receiptId) : [];
  if (record.receiptId) return idMatch.length === 1 ? idMatch[0] : undefined;
  const fresh = rows.filter((row) => { const value = messageTimestamp(row); return value && Date.parse(value) >= Date.parse(record.attemptedAt); });
  return fresh.length === 1 ? fresh[0] : undefined;
}
function currentDirectResponse(data: Record<string, unknown>, rows: Record<string, unknown>[], match: Record<string, unknown>): boolean {
  if (data.complete !== true || !rows.length || rows.some((row) => !messageTimestamp(row) || !["inbound", "outbound"].includes(String(row.direction)))) return false;
  const timestamps = rows.map((row) => Date.parse(messageTimestamp(row)!));
  if (timestamps.some((time, index) => index > 0 && timestamps[index - 1]! < time)) return false;
  const matchIndex = rows.indexOf(match);
  return matchIndex >= 0 && !rows.slice(0, matchIndex).some((row) => row.direction === "inbound");
}
function observationMatchesTarget(record: ActionReadbackRecord, observation: Observation<unknown>): boolean {
  const nativeId = record.target.nativeId;
  if (!nativeId || !isRecord(observation.data)) return false;
  if (record.action === "message.send") return observation.nativeRef === `conversation:${nativeId}` || observation.data.threadNativeId === nativeId;
  return observation.nativeRef === `comment-replies:${nativeId}`;
}
function isTextReply(action: MutationAction): boolean { return action === "message.send" || action === "comment.reply"; }
function messageId(row: Record<string, unknown>): string | undefined { return typeof row.id === "string" ? row.id : typeof row.nativeId === "string" ? row.nativeId : undefined; }
function messageTimestamp(row: Record<string, unknown>): string | undefined { const value = typeof row.createdAt === "string" ? row.createdAt : typeof row.timestamp === "string" ? row.timestamp : undefined; return value && Number.isFinite(Date.parse(value)) ? value : undefined; }
function bindingKey(record: ActionReadbackRecord): string { return JSON.stringify([record.requestId, record.fingerprint, record.source, record.bridgeId, record.accountBinding, record.action, record.target, record.payloadHash, record.attemptedAt]); }
function stableTarget(target: TargetRef): string { return JSON.stringify(Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)))); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function unknown(): Extract<ActionReadbackOutcome, { status: "OUTCOME_UNKNOWN" }> { return { status: "OUTCOME_UNKNOWN", reason: "The exact action was not independently verified; no write was retried.", responseState: "unknown" }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
