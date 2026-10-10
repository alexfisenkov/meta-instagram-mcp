import type { Availability, HistoryCompleteness, MutationIntent, Observation, SourceId, TargetRef } from "./domain-types.js";
import type { ApiReadRequest } from "./api-provider.js";
import type { SourceReadContext } from "./read-context.js";

export type ReadRequest = ApiReadRequest;

export interface SourceProvider {
  readonly source: Exclude<SourceId, "user_supplied">;
  status(operation?: ReadRequest["operation"], context?: SourceReadContext): Promise<{ source: SourceId; availability: Availability; capabilities: string[]; reason?: string; accountBinding?: string; bridgeId?: string }>;
  /** Optional bounded, read-only source bootstrap before the requested read. */
  prepareRead?(request: ReadRequest, context?: SourceReadContext): Promise<void>;
  read(request: ReadRequest, context?: SourceReadContext): Promise<Observation<unknown>>;
  refreshContext?(intent: MutationIntent): Promise<{ target: TargetRef; contextHash: string; availability?: Availability; sideEffects?: Array<"may_mark_seen"> }>;
}

export interface RoutedRead<T = unknown> {
  observations: Observation<T>[];
  triedSources: Array<SourceProvider["source"]>;
  identityConflicts: TargetRef[];
  skippedSources: Array<{ source: SourceId; reason: string }>;
  coverage: Observation<T>["coverage"];
  historyCompleteness: HistoryCompleteness;
  errors: Array<{ source: SourceId; code: string; message: string }>;
}

export interface SourceRouterOptions {
  providers: readonly SourceProvider[];
  timeoutMs?: number;
  maxProviders?: number;
}

export interface SourceRouter {
  status(operation?: ReadRequest["operation"]): Promise<Array<{ source: SourceId; availability: Availability; capabilities: string[]; reason?: string }>>;
  read(request: ReadRequest): Promise<RoutedRead>;
}

const PRIORITY: ReadonlyArray<SourceProvider["source"]> = ["api", "browser", "phone"];
const WINDOWS_DEFAULT_READ_BUDGET_MS = 50_000;
const TRIAGE_API_FALLBACK_RESERVE_MS = 8_000;
const WINDOWS_TRIAGE_API_FALLBACK_RESERVE_MS = 35_000;
const READ_ABORT_GRACE_MS = 250;
const BROWSER_INBOX_ROW_REF_PREFIX = "browser-inbox-row:";

/** Returns the default shared provider budget; Windows leaves room before the MCP client's 60s request timeout. */
export function defaultSourceRouterTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? WINDOWS_DEFAULT_READ_BUDGET_MS : 12_000;
}

/** Reserves shared route time for browser/phone after a slow API inbox-triage read. */
export function sourceRouterTriageFallbackReserveMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? WINDOWS_TRIAGE_API_FALLBACK_RESERVE_MS : TRIAGE_API_FALLBACK_RESERVE_MS;
}

