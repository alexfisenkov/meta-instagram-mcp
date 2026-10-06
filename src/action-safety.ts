import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  MutationIntent, MutationOptions, MutationPreview, MutationResult, MutationSource,
  TargetRef
} from "./domain-types.js";

export interface MutationExecutor {
  readonly source: MutationSource;
  refreshContext(intent: MutationIntent): Promise<{ target: TargetRef; contextHash: string }>;
  execute(intent: MutationIntent, requestId: string, contextHash: string): Promise<MutationResult>;
}

export interface MutationSafetyOptions {
  executors: readonly MutationExecutor[];
  auditPath: string;
  writeEnabled?: boolean;
}

interface AuditRow {
  version: 1;
  requestId: string;
  fingerprint: string;
  source: MutationSource;
  action: MutationIntent["action"];
  accountRef: string;
  targetRef: string;
  bridgeRef?: string;
  contextHash: string;
  status: "ATTEMPT" | MutationResult["status"];
}

interface PriorRequest { fingerprint: string; outcome?: MutationResult }

const ACTIONS = new Set<MutationIntent["action"]>([
  "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply",
  "comment.hide", "comment.show", "comment.delete", "comment.like", "comment.unlike"
]);

/** A source-bound one-shot mutation gate with a private, fsynced attempt journal. */
export class MutationSafety {
  readonly #executors = new Map<MutationSource, MutationExecutor>();
  readonly #auditPath: string;
  readonly #writeEnabled: boolean;
  readonly #previews = new Map<string, string>();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: MutationSafetyOptions) {
    if (!options.auditPath) throw new Error("An audit journal path is required.");
    for (const executor of options.executors) {
      if (this.#executors.has(executor.source)) throw new Error("Only one executor may be registered per source.");
      this.#executors.set(executor.source, executor);
    }
    this.#auditPath = resolve(options.auditPath);
    this.#writeEnabled = options.writeEnabled === true;
  }

