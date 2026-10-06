import type { Availability, Coverage, HistoryCompleteness, MutationAction, Observation, SourceId, TargetRef } from "./domain-types.js";
import type { ReadRequest, RoutedRead, SourceRouter, SourceProvider } from "./source-router.js";
import type { ActionReadbackStore } from "./action-readback.js";

export type Truth = true | false | "unknown";
export interface ReviewQueueItem {
  threadRef?: TargetRef;
  commentRef?: TargetRef;
  source: SourceId;
  coverage: Coverage;
  latestInbound?: { nativeId: string; capturedAt?: string; direction: "inbound" | "unknown"; text?: string };
  unread: Truth;
  unanswered: Truth;
  state: "needs_review" | "answered" | "unknown";
  lastAction?: { action: MutationAction; status: "observed" | "unknown"; dispatchStatus: "ACK" | "OUTCOME_UNKNOWN"; responseState: "answered" | "unknown"; attemptedAt: string; observedAt?: string };
}
export interface ReviewQueue {
  items: ReviewQueueItem[];
  triedSources: SourceId[];
  truncated: boolean;
  coverage: Coverage;
  limitations: string[];
}
export interface AnalysisInput { selectedObservations: Observation<unknown>[]; promptVersion: string }
export interface AnalysisOutput {
  summary: string;
  themes: string[];
  actionsDraft: Array<{ target: TargetRef; source: SourceId; exactReply: string; rationale?: string }>;
  limitations: string[];
  sourceRefs: Array<{ source: SourceId; nativeRef: string; coverage: Coverage }>;
  stats: {
    counts: Record<string, number | "unknown">;
    ages: Record<string, number | "unknown">;
    inboundOutbound: Record<string, number | "unknown">;
    ownerReplies: Record<string, number | "unknown">;
    commentLikesHidden: Record<string, number | "unknown">;
    sourceCoverage: Record<string, Coverage>;
  };
}
export interface HostAnalysisPort { analyze(input: AnalysisInput): Promise<AnalysisOutput> }
export interface LayeredToolHandlers {
  capabilities(): Promise<CapabilityReport>;
  readSource(input: ReadRequest): Promise<RoutedRead>;
  triageInbox(input: { source: "auto"; limit: number; cursor?: string }): Promise<ReviewQueue>;
  readInbox(input: { source: "auto"; limit: number; cursor?: string }): Promise<ReviewQueue>;
  analyzeInbox(input: AnalysisInput): Promise<AnalysisOutput>;
}
export interface CapabilityReport {
  version: 1;
  verification: "runtime_status_only";
  sources: Array<{ source: SourceId; availability: Availability; reason?: string; capabilities: string[] }>;
  operations: Array<{ operation: ReadRequest["operation"]; sources: Array<{ source: SourceId; status: Availability; reason?: string }> }>;
}
export interface LayeredToolOptions { router: SourceRouter; hostAnalysis?: HostAnalysisPort; actionReadbacks?: Pick<ActionReadbackStore, "latestFor">; now?: () => Date }

const READ_OPERATIONS: ReadRequest["operation"][] = ["account.inspect", "inbox.list", "conversation.read", "comments.list", "comments.replies", "insights.read"];
const LIMIT_MAX = 100;