/** Bounded read-only fallback. Observations stay attributed; this router never merges records. */
export function createSourceRouter(options: SourceRouterOptions): SourceRouter {
  // Keep the shared Windows read result ahead of the MCP SDK's 60s client request deadline.
  const timeoutMs = options.timeoutMs ?? defaultSourceRouterTimeoutMs();
  const maxProviders = options.maxProviders ?? PRIORITY.length;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("invalid source router timeout");
  if (!Number.isInteger(maxProviders) || maxProviders < 1 || maxProviders > PRIORITY.length) throw new Error("invalid source router provider limit");
  const bySource = new Map(options.providers.map((provider) => [provider.source, provider]));
  if (bySource.size !== options.providers.length) throw new Error("only one provider may be registered per source");

  return {
    async status(operation) {
      const results = await Promise.all(PRIORITY.map(async (source) => {
        const provider = bySource.get(source);
        if (!provider) return { source, availability: "not_connected" as const, capabilities: [], reason: "No provider is configured." };
        try { return await provider.status(operation); }
        catch (error) { return { source, availability: "offline" as const, capabilities: [], reason: safeReason(error) }; }
      }));
      return results;
    },
    async read(request) {
      const observations: Observation<unknown>[] = [];
      const triedSources: SourceProvider["source"][] = [];
      const identityConflicts: TargetRef[] = [];
      const skippedSources: RoutedRead["skippedSources"] = [];
      const errors: RoutedRead["errors"] = [];
      const deadline = Date.now() + timeoutMs;
      const target = "target" in request ? request.target : undefined;
      if (target && (!target.accountBinding || !hasVerifiableIdentity(target))) {
        return emptyResult(observations, triedSources, [target], skippedSources, [{ source: "api", code: "needs_selection", message: "A native id or explicit owner reference is required for a selected target." }]);
      }
      const browserInboxRowRef = target?.explicitOwnerRef?.startsWith(BROWSER_INBOX_ROW_REF_PREFIX) ?? false;
      if (browserInboxRowRef && request.operation !== "conversation.read") {
        return emptyResult(observations, triedSources, [], skippedSources, [{ source: "browser", code: "browser_ref_read_only", message: "A browser inbox row reference is valid only for a selected conversation read." }]);
      }

      const ordered = PRIORITY.map((source) => bySource.get(source)).filter((item): item is SourceProvider => Boolean(item)).slice(0, maxProviders);
      for (let providerIndex = 0; providerIndex < ordered.length; providerIndex += 1) {
        const provider = ordered[providerIndex]!;
        if (browserInboxRowRef && provider.source !== "browser") {
          skippedSources.push({ source: provider.source, reason: "The selected target is an ephemeral browser inbox reference." });
          continue;
        }
        let remaining = deadline - Date.now();
        if (remaining <= 0) {
          skippedSources.push({ source: provider.source, reason: "The shared read budget expired." });
          continue;
        }
        const isApiInboxTriage = provider.source === "api" && request.operation === "inbox.list" && request.triage === true;
        const laterProviderExists = providerIndex + 1 < ordered.length;
        const desiredReserve = isApiInboxTriage && laterProviderExists ? sourceRouterTriageFallbackReserveMs() : 0;
        const fallbackReserve = Math.min(desiredReserve, Math.max(0, remaining - 1));
        const providerBudgetMs = Math.max(1, remaining - fallbackReserve);
        const controller = new AbortController();
        const sourceStartedAt = Date.now();
        const abortAfterMs = Math.max(1, providerBudgetMs - Math.min(READ_ABORT_GRACE_MS, Math.floor(providerBudgetMs / 4)));
        const context = { signal: controller.signal, deadlineAt: sourceStartedAt + abortAfterMs };
        const abortTimer = setTimeout(() => controller.abort(new Error("Provider read deadline expired.")), abortAfterMs);
        if (provider.prepareRead) {
          let preflightFailed = false;
          try {
            const preflightRemaining = Math.max(1, providerBudgetMs - (Date.now() - sourceStartedAt));
            await withTimeout(provider.prepareRead(request, context), preflightRemaining, () => controller.abort());
          } catch (error) {
            preflightFailed = true;
            const code = error instanceof TimeoutError ? "preflight_timeout" : "preflight_failed";
            errors.push({ source: provider.source, code, message: safeReason(error) });
            skippedSources.push({ source: provider.source, reason: "Source did not pass its required read preflight." });
          }
          remaining = deadline - Date.now();
          const sourceRemaining = providerBudgetMs - (Date.now() - sourceStartedAt);
          if (preflightFailed || controller.signal.aborted || sourceRemaining <= 0) {
            if (!preflightFailed) skippedSources.push({ source: provider.source, reason: "The shared read budget expired during source preflight." });
            clearTimeout(abortTimer);
            continue;
          }
          if (remaining <= 0) {
            skippedSources.push({ source: provider.source, reason: "The shared read budget expired during source preflight." });
            clearTimeout(abortTimer);
            continue;
          }
        }
        let statusTimedOut = false;
        let sourceStatus: Awaited<ReturnType<SourceProvider["status"]>> | undefined;
        let result: Observation<unknown>;
        try {
          const statusBudgetMs = Math.max(1, providerBudgetMs - (Date.now() - sourceStartedAt));
          sourceStatus = await withTimeout(provider.status(request.operation, context), statusBudgetMs, () => controller.abort());
        } catch (error) {
          statusTimedOut = true;
          const code = error instanceof TimeoutError ? "timeout" : "provider_status_failed";
          skippedSources.push({ source: provider.source, reason: safeReason(error) });
          errors.push({ source: provider.source, code, message: safeReason(error) });
        }
        if (statusTimedOut || !sourceStatus) {
          clearTimeout(abortTimer);
          continue;
        }
        if (sourceStatus.accountBinding && target && sourceStatus.accountBinding !== target.accountBinding) {
          identityConflicts.push(target);
          skippedSources.push({ source: provider.source, reason: "Provider account does not match the selected target." });
          clearTimeout(abortTimer);
          continue;
        }
        const browserBootstrap = request.operation === "account.inspect" && provider.source === "browser" && sourceStatus.availability !== "ready";
        if (sourceStatus.availability !== "ready" && !browserBootstrap) {
          skippedSources.push({ source: provider.source, reason: sourceStatus.reason ?? `Source is ${sourceStatus.availability}.` });
          errors.push({ source: provider.source, code: sourceStatus.availability, message: sourceStatus.reason ?? `Source is ${sourceStatus.availability}.` });
          clearTimeout(abortTimer);
          continue;
        }
        triedSources.push(provider.source);
        const sourceRemainingMs = Math.max(1, providerBudgetMs - (Date.now() - sourceStartedAt));
        try {
          result = await withTimeout(provider.read(request, context), sourceRemainingMs, () => controller.abort());
        } catch (error) {
          const timeout = error instanceof TimeoutError;
          result = unavailableObservation(provider.source, target?.accountBinding ?? sourceStatus.accountBinding ?? "unresolved", timeout ? "offline" : "offline", safeReason(error), timeout ? "timeout" : "read_failed");
        } finally {
          clearTimeout(abortTimer);
        }
        if (result.source !== provider.source || (target && result.accountBinding !== target.accountBinding)) {
          identityConflicts.push(target ?? { accountBinding: result.accountBinding, explicitOwnerRef: result.nativeRef });
          errors.push({ source: provider.source, code: "identity_conflict", message: "Observation source or account binding does not match its assigned provider." });
          continue;
        }
        observations.push(result);
        errors.push(...result.errors.map((error) => ({ source: result.source, code: error.code ?? result.availability, message: error.message })));
        if (result.availability === "ready" && result.coverage === "complete") break;
      }
      const coverage = aggregateCoverage(observations);
      return { observations, triedSources, identityConflicts, skippedSources, coverage,
        historyCompleteness: aggregateHistory(observations), errors };
    }
  };
}