  handle(intent: MutationIntent): Promise<MutationPreview>;
  handle(intent: MutationIntent, options: MutationOptions & { dryRun: true }): Promise<MutationPreview>;
  handle(intent: MutationIntent, options: MutationOptions & { dryRun: false }): Promise<MutationResult>;
  handle(intent: MutationIntent, options?: MutationOptions): Promise<MutationPreview | MutationResult>;
  handle(intent: MutationIntent, options: MutationOptions = {}): Promise<MutationPreview | MutationResult> {
    const run = this.#queue.then(() => this.#handle(intent, options));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #handle(intent: MutationIntent, options: MutationOptions): Promise<MutationPreview | MutationResult> {
    try { validateIntent(intent); } catch { return failed("Mutation intent is invalid."); }
    const executor = this.#executors.get(intent.source);
    if (!executor || executor.source !== intent.source) return failed("No executor is available for this source.");

    const fingerprint = fingerprintIntent(intent);
    if (options.dryRun !== false) {
      if (options.requestId !== undefined) return failed("Request ids are issued by the preview.");
      const requestId = randomUUID();
      const existing = this.#previews.get(requestId);
      if (existing && existing !== fingerprint) return failed("Request id is already bound to another preview.");
      this.#previews.set(requestId, fingerprint);
      while (this.#previews.size > 256) this.#previews.delete(this.#previews.keys().next().value as string);
      return {
        source: intent.source, accountBinding: intent.accountBinding, action: intent.action,
        target: intent.target, payload: intent.payload, contextHash: intent.contextHash,
        fingerprint, requestId, requiresConfirmation: true
      };
    }

    if (!this.#writeEnabled) return failed("Write environment is disabled.");
    const requestId = options.requestId;
    const previewFingerprint = requestId ? this.#previews.get(requestId) : undefined;
    if (options.confirm !== true || !requestId || !isRequestId(requestId) ||
        options.expectedFingerprint !== fingerprint ||
        (previewFingerprint !== undefined && previewFingerprint !== fingerprint) ||
        (intent.action === "comment.delete" && options.deleteConfirmation !== true)) {
      return failed("Mutation approval does not match a fresh preview.");
    }

    let fresh: { target: TargetRef; contextHash: string };
    try { fresh = await executor.refreshContext(intent); } catch { return failed("Fresh source context could not be verified."); }
    if (!fresh || stableStringify(fresh.target) !== stableStringify(intent.target) ||
        fresh.contextHash !== intent.contextHash) return failed("Source target or context changed after preview.");

    const lockPath = `${this.#auditPath}.lock`;
    let lock;
    let ownsLock = false;
    try {
      await mkdir(dirname(this.#auditPath), { recursive: true, mode: 0o700 });
      lock = await open(lockPath, "wx", 0o600);
      ownsLock = true;
      await lock.sync();
      const prior = await readJournal(this.#auditPath);
      const existing = prior.get(requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return failed("Request id conflicts with a previous mutation.");
        return existing.outcome ?? unknown("A previous attempt has no durable outcome; no retry was made.");
      }
      if (previewFingerprint !== fingerprint) return failed("Mutation approval does not match a fresh preview.");
      await appendJournal(this.#auditPath, auditRow(intent, requestId, fingerprint, "ATTEMPT"));
    } catch {
      this.#previews.delete(requestId);
      return failed("Private audit journal is unavailable; mutation was not dispatched.");
    } finally {
      await lock?.close().catch(() => undefined);
      if (ownsLock) await unlink(lockPath).catch(() => undefined);
    }

    let outcome: MutationResult;
    try {
      const result = await executor.execute(intent, requestId, intent.contextHash);
      outcome = isMutationResult(result) ? result : unknown("Executor returned an invalid result; no retry was made.");
    } catch (error) {
      outcome = isProvenRejection(error)
        ? failed("The source explicitly rejected the mutation.")
        : unknown("The dispatch outcome is uncertain; no retry was made.");
    }

    try { await appendJournal(this.#auditPath, auditRow(intent, requestId, fingerprint, outcome.status)); }
    catch { return unknown("The mutation was dispatched, but its outcome could not be durably recorded."); }
    return outcome;
  }
}

export function fingerprintIntent(intent: MutationIntent): string {
  return sha256(stableStringify({
    source: intent.source, bridgeId: intent.bridgeId, accountBinding: intent.accountBinding,
    action: intent.action, payload: intent.payload, target: intent.target, contextHash: intent.contextHash
  }));
}

function validateIntent(intent: MutationIntent): void {
  if (!intent || !["api", "browser", "phone"].includes(intent.source) || !ACTIONS.has(intent.action) ||
      !intent.accountBinding || !intent.contextHash || !intent.target ||
      intent.target.accountBinding !== intent.accountBinding ||
      !intent.payload || intent.payload.kind !== intent.action ||
      ("text" in intent.payload && typeof intent.payload.text !== "string") ||
      ("reaction" in intent.payload && typeof intent.payload.reaction !== "string")) {
    throw new Error("Invalid mutation intent.");
  }
}

function isRequestId(value: string): boolean { return /^[\w-]{16,128}$/.test(value); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function auditRow(intent: MutationIntent, requestId: string, fingerprint: string, status: AuditRow["status"]): AuditRow {
  const targetBinding = { accountBinding: intent.target.accountBinding, nativeId: intent.target.nativeId,
    explicitOwnerRef: intent.target.explicitOwnerRef, instagramUrl: intent.target.instagramUrl };
  return {
    version: 1, requestId, fingerprint, source: intent.source, action: intent.action,
    accountRef: sha256(intent.accountBinding), targetRef: sha256(stableStringify(targetBinding)),
    ...(intent.bridgeId ? { bridgeRef: sha256(intent.bridgeId) } : {}),
    contextHash: sha256(intent.contextHash), status
  };
}

async function readJournal(path: string): Promise<Map<string, PriorRequest>> {
  let contents: string;
  try { contents = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const requests = new Map<string, PriorRequest>();
  if (contents && !contents.endsWith("\n")) throw new Error("Journal has a partial trailing record.");
  for (const line of contents.split("\n").filter(Boolean)) {
    let row: AuditRow;
    try { row = JSON.parse(line) as AuditRow; } catch { throw new Error("Journal is corrupt."); }
    if (row.version !== 1 || !isRequestId(row.requestId) || !/^[a-f\d]{64}$/.test(row.fingerprint) ||
        !["api", "browser", "phone"].includes(row.source) || typeof row.action !== "string" ||
        typeof row.accountRef !== "string" || typeof row.targetRef !== "string" || typeof row.contextHash !== "string") {
      throw new Error("Journal contains an invalid record.");
    }
    const previous = requests.get(row.requestId);
    if (row.status === "ATTEMPT") {
      if (previous) throw new Error("Journal contains a duplicate attempt.");
      requests.set(row.requestId, { fingerprint: row.fingerprint });
    } else {
      if (!previous || previous.fingerprint !== row.fingerprint || previous.outcome ||
          !["ACK", "OBSERVED", "OUTCOME_UNKNOWN", "FAILED"].includes(row.status)) {
        throw new Error("Journal contains an invalid outcome sequence.");
      }
      previous.outcome = row.status === "ACK" ? { status: "ACK" }
        : row.status === "OBSERVED" ? { status: "OBSERVED" }
          : row.status === "FAILED" ? failed("A previous mutation failed.")
            : unknown("A previous mutation outcome is unknown; no retry was made.");
    }
  }
  return requests;
}

async function appendJournal(path: string, row: AuditRow): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Audit path is not a regular file.");
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
      const mode = (await stat(path)).mode & 0o777;
      if (mode !== 0o600) throw new Error("Audit journal permissions are not private.");
    }
    await handle.writeFile(`${JSON.stringify(row)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
}

function isMutationResult(value: unknown): value is MutationResult {
  return !!value && typeof value === "object" &&
    ["ACK", "OBSERVED", "OUTCOME_UNKNOWN", "FAILED"].includes((value as { status?: string }).status ?? "");
}

function isProvenRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const item = error as { name?: unknown; status?: unknown; preDispatch?: unknown };
  if (item.preDispatch === true) return true;
  return item.name === "MetaApiError" && typeof item.status === "number" && item.status >= 400 && item.status <= 499;
}

function failed(reason: string): MutationResult { return { status: "FAILED", reason }; }
function unknown(reason: string): MutationResult { return { status: "OUTCOME_UNKNOWN", reason }; }
