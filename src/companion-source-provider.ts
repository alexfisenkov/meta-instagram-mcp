import type { CompanionHub, BridgeOperation, BridgeSource } from "./companion-hub.js";
import type { Availability, Observation, TargetRef } from "./domain-types.js";
import type { MutationIntent } from "./domain-types.js";
import type { ReadRequest, SourceProvider } from "./source-router.js";

export interface CompanionSourceProviderOptions {
  hub: CompanionHub;
  source: BridgeSource;
  accountBinding?: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** Reads through the durable authenticated companion task queue; it never exposes writes. */
export function createCompanionSourceProvider(options: CompanionSourceProviderOptions): SourceProvider {
  const waitMs = options.waitMs ?? (process.platform === "win32" ? 30_000 : 4_000);
  const pollMs = options.pollMs ?? 50;
  const now = options.now ?? Date.now;
  const browserCursors = new Map<string, { accountBinding: string; targetKey: string; pageBudget: number; expiresAt: number }>();
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 30_000 || !Number.isInteger(pollMs) || pollMs < 5 || pollMs > 1_000) {
    throw new Error("invalid companion source wait budget");
  }

  return {
    source: options.source,
    async status(operation) {
      const status = await options.hub.sourceStatus(options.source, options.accountBinding);
      if (operation && status.availability === "ready" && !status.capabilities.includes(operation)) {
        return { ...status, availability: "unsupported", reason: `The connected companion does not report ${operation}.` };
      }
      return status;
    },
    async read(request) {
      const target = "target" in request ? request.target : undefined;
      if (options.source === "phone" && ((request.operation === "inbox.list" && request.cursor) ||
          (request.operation === "conversation.read" && request.olderCursor) ||
          ((request.operation === "comments.list" || request.operation === "comments.replies") && request.cursor))) {
        return unavailable(options.source, target?.accountBinding ?? options.accountBinding ?? "unresolved", "unsupported",
          "The phone companion does not support this cursor operation.", "unsupported_cursor");
      }
      let browserPageBudget = 0;
      if (request.operation === "conversation.read" && request.olderCursor && options.source === "browser") {
        const cursor = browserCursors.get(request.olderCursor);
        browserCursors.delete(request.olderCursor);
        const targetKey = target ? stableTarget(target) : "";
        if (!cursor || cursor.expiresAt <= now() || !target || cursor.accountBinding !== target.accountBinding || cursor.targetKey !== targetKey || cursor.pageBudget > 4) {
          return unavailable(options.source, target?.accountBinding ?? options.accountBinding ?? "unresolved", "unsupported",
            "The browser history cursor is unknown, expired, or bound to another selected conversation.", "invalid_older_cursor");
        }
        browserPageBudget = cursor.pageBudget;
      }
      const status = await options.hub.sourceStatus(options.source, target?.accountBinding ?? options.accountBinding);
      const accountBinding = target?.accountBinding ?? status.accountBinding;
      const bootstrap = request.operation === "account.inspect" && options.source === "browser" && Boolean(status.bridgeId);
      if ((status.availability !== "ready" && !bootstrap) || !accountBinding ||
          (status.availability === "ready" && !status.capabilities.includes(request.operation))) {
        return unavailable(options.source, accountBinding ?? "unresolved", status.availability === "ready" ? "unsupported" : status.availability,
          status.reason ?? `The connected companion does not report ${request.operation}.`, status.availability);
      }
      const operation: BridgeOperation = request.operation;
      const targetRefs = target ? [{ ...target }] : [];
      let payload: Record<string, unknown>;
      if (request.operation === "inbox.list") payload = { limit: request.limit ?? 20, ...(request.cursor ? { cursor: request.cursor } : {}) };
      else if (request.operation === "conversation.read") payload = { limit: request.limit ?? 20, ...(request.olderCursor ? { pages: browserPageBudget } : {}) };
      else if (request.operation === "comments.list" || request.operation === "comments.replies") payload = { limit: request.limit ?? 25, ...(request.cursor ? { cursor: request.cursor } : {}) };
      else if (request.operation === "insights.read") payload = { period: request.period ?? "day" };
      else payload = {};
      let task;
      try {
        task = await options.hub.enqueue({ kind: "read", source: options.source, accountBinding, operation, payload, targetRefs, ttlMs: waitMs + pollMs * 2 });
      } catch (error) {
        return unavailable(options.source, accountBinding, "offline", safeReason(error), "enqueue_failed");
      }
      const deadline = now() + waitMs;
      while (now() < deadline) {
        const result = await options.hub.result(task.id);
        if (result.status === "complete") {
          if (!isObservation(result.result)) return unavailable(options.source, accountBinding, "unsupported_ui_version", "Companion returned an invalid observation.", "invalid_result");
          const observation = result.result;
          if (options.source === "browser" && request.operation === "conversation.read" && target && browserPageBudget < 5 &&
              isRecord(observation.data) && observation.data.olderAvailable === true) {
            const olderCursor = `browser-older:${randomUUID()}`;
            browserCursors.set(olderCursor, { accountBinding: target.accountBinding, targetKey: stableTarget(target), pageBudget: browserPageBudget + 1, expiresAt: now() + 15 * 60_000 });
            while (browserCursors.size > 1_000) browserCursors.delete(browserCursors.keys().next().value as string);
            return { ...observation, pagination: { olderCursor, hasOlder: true, pageBudget: browserPageBudget + 1 } };
          }
          return observation;
        }
        if (["expired", "outcome_unknown"].includes(result.status)) {
          return unavailable(options.source, accountBinding, result.status === "expired" ? "offline" : "offline", "Companion read task did not complete before its lease expired.", result.status);
        }
        await delay(Math.min(pollMs, Math.max(1, deadline - now())));
      }
      return unavailable(options.source, accountBinding, "offline", "Companion read exceeded its bounded wait budget.", "timeout");
    },
    async refreshContext(intent: MutationIntent) {
      if (options.source !== "phone" || intent.source !== "phone" || intent.target.accountBinding !== intent.accountBinding ||
          !intent.target.nativeId || !intent.contextHash || !["comment.like", "comment.unlike", "comment.reply", "comment.private_reply", "message.send", "message.react", "message.unreact"].includes(intent.action)) {
        return { target: intent.target, contextHash: "", availability: "unsupported" };
      }
      const status = await options.hub.sourceStatus("phone", intent.accountBinding);
      if (status.availability !== "ready" || !status.bridgeId || !status.capabilities.includes("context.refresh")) {
        return { target: intent.target, contextHash: "", availability: status.availability === "ready" ? "unsupported" : status.availability };
      }
      let task;
      try {
        task = await options.hub.enqueue({ kind: "read", source: "phone", bridgeId: status.bridgeId, accountBinding: intent.accountBinding,
          operation: "context.refresh", payload: { action: intent.action }, targetRefs: [{ ...intent.target }], ttlMs: waitMs + pollMs * 2 });
      } catch { return { target: intent.target, contextHash: "", availability: "offline" }; }
      const deadline = now() + waitMs;
      while (now() < deadline) {
        const receipt = await options.hub.result(task.id);
        if (receipt.status === "complete") {
          const result = receipt.result;
          if (isRecord(result) && result.availability === "ready" && result.accountBinding === intent.accountBinding &&
              isRecord(result.target) && typeof result.target.accountBinding === "string" && stableTarget(result.target as unknown as TargetRef) === stableTarget(intent.target) &&
              typeof result.contextHash === "string" && /^[a-f\d]{16,128}$/i.test(result.contextHash)) {
            return { target: intent.target, contextHash: result.contextHash, availability: "ready" };
          }
          return { target: intent.target, contextHash: "", availability: isRecord(result) && isAvailability(result.availability) ? result.availability : "unsupported" };
        }
        if (["expired", "outcome_unknown"].includes(receipt.status)) return { target: intent.target, contextHash: "", availability: "offline" };
        await delay(Math.min(pollMs, Math.max(1, deadline - now())));
      }
      return { target: intent.target, contextHash: "", availability: "offline" };
    }
  };
}

