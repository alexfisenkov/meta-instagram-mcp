import type { CompanionHub, CompanionReadinessCandidate, BridgeOperation, BridgeSource } from "./companion-hub.js";
import type { Availability, Observation, TargetRef } from "./domain-types.js";
import type { MutationIntent } from "./domain-types.js";
import type { SourceReadContext } from "./read-context.js";
import type { ReadRequest, SourceProvider } from "./source-router.js";

export interface CompanionSourceProviderOptions {
  hub: CompanionHub;
  source: BridgeSource;
  accountBinding?: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

const BROWSER_INBOX_ROW_REF_PREFIX = "browser-inbox-row:";
const BROWSER_INBOX_ROW_REF_TTL_MS = 5 * 60_000;
const MAX_BROWSER_READINESS_CANDIDATES = 3;

function hasPinnedCompanion(context: SourceReadContext | undefined): boolean {
  return context?.companionBridgeSelection === "pinned" ||
    (Boolean(context?.companionBridgeId) && context?.companionBridgeSelection !== "automatic");
}

/** Reads through the durable authenticated companion task queue; it never exposes writes. */
export function createCompanionSourceProvider(options: CompanionSourceProviderOptions): SourceProvider {
  const waitMs = options.waitMs ?? (process.platform === "win32" ? 30_000 : 4_000);
  const pollMs = options.pollMs ?? 50;
  const now = options.now ?? Date.now;
  const browserCursors = new Map<string, { accountBinding: string; targetKey: string; pageBudget: number; expiresAt: number }>();
  const browserInboxRowRefs = new Map<string, { bridgeId: string; accountBinding: string; expiresAt: number }>();
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 30_000 || !Number.isInteger(pollMs) || pollMs < 5 || pollMs > 1_000) {
    throw new Error("invalid companion source wait budget");
  }