export function createLayeredToolHandlers(options: LayeredToolOptions): LayeredToolHandlers {
  const now = options.now ?? (() => new Date());
  async function queue(input: { source: "auto"; limit: number; cursor?: string }): Promise<ReviewQueue> {
    const limit = boundedLimit(input.limit);
    const request: ReadRequest = { operation: "inbox.list", limit, ...(input.cursor ? { cursor: input.cursor } : {}) };
    const routed = await options.router.read(request);
    const allItems = routed.observations.flatMap(observationToItems);
    const items = await Promise.all(allItems.slice(0, limit).map(async (item) => {
      const target = item.threadRef ?? item.commentRef;
      if (!target || !options.actionReadbacks || item.source === "user_supplied") return item;
      const last = await options.actionReadbacks.latestFor(item.source, target).catch(() => undefined);
      if (!last || !["message.send", "comment.reply"].includes(last.action) || last.status === "failed" || last.status === "pending") return item;
      return { ...item, lastAction: { action: last.action, status: last.status === "observed" ? "observed" as const : "unknown" as const,
        dispatchStatus: last.dispatchStatus === "ACK" ? "ACK" as const : "OUTCOME_UNKNOWN" as const,
        responseState: last.responseState ?? "unknown", attemptedAt: last.attemptedAt, ...(last.observedAt ? { observedAt: last.observedAt } : {}) } };
    }));
    const limitations = [...routed.skippedSources.map((item) => `${item.source}: ${item.reason}`),
      ...routed.errors.map((item) => `${item.source}: ${item.message}`)];
    if (routed.coverage !== "complete" && !limitations.length) limitations.push("Source coverage is incomplete; remaining items may be unknown.");
    return { items, triedSources: [...routed.triedSources], truncated: allItems.length > limit || routed.coverage !== "complete",
      coverage: routed.coverage, limitations: [...new Set(limitations)].slice(0, 24) };
  }
  return {
    async readSource(input) {
      if ((input.operation === "conversation.read" || input.operation === "comments.list" || input.operation === "comments.replies") && !input.target) throw new Error("This read operation requires one exact selected target.");
      return options.router.read(input);
    },
    async capabilities() {
      const sources = await options.router.status();
      const operations = await Promise.all(READ_OPERATIONS.map(async (operation) => {
        const statuses = await options.router.status(operation);
        return { operation, sources: statuses.map((item) => ({ source: item.source, status: item.availability, ...(item.reason ? { reason: item.reason } : {}) })) };
      }));
      return { version: 1, verification: "runtime_status_only", sources, operations };
    },
    triageInbox: queue,
    readInbox: queue,
    async analyzeInbox(input) {
      validateAnalysisInput(input);
      const deterministic = deterministicStats(input.selectedObservations, now());
      const sourceRefs = uniqueSourceRefs(input.selectedObservations);
      if (!options.hostAnalysis) {
        return { summary: "Connected host analysis is not configured; no themes or reply drafts were generated.", themes: [], actionsDraft: [],
          limitations: ["Host analysis is unavailable; deterministic statistics use selected observations only."], sourceRefs, stats: deterministic };
      }
      const result = await options.hostAnalysis.analyze({ selectedObservations: input.selectedObservations.map((item) => structuredClone(item)), promptVersion: input.promptVersion });
      validateHostOutput(result, input.selectedObservations);
      return { ...result, sourceRefs: result.sourceRefs, stats: deterministic,
        limitations: [...new Set([...result.limitations, "Host-provided statistics were ignored; deterministic values use selected observations only."])].slice(0, 50) };
    }
  };
}

function observationToItems(observation: Observation<unknown>): ReviewQueueItem[] {
  const data = isRecord(observation.data) ? observation.data : {};
  const rows = Array.isArray(data.items) ? data.items
    : Array.isArray(data.conversations) ? data.conversations
      : Array.isArray(data.threads) ? data.threads : [];
  const output: ReviewQueueItem[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const nestedTarget = isRecord(raw.target) ? raw.target : undefined;
    const id = firstString(raw.id, raw.threadId, raw.conversationId, raw.commentId,
      typeof nestedTarget?.nativeId === "string" ? nestedTarget.nativeId : undefined);
    const target = id ? { accountBinding: observation.accountBinding, nativeId: id } : undefined;
    const isComment = typeof raw.commentId === "string";
    const latestRaw = firstRecord(raw.latestInbound, raw.latestMessage, raw.latestComment, latestMessage(raw.messages));
    const direction = latestRaw?.direction === "inbound" ? "inbound" : "unknown";
    const latestInbound = latestRaw && direction === "inbound" && typeof latestRaw.id === "string"
      ? { nativeId: latestRaw.id, ...(typeof latestRaw.createdAt === "string" ? { capturedAt: latestRaw.createdAt } : {}), direction: "inbound" as const,
        ...(typeof latestRaw.text === "string" ? { text: latestRaw.text } : {}) }
      : undefined;
    const explicitUnanswered = truth(raw.unanswered);
    const unanswered: Truth = explicitUnanswered ?? deriveUnanswered(latestRaw, observation.historyCompleteness);
    output.push({ ...(target ? isComment ? { commentRef: target } : { threadRef: target } : {}), source: observation.source,
      coverage: observation.coverage, ...(latestInbound ? { latestInbound } : {}), unread: truth(raw.unread) ?? "unknown", unanswered,
      state: unanswered === true ? "needs_review" : unanswered === false ? "answered" : "unknown" });
  }
  return output;
}

