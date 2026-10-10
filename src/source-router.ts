import type { Availability, HistoryCompleteness, MutationIntent, Observation, SourceId, TargetRef } from "./domain-types.js";
import type { ApiReadRequest } from "./api-provider.js";

export type ReadRequest = ApiReadRequest;

export interface SourceProvider {
  readonly source: Exclude<SourceId, "user_supplied">;
  status(operation?: ReadRequest["operation"]): Promise<{ source: SourceId; availability: Availability; capabilities: string[]; reason?: string; accountBinding?: string }>;
  /** Optional bounded, read-only source bootstrap before the requested read. */
  prepareRead?(request: ReadRequest): Promise<void>;
  read(request: ReadRequest): Promise<Observation<unknown>>;
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

/** Bounded read-only fallback. Observations stay attributed; this router never merges records. */
export function createSourceRouter(options: SourceRouterOptions): SourceRouter {
  // Windows companion tasks can each wait 30s; auto-read may need one account probe plus one actual read.
  const timeoutMs = options.timeoutMs ?? (process.platform === "win32" ? 60_000 : 12_000);
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

      const ordered = PRIORITY.map((source) => bySource.get(source)).filter((item): item is SourceProvider => Boolean(item)).slice(0, maxProviders);
      for (const provider of ordered) {
        let remaining = deadline - Date.now();
        if (remaining <= 0) {
          skippedSources.push({ source: provider.source, reason: "The shared read budget expired." });
          continue;
        }
        if (provider.prepareRead) {
          let preflightFailed = false;
          try {
            await withTimeout(provider.prepareRead(request), remaining);
          } catch (error) {
            preflightFailed = true;
            const code = error instanceof TimeoutError ? "preflight_timeout" : "preflight_failed";
            errors.push({ source: provider.source, code, message: safeReason(error) });
            skippedSources.push({ source: provider.source, reason: "Source did not pass its required read preflight." });
          }
          if (preflightFailed) continue;
          remaining = deadline - Date.now();
          if (remaining <= 0) {
            skippedSources.push({ source: provider.source, reason: "The shared read budget expired during source preflight." });
            continue;
          }
        }
        let sourceStatus;
        try { sourceStatus = await withTimeout(provider.status(request.operation), remaining); }
        catch (error) {
          const code = error instanceof TimeoutError ? "timeout" : "provider_status_failed";
          skippedSources.push({ source: provider.source, reason: safeReason(error) });
          errors.push({ source: provider.source, code, message: safeReason(error) });
          continue;
        }
        if (sourceStatus.accountBinding && target && sourceStatus.accountBinding !== target.accountBinding) {
          identityConflicts.push(target);
          skippedSources.push({ source: provider.source, reason: "Provider account does not match the selected target." });
          continue;
        }
        const browserBootstrap = request.operation === "account.inspect" && provider.source === "browser" && sourceStatus.availability !== "ready";
        if (sourceStatus.availability !== "ready" && !browserBootstrap) {
          skippedSources.push({ source: provider.source, reason: sourceStatus.reason ?? `Source is ${sourceStatus.availability}.` });
          errors.push({ source: provider.source, code: sourceStatus.availability, message: sourceStatus.reason ?? `Source is ${sourceStatus.availability}.` });
          continue;
        }
        triedSources.push(provider.source);
        let result: Observation<unknown>;
        try {
          result = await withTimeout(provider.read(request), Math.max(1, deadline - Date.now()));
        } catch (error) {
          const timeout = error instanceof TimeoutError;
          result = unavailableObservation(provider.source, target?.accountBinding ?? sourceStatus.accountBinding ?? "unresolved", timeout ? "offline" : "offline", safeReason(error), timeout ? "timeout" : "read_failed");
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function safeReason(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : "Source provider failed."; }