function stableTarget(target: TargetRef): string { return JSON.stringify(Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)))); }
function isAvailability(value: unknown): value is Availability { return ["ready", "permission_blocked", "missing_scope", "offline", "not_connected", "unsupported", "unsupported_ui_version", "needs_selection"].includes(String(value)); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function unavailable(source: BridgeSource, accountBinding: string, availability: Availability, message: string, code: string): Observation<unknown> {
  return { source, nativeRef: `${source}:unavailable`, accountBinding, capturedAt: new Date().toISOString(), availability,
    coverage: "unknown", historyCompleteness: "unknown", errors: [{ code, message: message.slice(0, 240) }] };
}

function isObservation(value: unknown): value is Observation<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["api", "browser", "phone"].includes(String(item.source)) && typeof item.nativeRef === "string" &&
    typeof item.accountBinding === "string" && typeof item.capturedAt === "string" &&
    ["ready", "permission_blocked", "missing_scope", "offline", "not_connected", "unsupported", "unsupported_ui_version", "needs_selection"].includes(String(item.availability)) &&
    ["complete", "partial", "unknown"].includes(String(item.coverage)) &&
    ["complete", "limited", "unknown", "not_applicable"].includes(String(item.historyCompleteness)) && Array.isArray(item.errors);
}

function safeReason(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : "Companion queue rejected the read."; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
import { randomUUID } from "node:crypto";