function deriveUnanswered(latest: Record<string, unknown> | undefined, completeness: HistoryCompleteness): Truth {
  if (!latest || completeness !== "complete") return "unknown";
  if (latest.direction === "inbound") return true;
  if (latest.direction === "outbound") return false;
  return "unknown";
}

function deterministicStats(observations: Observation<unknown>[], now: Date): AnalysisOutput["stats"] {
  const rows = observations.flatMap((observation) => {
    const data = isRecord(observation.data) ? observation.data : {};
    return (Array.isArray(data.items) ? data.items : Array.isArray(data.messages) ? data.messages : []).filter(isRecord).map((row) => ({ observation, row }));
  });
  const countKnown = (key: string): number | "unknown" => {
    const values = rows.map(({ row }) => truth(row[key]));
    return values.some((value) => value !== undefined) ? values.filter((value) => value === true).length : "unknown";
  };
  const timestamps = observations.flatMap((observation) => {
    const data = isRecord(observation.data) ? observation.data : {};
    const candidates = [...(Array.isArray(data.items) ? data.items : []), ...(Array.isArray(data.messages) ? data.messages : [])];
    return candidates.filter(isRecord).map((row) => firstString(row.createdAt, row.timestamp, row.updatedAt)).map((value) => value ? Date.parse(value) : Number.NaN).filter(Number.isFinite);
  });
  const directions = rows.map(({ row }) => row.direction);
  const counts: Record<string, number | "unknown"> = {
    observations: observations.length,
    threads: rows.length,
    unread: countKnown("unread"),
    unanswered: countKnown("unanswered"),
    inbound: directions.some((value) => value === "inbound" || value === "outbound") ? directions.filter((value) => value === "inbound").length : "unknown",
    outbound: directions.some((value) => value === "inbound" || value === "outbound") ? directions.filter((value) => value === "outbound").length : "unknown"
  };
  const messageDirectionKnown = directions.some((value) => value === "inbound" || value === "outbound");
  const ownerReplies: Record<string, number | "unknown"> = { outboundMessages: messageDirectionKnown ? directions.filter((value) => value === "outbound").length : "unknown" };
  const commentRows = rows.filter(({ row }) => "like_count" in row || "hidden" in row);
  const commentLikesHidden: Record<string, number | "unknown"> = {
    likes: commentRows.some(({ row }) => typeof row.like_count === "number") ? sumNumeric(commentRows.map(({ row }) => row.like_count)) : "unknown",
    hidden: commentRows.some(({ row }) => typeof row.hidden === "boolean") ? commentRows.filter(({ row }) => row.hidden === true).length : "unknown"
  };
  const sourceCoverage: Record<string, Coverage> = {};
  for (const observation of observations) sourceCoverage[observation.source] = combineCoverage(sourceCoverage[observation.source], observation.coverage);
  return { counts, ages: { oldestObservedMs: timestamps.length ? Math.max(0, now.getTime() - Math.min(...timestamps)) : "unknown",
    newestObservedMs: timestamps.length ? Math.max(0, now.getTime() - Math.max(...timestamps)) : "unknown" },
    inboundOutbound: { inbound: counts.inbound, outbound: counts.outbound }, ownerReplies, commentLikesHidden, sourceCoverage };
}