  const provider: SourceProvider = {
    source: options.source,
    async prepareRead(request, context) {
      throwIfReadStopped(context, now);
      const target = "target" in request ? request.target : undefined;
      const rowRef = target?.explicitOwnerRef?.startsWith(BROWSER_INBOX_ROW_REF_PREFIX) ? target.explicitOwnerRef : undefined;
      if (rowRef && request.operation === "conversation.read" && options.source === "browser" && target) {
        const selected = lookupBrowserInboxRef(browserInboxRowRefs, rowRef, target.accountBinding, now());
        if (!selected || (context?.companionBridgeId && context.companionBridgeId !== selected.bridgeId)) {
          throw new Error("The browser inbox row reference is unknown, expired, or bound to another selected bridge.");
        }
        if (context) { context.companionBridgeId = selected.bridgeId; context.companionBridgeSelection = "pinned"; }
        const status = await options.hub.sourceStatus("browser", target.accountBinding, selected.bridgeId, "conversation.read");
        throwIfReadStopped(context, now);
        if (status.bridgeId !== selected.bridgeId || status.accountBinding !== target.accountBinding ||
            status.availability !== "ready" || !status.capabilities.includes("conversation.read")) {
          throw new Error("The browser inbox row reference no longer has a ready selected companion.");
        }
        return;
      }
      if (options.source !== "browser" || request.operation === "account.inspect") return;
      if (!supportsBrowserReadinessProbe(request)) return;
      throwIfReadStopped(context, now);
      const requestedBinding = target?.accountBinding ?? options.accountBinding;
      if (target && options.accountBinding && target.accountBinding !== options.accountBinding) return;
      const pinned = hasPinnedCompanion(context);
      const initial = await options.hub.sourceStatus(options.source, requestedBinding,
        pinned ? context?.companionBridgeId : undefined, request.operation);
      throwIfReadStopped(context, now);
      if (pinned && context?.companionBridgeId && initial.bridgeId && initial.bridgeId !== context.companionBridgeId) {
        throw new Error("Selected companion changed during browser preflight.");
      }
      if (context && !context.companionBridgeId && initial.bridgeId) {
        context.companionBridgeId = initial.bridgeId;
        context.companionBridgeSelection = "automatic";
      }
      const readinessBinding = requestedBinding ?? initial.accountBinding;
      if (initial.availability === "ready" || !readinessBinding || !initial.bridgeId || pinned) return;

      const probe = await probeBrowserReadiness(readinessBinding, request.operation, context, true);
      throwIfReadStopped(context, now);
      if (probe.bridgeId) return;
      if (probe.eligibleCandidates > 0) throw new Error("A registered browser companion did not verify the selected Instagram account.");
    },
    async status(operation, context) {
      if (isReadStopped(context, now)) return { source: options.source, availability: "offline", capabilities: [], reason: "Read stopped before companion readiness check." };
      const status = await options.hub.sourceStatus(options.source, options.accountBinding, context?.companionBridgeId, operation as BridgeOperation | undefined);
      if (isReadStopped(context, now)) return { source: options.source, availability: "offline", capabilities: [], reason: "Read stopped during companion readiness check." };
      if (context?.companionBridgeId && status.bridgeId !== context.companionBridgeId) {
        return { source: options.source, availability: "offline", capabilities: [], accountBinding: options.accountBinding,
          reason: "The selected companion identity is no longer available." };
      }
      if (context && !context.companionBridgeId && status.bridgeId) {
        context.companionBridgeId = status.bridgeId;
        context.companionBridgeSelection = "automatic";
      } else if (context?.companionBridgeId && !context.companionBridgeSelection) {
        context.companionBridgeSelection = "pinned";
      }
      if (operation && status.availability === "ready" && !status.capabilities.includes(operation)) {
        return { ...status, availability: "unsupported", reason: `The connected companion does not report ${operation}.` };
      }
      return status;
    },
    async read(request, context) {
      if (isReadStopped(context, now)) {
        const stoppedBinding = "target" in request ? request.target?.accountBinding : "accountBinding" in request ? request.accountBinding : undefined;
        return readStoppedObservation(options.source, stoppedBinding ?? options.accountBinding ?? "unresolved", context, now);
      }
      // Keep ephemeral browser refs pinned even for direct provider callers without a router context.
      const selectionContext = context ?? {};
      const target = "target" in request ? request.target : undefined;
      const requestedAccountBinding = "accountBinding" in request ? request.accountBinding : undefined;
      if (request.operation === "account.inspect" && options.source === "browser" && !target && !hasPinnedCompanion(context)) {
        if (options.accountBinding && requestedAccountBinding && requestedAccountBinding !== options.accountBinding) {
          return unavailable("browser", requestedAccountBinding, "needs_selection", "The requested account binding does not match this browser provider.", "account_binding_mismatch");
        }
        let binding = requestedAccountBinding ?? options.accountBinding;
        if (!binding) {
          const selected = await options.hub.sourceStatus("browser", undefined,
            context?.companionBridgeSelection === "automatic" ? context.companionBridgeId : undefined, "account.inspect");
          if (isReadStopped(context, now)) return readStoppedObservation("browser", "unresolved", context, now);
          binding = selected.accountBinding;
        }
        if (binding) return (await probeBrowserReadiness(binding, "account.inspect", context, false)).observation;
      }
      if (isReadStopped(context, now)) return readStoppedObservation(options.source, target?.accountBinding ?? requestedAccountBinding ?? options.accountBinding ?? "unresolved", context, now);
      if (((options.source === "phone" || options.source === "browser") &&
          ((request.operation === "inbox.list" && request.cursor) ||
           ((request.operation === "comments.list" || request.operation === "comments.replies") && request.cursor))) ||
          (options.source === "phone" && request.operation === "conversation.read" && request.olderCursor)) {
        return unavailable(options.source, target?.accountBinding ?? options.accountBinding ?? "unresolved", "unsupported",
          `The ${options.source} companion does not support this cursor operation.`, "unsupported_cursor");
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
      const accountBinding = target?.accountBinding ?? requestedAccountBinding ?? options.accountBinding;
      const browserRowRef = target?.explicitOwnerRef?.startsWith(BROWSER_INBOX_ROW_REF_PREFIX) ? target.explicitOwnerRef : undefined;
      if (browserRowRef && (options.source !== "browser" || request.operation !== "conversation.read")) {
        return unavailable(options.source, accountBinding ?? "unresolved", "unsupported", "An ephemeral browser inbox reference is valid only for its selected conversation read.", "browser_ref_read_only");
      }
      if (browserRowRef) {
        const selected = lookupBrowserInboxRef(browserInboxRowRefs, browserRowRef, target!.accountBinding, now());
        if (!selected || (context?.companionBridgeId && context.companionBridgeId !== selected.bridgeId)) {
          return unavailable("browser", accountBinding ?? "unresolved", "needs_selection", "The browser inbox row reference is unknown, expired, or bound to another selected bridge.", "stale_browser_inbox_ref");
        }
        selectionContext.companionBridgeId = selected.bridgeId;
        selectionContext.companionBridgeSelection = "pinned";
      }
      const status = await options.hub.sourceStatus(options.source, accountBinding, selectionContext.companionBridgeId, request.operation);
      const resolvedAccountBinding = accountBinding ?? status.accountBinding;
      if (isReadStopped(context, now)) return readStoppedObservation(options.source, resolvedAccountBinding ?? "unresolved", context, now);
      if (!status.bridgeId || (selectionContext.companionBridgeId && status.bridgeId !== selectionContext.companionBridgeId)) {
        return unavailable(options.source, resolvedAccountBinding ?? "unresolved", "offline", "The selected companion identity is no longer available.", "bridge_selection_unavailable");
      }
      if (context && !context.companionBridgeId) {
        context.companionBridgeId = status.bridgeId;
        context.companionBridgeSelection = "automatic";
      }
      const bootstrap = request.operation === "account.inspect" && options.source === "browser" && Boolean(status.bridgeId);
      if ((status.availability !== "ready" && !bootstrap) || !resolvedAccountBinding ||
          (status.availability === "ready" && !status.capabilities.includes(request.operation))) {
        return unavailable(options.source, resolvedAccountBinding ?? "unresolved", status.availability === "ready" ? "unsupported" : status.availability,
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
      const deadline = Math.min(now() + waitMs, contextDeadline(context) ?? Number.POSITIVE_INFINITY);
      const taskTtlMs = Math.floor(deadline - now());
      if (taskTtlMs < 1 || context?.signal?.aborted) {
        return readStoppedObservation(options.source, resolvedAccountBinding, context, now);
      }
      let task;
      try {
        task = await options.hub.enqueue({ kind: "read", source: options.source, bridgeId: status.bridgeId, accountBinding: resolvedAccountBinding, operation, payload, targetRefs, ttlMs: taskTtlMs });
      } catch (error) {
        return unavailable(options.source, resolvedAccountBinding, "offline", safeReason(error), "enqueue_failed");
      }
      if (isReadStopped(context, now)) {
        await cancelReadTask(options.hub, task.id);
        return readStoppedObservation(options.source, resolvedAccountBinding, context, now);
      }
      while (now() < deadline && !context?.signal?.aborted) {
        const result = await options.hub.result(task.id);
        if (isReadStopped(context, now)) {
          await cancelReadTask(options.hub, task.id);
          return readStoppedObservation(options.source, resolvedAccountBinding, context, now);
        }
        if (result.status === "complete") {
          if (!isObservation(result.result)) return unavailable(options.source, resolvedAccountBinding, "unsupported_ui_version", "Companion returned an invalid observation.", "invalid_result");
          const observation = result.result;
          if (options.source === "browser" && request.operation === "inbox.list" && status.bridgeId) {
            rememberBrowserInboxRefs(browserInboxRowRefs, observation, status.bridgeId, resolvedAccountBinding, now());
          }
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
          return unavailable(options.source, resolvedAccountBinding, "offline", "Companion read task did not complete before its lease expired.", result.status);
        }
        await delay(Math.min(pollMs, Math.max(1, deadline - now())), context?.signal);
      }
      await cancelReadTask(options.hub, task.id);
      if (context?.signal?.aborted) return readStoppedObservation(options.source, resolvedAccountBinding, context, now);
      return unavailable(options.source, resolvedAccountBinding, "offline", "Companion read exceeded its bounded wait budget.", "timeout");
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

  async function probeBrowserReadiness(accountBinding: string, operation: BridgeOperation, context: SourceReadContext | undefined,
    reserveRequestedRead: boolean): Promise<{ eligibleCandidates: number; bridgeId?: string; observation: Observation<unknown> }> {
    if (isReadStopped(context, now)) return { eligibleCandidates: 0, observation: readStoppedObservation("browser", accountBinding, context, now) };
    const discovered = await options.hub.readinessCandidates("browser", accountBinding, operation);
    if (isReadStopped(context, now)) return { eligibleCandidates: 0, observation: readStoppedObservation("browser", accountBinding, context, now) };
    const candidates: CompanionReadinessCandidate[] = discovered.filter((candidate) => candidate.source === "browser" &&
      candidate.accountBinding === accountBinding && typeof candidate.bridgeId === "string" &&
      candidate.declaredCapabilities.includes("account.inspect") && candidate.declaredCapabilities.includes(operation))
      .slice(0, MAX_BROWSER_READINESS_CANDIDATES);
    if (!candidates.length) {
      const current = await options.hub.sourceStatus("browser", accountBinding,
        context?.companionBridgeSelection === "pinned" ? context.companionBridgeId : undefined, operation);
      const availability = current.availability === "ready" ? "unsupported" : current.availability;
      return { eligibleCandidates: 0, observation: unavailable("browser", accountBinding, availability,
        current.reason ?? "No fresh same-account browser bridge declares the required read capabilities.", "readiness_candidate_unavailable") };
    }

    const fallbackDeadline = now() + waitMs * (candidates.length + (reserveRequestedRead ? 1 : 0));
    const sharedDeadline = Math.min(contextDeadline(context) ?? fallbackDeadline, fallbackDeadline);
    let lastAvailability: Availability = "offline";
    for (let index = 0; index < candidates.length; index += 1) {
      if (isReadStopped(context, now)) {
        return { eligibleCandidates: candidates.length, observation: readStoppedObservation("browser", accountBinding, context, now) };
      }
      const remaining = sharedDeadline - now();
      if (remaining <= 0) break;
      const slotsLeft = candidates.length - index;
      const reserveMs = reserveRequestedRead ? Math.min(waitMs, Math.floor(remaining / (slotsLeft + 1))) : 0;
      const attemptBudget = Math.min(waitMs, Math.max(1, Math.floor((remaining - reserveMs) / slotsLeft)));
      const candidate = candidates[index]!;
      const candidateContext: SourceReadContext = {
        ...(context?.signal ? { signal: context.signal } : {}),
        deadlineAt: Math.min(sharedDeadline, now() + attemptBudget),
        companionBridgeId: candidate.bridgeId,
        companionBridgeSelection: "pinned"
      };
      const probe = await provider.read({ operation: "account.inspect", accountBinding }, candidateContext);
      if (isReadStopped(context, now)) {
        return { eligibleCandidates: candidates.length, observation: readStoppedObservation("browser", accountBinding, context, now) };
      }
      const verified = await options.hub.sourceStatus("browser", accountBinding, candidate.bridgeId, operation);
      if (isReadStopped(context, now)) {
        return { eligibleCandidates: candidates.length, observation: readStoppedObservation("browser", accountBinding, context, now) };
      }
      const data = isRecord(probe.data) ? probe.data : undefined;
      const username = typeof data?.username === "string" ? data.username.toLowerCase() : "";
      const verifiedHandle = verified.accountHandle?.toLowerCase() ?? "";
      if (probe.source === "browser" && probe.availability === "ready" && probe.accountBinding === accountBinding &&
          data?.surface === "instagram" && (!data.accountBinding || data.accountBinding === accountBinding) && username && verifiedHandle === username &&
          verified.availability === "ready" && verified.accountBinding === accountBinding && verified.bridgeId === candidate.bridgeId &&
          verified.surface === "instagram" && verified.capabilities.includes("account.inspect") && verified.capabilities.includes(operation)) {
        if (context) {
          context.companionBridgeId = candidate.bridgeId;
          context.companionBridgeSelection = "pinned";
        }
        return { eligibleCandidates: candidates.length, bridgeId: candidate.bridgeId, observation: probe };
      }
      lastAvailability = probe.availability === "ready" ? verified.availability : probe.availability;
    }

    return { eligibleCandidates: candidates.length, observation: unavailable("browser", accountBinding,
      lastAvailability === "ready" ? "needs_selection" : lastAvailability,
      "No fresh same-account browser bridge completed owner verification for the requested read.", "account_inspect_unverified") };
  }

  return provider;
}

function supportsBrowserReadinessProbe(request: ReadRequest): boolean {
  if (request.operation === "insights.read") return false;
  if (request.operation === "inbox.list" && request.cursor) return false;
  if ((request.operation === "comments.list" || request.operation === "comments.replies") && request.cursor) return false;
  return true;
}

function stableTarget(target: TargetRef): string { return JSON.stringify(Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)))); }
function lookupBrowserInboxRef(refs: Map<string, { bridgeId: string; accountBinding: string; expiresAt: number }>, reference: string, accountBinding: string, now: number) {
  const record = refs.get(reference);
  if (!record) return undefined;
  if (record.expiresAt <= now || record.accountBinding !== accountBinding) { refs.delete(reference); return undefined; }
  return record;
}
function rememberBrowserInboxRefs(refs: Map<string, { bridgeId: string; accountBinding: string; expiresAt: number }>, observation: Observation<unknown>, bridgeId: string, accountBinding: string, now: number): void {
  for (const [reference, record] of refs) {
    if (record.expiresAt <= now || (record.bridgeId === bridgeId && record.accountBinding === accountBinding)) refs.delete(reference);
  }
  if (!isRecord(observation.data) || !Array.isArray(observation.data.items)) return;
  for (const item of observation.data.items.slice(0, 100)) {
    if (!isRecord(item) || !isRecord(item.target)) continue;
    const reference = item.target.explicitOwnerRef;
    if (typeof reference !== "string" || !reference.startsWith(BROWSER_INBOX_ROW_REF_PREFIX) || item.target.accountBinding !== accountBinding) continue;
    refs.set(reference, { bridgeId, accountBinding, expiresAt: now + BROWSER_INBOX_ROW_REF_TTL_MS });
  }
  while (refs.size > 1_000) refs.delete(refs.keys().next().value as string);
}
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
function contextDeadline(context: SourceReadContext | undefined): number | undefined {
  return typeof context?.deadlineAt === "number" && Number.isFinite(context.deadlineAt) ? context.deadlineAt : undefined;
}

function isReadStopped(context: SourceReadContext | undefined, now: () => number): boolean {
  return Boolean(context?.signal?.aborted || (contextDeadline(context) !== undefined && now() >= contextDeadline(context)!));
}

function throwIfReadStopped(context: SourceReadContext | undefined, now: () => number): void {
  if (!isReadStopped(context, now)) return;
  if (context?.signal?.aborted && context.signal.reason instanceof Error) throw context.signal.reason;
  throw new Error("Companion read deadline expired.");
}

function readStoppedObservation(source: BridgeSource, accountBinding: string, context: SourceReadContext | undefined, now: () => number): Observation<unknown> {
  const cancelled = Boolean(context?.signal?.aborted);
  const message = cancelled && context?.signal?.reason instanceof Error
    ? context.signal.reason.message
    : "Companion read deadline expired before completion.";
  return unavailable(source, accountBinding, "offline", message, cancelled ? "cancelled" : "timeout");
}

async function cancelReadTask(hub: CompanionHub, taskId: string): Promise<void> {
  try { await hub.cancelReadTask(taskId); } catch { /* cancellation must not replace the unknown read result */ }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}
import { randomUUID } from "node:crypto";