function hasVerifiableIdentity(target: TargetRef): boolean {
  return Boolean(target.nativeId || target.explicitOwnerRef || validInstagramTargetUrl(target.instagramUrl));
}

function validInstagramTargetUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/(?:direct\/t\/[^/]+|(?:p|reel|tv)\/[^/]+)\/?$/.test(url.pathname);
  } catch { return false; }
}

function aggregateCoverage(observations: Observation<unknown>[]): Observation<unknown>["coverage"] {
  if (!observations.length) return "unknown";
  if (observations.some((item) => item.coverage === "complete" && item.availability === "ready")) return "complete";
  if (observations.some((item) => item.coverage === "partial")) return "partial";
  return "unknown";
}

function aggregateHistory(observations: Observation<unknown>[]): HistoryCompleteness {
  const values = observations.map((item) => item.historyCompleteness).filter((item) => item !== "not_applicable");
  if (!values.length) return observations.length ? "not_applicable" : "unknown";
  if (values.every((item) => item === "complete")) return "complete";
  if (values.some((item) => item === "limited")) return "limited";
  return "unknown";
}

function emptyResult(observations: Observation<unknown>[], triedSources: SourceProvider["source"][], identityConflicts: TargetRef[], skippedSources: RoutedRead["skippedSources"], errors: RoutedRead["errors"]): RoutedRead {
  return { observations, triedSources, identityConflicts, skippedSources, coverage: "unknown", historyCompleteness: "unknown", errors };
}

function unavailableObservation(source: SourceProvider["source"], accountBinding: string, availability: Observation<unknown>["availability"], message: string, code: string): Observation<unknown> {
  return { source, nativeRef: `${source}:unavailable`, accountBinding, capturedAt: new Date().toISOString(),
    availability, coverage: "unknown", historyCompleteness: "unknown", errors: [{ code, message }] };
}

class TimeoutError extends Error { constructor() { super("Source read exceeded the shared time budget."); } }

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError());
    }, timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function safeReason(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : "Source provider failed."; }