function uniqueSourceRefs(observations: Observation<unknown>[]): AnalysisOutput["sourceRefs"] {
  const seen = new Set<string>();
  return observations.filter((item) => {
    const key = `${item.source}\0${item.nativeRef}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(({ source, nativeRef, coverage }) => ({ source, nativeRef, coverage }));
}

function validateAnalysisInput(input: AnalysisInput): void {
  if (!input || !Array.isArray(input.selectedObservations) || input.selectedObservations.length > 100 ||
      typeof input.promptVersion !== "string" || input.promptVersion.length < 1 || input.promptVersion.length > 120) throw new Error("Analysis input is invalid or exceeds its bound.");
  for (const observation of input.selectedObservations) {
    if (!observation || !["api", "browser", "phone", "user_supplied"].includes(observation.source) ||
        typeof observation.nativeRef !== "string" || typeof observation.accountBinding !== "string" || !Array.isArray(observation.errors)) throw new Error("Selected observation is invalid.");
  }
}

function validateHostOutput(value: AnalysisOutput, selected: Observation<unknown>[]): void {
  if (!isRecord(value) || typeof value.summary !== "string" || value.summary.length > 20_000 || !stringArray(value.themes, 100) ||
      !Array.isArray(value.actionsDraft) || value.actionsDraft.length > 100 || !stringArray(value.limitations, 100) ||
      !Array.isArray(value.sourceRefs) || !isRecord(value.stats)) throw new Error("Connected host analysis returned an invalid structured result.");
  const selectedByRef = new Map(selected.map((item) => [`${item.source}\0${item.nativeRef}`, item]));
  for (const ref of value.sourceRefs) {
    if (!isRecord(ref)) throw new Error("Connected host analysis referenced an invalid observation.");
    const item = selectedByRef.get(`${String(ref.source)}\0${String(ref.nativeRef)}`);
    if (!item || ref.coverage !== item.coverage) throw new Error("Connected host analysis referenced an unselected or altered observation.");
  }
  for (const draft of value.actionsDraft) {
    if (!isRecord(draft) || typeof draft.exactReply !== "string" || !draft.exactReply.trim() || draft.exactReply.length > 10_000 ||
        !["api", "browser", "phone"].includes(String(draft.source)) || !isRecord(draft.target) ||
        typeof draft.target.accountBinding !== "string" || !targetHasIdentity(draft.target as unknown as TargetRef)) throw new Error("Connected host analysis returned an invalid action draft.");
    const target = draft.target as unknown as TargetRef;
    const sourceMatch = selected.some((item) => item.source === draft.source && item.accountBinding === target.accountBinding &&
      targetIsSelected(item, target));
    if (!sourceMatch) throw new Error("Action draft is not bound to a selected source and account.");
  }
}

function targetHasIdentity(target: TargetRef): boolean {
  if (target.nativeId || target.explicitOwnerRef) return true;
  if (!target.instagramUrl) return false;
  try {
    const url = new URL(target.instagramUrl);
    return url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}
function targetIsSelected(observation: Observation<unknown>, target: TargetRef): boolean {
  if (target.nativeId && target.nativeId === observation.nativeRef) return true;
  if (target.explicitOwnerRef && target.explicitOwnerRef === observation.nativeRef) return true;
  if (!isRecord(observation.data)) return false;
  const data = observation.data;
  const rows = [...(Array.isArray(data.items) ? data.items : []), ...(Array.isArray(data.messages) ? data.messages : []),
    ...(Array.isArray(data.comments) ? data.comments : []), ...(Array.isArray(data.conversations) ? data.conversations : [])];
  return rows.some((row) => isRecord(row) && ((target.nativeId && [row.id, row.nativeId, row.threadId, row.conversationId, row.commentId].includes(target.nativeId)) ||
    (target.explicitOwnerRef && Array.isArray(row.ownerRefs) && row.ownerRefs.includes(target.explicitOwnerRef)) ||
    (target.instagramUrl && row.instagramUrl === target.instagramUrl)));
}
function truth(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function latestMessage(value: unknown): Record<string, unknown> | undefined { return Array.isArray(value) ? value.filter(isRecord).sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt))[0] : undefined; }
function dateValue(value: unknown): number { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : -1; }
function firstString(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === "string" && value.length > 0); }
function firstRecord(...values: unknown[]): Record<string, unknown> | undefined { return values.find(isRecord); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringArray(value: unknown, max: number): value is string[] { return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string"); }
function sumNumeric(values: unknown[]): number { return values.reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0); }
function boundedLimit(value: number): number { return Number.isInteger(value) && value > 0 ? Math.min(LIMIT_MAX, value) : 20; }
function combineCoverage(left: Coverage | undefined, right: Coverage): Coverage { return left === "complete" || right === "complete" ? "complete" : left === "partial" || right === "partial" ? "partial" : "unknown"; }
