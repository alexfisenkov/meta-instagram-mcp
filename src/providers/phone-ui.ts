import { createHash } from "node:crypto";
import type { MutationIntent, MutationResult, Observation, TargetRef } from "../domain-types.js";
import type { AppiumReadiness } from "./appium-client.js";
import type { AppiumXmlNode } from "./xml.js";
import { appiumXmlFind, appiumXmlValues, parseAppiumXml } from "./xml.js";

export type PhoneUiOperation =
  | { op: "account.inspect" | "account.snapshot" }
  | { op: "inbox.list"; limit: number }
  | { op: "thread.read"; target: TargetRef; limit: number }
  | { op: "thread.scroll_older"; target: TargetRef; pages: number }
  | { op: "comments.list" | "comments.replies"; target: TargetRef; limit: number }
  | { op: "insights.read"; target?: TargetRef; period?: string }
  | { op: "message.send" | "message.react" | "message.unreact" | "comment.reply" | "comment.private_reply" | "comment.like" | "comment.unlike"; target: TargetRef; payload: Readonly<Record<string, unknown>>; contextHash: string };
export interface PhoneUiClient {
  readiness(): Promise<AppiumReadiness>;
  getSource(): Promise<string>;
  clickSemantic(control: "profile_tab" | "insights_menu" | "insights_entry" | "selected_row" | "comment_like" | "comment_unlike", observedLabel?: string): Promise<void>;
}
export interface PhoneUiProviderOptions {
  client: PhoneUiClient;
  accountBinding: string;
  expectedAccountHandle: string;
  writeEnabled?: boolean;
  now?: () => string;
}
export interface PhoneUiProvider {
  readiness(): Promise<{ availability: AppiumReadiness["availability"]; capabilities: string[]; reason?: string }>;
  observe(operation: PhoneUiOperation): Promise<Observation<unknown>>;
  refreshContext(intent: MutationIntent): Promise<{ target: TargetRef; contextHash: string; availability: Observation<unknown>["availability"] }>;
  execute(intent: MutationIntent, requestId: string, contextHash: string): Promise<MutationResult>;
}

const CAPABILITIES = ["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies", "insights.read", "context.refresh", "comment.like", "comment.unlike"];
const PROFILE_METRICS = new Map([["followers", "followers"], ["following", "following"], ["posts", "posts"]]);
const INSIGHT_COUNTERS = new Set(["Likes", "Comments", "Reposts", "Shares", "Saves"]);
const INSIGHT_SUMMARY: Record<string, string> = { "Views": "views", "Accounts reached": "accounts_reached", "Average watch time": "average_watch_time_seconds", "Follows": "follows" };
const INSIGHT_RATES = ["Skip rate", "Share rate", "Like rate", "Save rate", "Repost rate", "Comment rate"];
const INSIGHT_ACTIONS = ["Profile visits", "Follows", "Bio link taps", "Likes", "Comments", "Reposts", "Shares", "Saves"];

interface Selection { nativeId: string; label: string; signature: string; index: number; node?: AppiumXmlNode; mediaNativeId?: string; mediaTarget?: TargetRef; body?: string }
interface UiCache { byNativeId: Map<string, Selection> }

/** Fail-closed semantic reader and narrow mutation port for one configured Instagram account. */
export function createPhoneUiProvider(options: PhoneUiProviderOptions): PhoneUiProvider {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(options.accountBinding)) throw new Error("invalid phone account binding");
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(options.expectedAccountHandle)) throw new Error("expected Instagram account handle is required");
  const now = options.now ?? (() => new Date().toISOString());
  const threadCache: UiCache = { byNativeId: new Map() };
  const commentCache: UiCache = { byNativeId: new Map() };
  const actionResults = new Map<string, MutationResult>();

  async function readiness() {
    const state = await options.client.readiness();
    return { ...state, capabilities: state.availability === "ready" ? [...CAPABILITIES.filter((capability) => options.writeEnabled || !["comment.like", "comment.unlike"].includes(capability))] : [] };
  }

  async function observe(operation: PhoneUiOperation): Promise<Observation<unknown>> {
    const capturedAt = now();
    const ready = await readiness();
    if (ready.availability !== "ready") return observation(options, capturedAt, ready.availability, "unknown", "unknown", "phone is not ready");
    try {
      const root = await readInstagramTree(options.client);
      if (operation.op === "account.inspect" || operation.op === "account.snapshot") return await accountObservation(root, operation.op, capturedAt);
      if (operation.op === "insights.read") return await insightsObservation(root, operation, capturedAt);
      if (operation.op === "inbox.list") return inboxObservation(root, operation.limit, capturedAt);
      if (operation.op === "thread.read") return await threadObservation(root, operation.target, operation.limit, capturedAt);
      if (operation.op === "comments.list" || operation.op === "comments.replies") return await commentsObservation(root, operation.op, operation.target, operation.limit, capturedAt);
      if (operation.op === "thread.scroll_older") return observation(options, capturedAt, "unsupported", "unknown", "limited", "phone older-history scrolling is not implemented");
      return observation(options, capturedAt, "unsupported", "unknown", "unknown", "phone write operation requires the guarded mutation port");
    } catch (error) {
      return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", safeError(error));
    }
  }

  async function accountObservation(root: AppiumXmlNode, _op: "account.inspect" | "account.snapshot", capturedAt: string): Promise<Observation<unknown>> {
    let values = appiumXmlValues(root);
    if (!isOwnProfile(values, options.expectedAccountHandle)) {
      try {
        await options.client.clickSemantic("profile_tab");
        const fresh = await readInstagramTree(options.client);
        values = appiumXmlValues(fresh);
        if (!isOwnProfile(values, options.expectedAccountHandle)) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "visible profile could not be bound to the configured account");
        root = fresh;
      } catch {
        return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "own profile is not uniquely available in the current UI");
      }
    }
    const profile: Record<string, number> = {};
    for (const value of values) {
      const match = value.match(/^([\d,.\s\u00a0]+)\s+(followers|following|posts)$/i);
      if (!match) continue;
      const key = PROFILE_METRICS.get(match[2]!.toLowerCase());
      const parsed = parseCount(match[1]!);
      if (key && parsed !== undefined) profile[key] = parsed;
    }
    const data = { username: options.expectedAccountHandle, ...profile };
    return makeObservation(options, capturedAt, "ready", "partial", "not_applicable", data, [], `profile:${hash(options.accountBinding).slice(0, 20)}`);
  }

  async function insightsObservation(root: AppiumXmlNode, operation: Extract<PhoneUiOperation, { op: "insights.read" }>, capturedAt: string): Promise<Observation<unknown>> {
    const target = operation.target;
    if (!target || !targetBoundToAccount(target, options.accountBinding)) return observation(options, capturedAt, "unsupported", "unknown", "not_applicable", "insights require a target bound to the configured account");
    let values = appiumXmlValues(root);
    if (!isReelInsights(values)) {
      if (!hasAny(values, ["reels-viewer", "Reel by "]) || !targetMatches(root, target)) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "not_applicable", "current screen is not the selected Reel");
      try {
        await options.client.clickSemantic("insights_menu");
        root = await readInstagramTree(options.client);
        values = appiumXmlValues(root);
        const entry = ["View insights", "Insights"].filter((label) => values.includes(label));
        if (entry.length !== 1) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "not_applicable", "Reel insights menu is missing or ambiguous");
        await options.client.clickSemantic("insights_entry", entry[0]);
        root = await readInstagramTree(options.client);
        values = appiumXmlValues(root);
      } catch { return observation(options, capturedAt, "unsupported_ui_version", "unknown", "not_applicable", "verified Reel insights navigation control is unavailable"); }
    }
    if (!isReelInsights(values)) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "not_applicable", "Reel insights screen signature is not recognized");
    if (!targetMatches(root, target)) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "not_applicable", "selected Reel identity is not visible in the current UI");
    const metrics = extractInsightMetrics(root, values);
    if (!Object.keys(metrics).length) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "not_applicable", "no verified Reel insight labels are visible");
    return makeObservation(options, capturedAt, "ready", "partial", "not_applicable", { scope: "reel", screen: insightScreen(values), target: safeTarget(target), period: operation.period ?? "current_ui_default", metrics }, [{ code: "partial_screen", message: "Only metrics visible on the current insights screen were collected." }], `insights:${hash(`${options.accountBinding}:${targetKey(target)}`).slice(0, 20)}`);
  }

  function inboxObservation(root: AppiumXmlNode, requestedLimit: number, capturedAt: string): Observation<unknown> {
    const screenValues = appiumXmlValues(root);
    if (!screenValues.includes("Messages") && !screenValues.includes("Inbox")) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "inbox screen signature is not recognized");
    const limit = boundedLimit(requestedLimit);
    const rows = visibleRows(root);
    const parsed = rows.map((row, index) => selectionFromRow(row, index, options.accountBinding)).filter((item): item is Selection & { peer: string; preview?: string; unread: boolean | "unknown" } => Boolean(item));
    const counts = new Map<string, number>();
    for (const item of parsed) counts.set(item.peer.toLowerCase(), (counts.get(item.peer.toLowerCase()) ?? 0) + 1);
    const unique = parsed.filter((item) => counts.get(item.peer.toLowerCase()) === 1);
    threadCache.byNativeId.clear();
    for (const item of unique) threadCache.byNativeId.set(item.nativeId, item);
    const truncated = unique.length > limit;
    const threads = unique.slice(0, limit).map((item) => ({
      target: { accountBinding: options.accountBinding, nativeId: item.nativeId },
      peer: item.peer, preview: item.preview, unread: item.unread, unanswered: "unknown" as const
    }));
    const errors = unique.length !== rows.length ? [{ code: "incomplete_inbox_rows", message: "Some visible inbox rows were omitted because their peer identity was unrecognized or ambiguous." }] : [];
    if (truncated) errors.push({ code: "bounded_limit", message: "The inbox result was truncated at the requested limit." });
    return makeObservation(options, capturedAt, "ready", errors.length || truncated ? "partial" : "complete", "limited", { threads }, errors, `inbox:${hash(options.accountBinding).slice(0, 20)}`);
  }

  async function threadObservation(root: AppiumXmlNode, target: TargetRef, requestedLimit: number, capturedAt: string): Promise<Observation<unknown>> {
    if (!targetBoundToAccount(target, options.accountBinding) || !target.nativeId) return observation(options, capturedAt, "unsupported", "unknown", "unknown", "thread target is not bound to this phone account");
    const selection = threadCache.byNativeId.get(target.nativeId);
    if (!selection) return observation(options, capturedAt, "unsupported", "unknown", "unknown", "thread target is stale or was not selected from this companion inbox");
    const current = selectionFromRow(findSelectionRow(root, selection), selection.index, options.accountBinding);
    if (!current || current.signature !== selection.signature || current.nativeId !== target.nativeId) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "selected inbox row changed; refresh the inbox before reading");
    const peers = visibleRows(root).map((row, index) => selectionFromRow(row, index, options.accountBinding)).filter((row) => row?.peer.toLowerCase() === selection.label.toLowerCase());
    if (peers.length !== 1) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "selected inbox peer is ambiguous");
    try { await options.client.clickSemantic("selected_row", selection.label); }
    catch { return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "selected inbox row could not be opened uniquely"); }
    root = await readInstagramTree(options.client);
    const values = appiumXmlValues(root);
    if (!values.some((value) => value.replace(/^@/, "").toLowerCase() === selection.label.replace(/^@/, "").toLowerCase())) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "opened conversation identity did not match the selected inbox peer", ["may_mark_seen"]);
    const rows = visibleRows(root);
    const messages = rows.flatMap((row, index) => {
      const text = directTexts(row).filter((value) => !isUiChrome(value) && !isTimestamp(value));
      if (!text.length) return [];
      const body = text.join(" ").slice(0, 2_000);
      return [{ nativeRef: `phone-message:${hash(`${target.nativeId}:${index}:${body}`).slice(0, 24)}`, text: body, direction: "unknown", timestamp: "unknown" }];
    });
    if (!messages.length) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "message rows are not structurally recognizable", ["may_mark_seen"]);
    const limit = boundedLimit(requestedLimit);
    const truncated = messages.length > limit;
    return makeObservation(options, capturedAt, "ready", "partial", "limited", { target: safeTarget(target), messages: messages.slice(-limit) }, [{ code: "direction_unknown", message: "The mobile screen does not prove message direction or timestamps." }, ...(truncated ? [{ code: "bounded_limit", message: "Conversation history was truncated at the requested limit." }] : [])], `thread:${hash(target.nativeId).slice(0, 20)}`, ["may_mark_seen"]);
  }

  async function commentsObservation(root: AppiumXmlNode, op: "comments.list" | "comments.replies", target: TargetRef, requestedLimit: number, capturedAt: string): Promise<Observation<unknown>> {
    if (!targetBoundToAccount(target, options.accountBinding)) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "selected media identity is not bound to this phone account");
    const selectedReply = op === "comments.replies" ? commentCache.byNativeId.get(target.nativeId ?? "") : undefined;
    const mediaTarget = selectedReply?.mediaTarget ?? target;
    if (!targetMatches(root, mediaTarget)) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "selected media identity is not visible in the current UI");
    const values = appiumXmlValues(root);
    if (!values.includes("Comments") && !values.includes("Comments and replies") && !values.includes("Replies")) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "comments screen signature is not recognized");
    if (op === "comments.replies") {
      const selected = selectedReply;
      if (!selected || selected.mediaNativeId !== targetKey(mediaTarget)) return observation(options, capturedAt, "unsupported", "unknown", "unknown", "comment reply target is stale or not selected from this media");
      const selectedRow = visibleRows(root).map((node, index) => selectionFromComment(node, index, mediaTarget, options.accountBinding)).find((item) => item !== undefined && item.nativeId === target.nativeId && item.signature === selected.signature)?.node;
      if (!selectedRow) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "unknown", "selected comment changed; refresh comments before reading replies");
      const replyRows = selectedRow.children.flatMap((node) => {
        const reply = selectionFromComment(node, 0, mediaTarget, options.accountBinding);
        return reply ? [{ author: reply.author, text: reply.body }] : [];
      });
      if (!replyRows.length) return observation(options, capturedAt, "unsupported_ui_version", "unknown", "limited", "expanded reply rows are not visible under the selected comment");
      const limit = boundedLimit(requestedLimit);
      const truncated = replyRows.length > limit;
      return makeObservation(options, capturedAt, "ready", "partial", "limited", { target: safeTarget(target), replies: replyRows.slice(0, limit) }, [
        { code: "partial_history", message: "Only currently visible replies are included." },
        ...(truncated ? [{ code: "bounded_limit", message: "Replies were truncated at the requested limit." }] : [])
      ], `replies:${hash(target.nativeId ?? "").slice(0, 20)}`);
    }
    const rows = visibleRows(root).map((node, index) => selectionFromComment(node, index, target, options.accountBinding)).filter((row): row is Selection & { author: string; body: string } => Boolean(row));
    const ids = new Set<string>();
    const unique = rows.filter((row) => !ids.has(row.nativeId) && Boolean(ids.add(row.nativeId)));
    commentCache.byNativeId.clear();
    for (const item of unique) commentCache.byNativeId.set(item.nativeId, item);
    const limit = boundedLimit(requestedLimit);
    const truncated = unique.length > limit;
    const errors = unique.length !== rows.length ? [{ code: "incomplete_comment_rows", message: "Some visible comment rows were omitted because their author or text was unrecognized." }] : [];
    if (truncated) errors.push({ code: "bounded_limit", message: "Comments were truncated at the requested limit." });
    return makeObservation(options, capturedAt, "ready", errors.length ? "partial" : "complete", "limited", {
      target: safeTarget(target), comments: unique.slice(0, limit).map((item) => ({ target: { accountBinding: options.accountBinding, nativeId: item.nativeId }, author: item.author, text: item.body }))
    }, errors, `comments:${hash(targetKey(target)).slice(0, 20)}`);
  }

  async function refreshContext(intent: MutationIntent) {
    if (intent.source !== "phone" || intent.accountBinding !== options.accountBinding || !targetBoundToAccount(intent.target, options.accountBinding)) return { target: intent.target, contextHash: "", availability: "unsupported" as const };
    const operation: PhoneUiOperation = intent.action.startsWith("message.")
      ? { op: "thread.read", target: intent.target, limit: 50 }
      : intent.action === "comment.like" || intent.action === "comment.unlike"
        ? { op: "comments.list", target: commentCache.byNativeId.get(intent.target.nativeId ?? "")?.mediaTarget ?? intent.target, limit: 50 }
        : { op: "comments.replies", target: intent.target, limit: 50 };
    const fresh = await observe(operation);
    if (fresh.availability !== "ready" || fresh.coverage === "unknown" || fresh.data === undefined) return { target: intent.target, contextHash: "", availability: fresh.availability };
    return { target: intent.target, contextHash: hash(stableStringify({ account: options.accountBinding, target: safeTarget(intent.target), data: fresh.data })), availability: "ready" as const };
  }

  async function execute(intent: MutationIntent, requestId: string, contextHash: string): Promise<MutationResult> {
    const prior = actionResults.get(requestId);
    if (prior) return prior;
    if (!/^[\w-]{16,128}$/.test(requestId) || intent.source !== "phone" || intent.accountBinding !== options.accountBinding || !options.writeEnabled) return { status: "FAILED", reason: "Phone write gate or request binding is invalid." };
    if (intent.action !== "comment.like" && intent.action !== "comment.unlike") return { status: "FAILED", reason: "This phone UI action has no verified control." };
    const fresh = await refreshContext(intent);
    if (fresh.availability !== "ready" || fresh.contextHash !== contextHash || contextHash !== intent.contextHash) return { status: "FAILED", reason: "Phone target or source context changed after preview." };
    const selected = commentCache.byNativeId.get(intent.target.nativeId ?? "");
    if (!selected || selected.nativeId !== intent.target.nativeId || !selected.mediaTarget || selected.mediaNativeId !== targetKey(selected.mediaTarget)) return { status: "FAILED", reason: "Selected comment identity is no longer available." };
    const button = intent.action === "comment.like" ? "Like" : "Unlike";
    const visible = await currentTree();
    const selectedNode = visibleRows(visible).map((row, index) => ({ row, item: selectionFromComment(row, index, selected.mediaTarget!, options.accountBinding) })).find(({ item }) => item !== undefined && item.nativeId === selected.nativeId && item.signature === selected.signature)?.row;
    const matches = selectedNode ? appiumXmlFind(selectedNode, (node) => isButton(node) && label(node) === button) : [];
    if (matches.length !== 1) return { status: "FAILED", reason: "The exact comment action control is missing or ambiguous." };
    actionResults.set(requestId, { status: "OUTCOME_UNKNOWN", reason: "The action dispatch has no confirmed read-back." });
    try {
      await options.client.clickSemantic(intent.action === "comment.like" ? "comment_like" : "comment_unlike");
      const result: MutationResult = { status: "OUTCOME_UNKNOWN", reason: "The phone action was dispatched once; delivery was not independently verified." };
      actionResults.set(requestId, result);
      return result;
    } catch (error) {
      const result: MutationResult = error instanceof Error && "outcomeUnknown" in error && error.outcomeUnknown
        ? { status: "OUTCOME_UNKNOWN", reason: "The phone action dispatch outcome is uncertain; no retry was made." }
        : { status: "FAILED", reason: "The exact phone action control rejected the request before dispatch." };
      actionResults.set(requestId, result);
      return result;
    }
  }

  return { readiness, observe, refreshContext, execute };

  async function currentTree(): Promise<AppiumXmlNode> { return readInstagramTree(options.client); }
}

function observation(options: PhoneUiProviderOptions, capturedAt: string, availability: Observation<unknown>["availability"], coverage: Observation<unknown>["coverage"], historyCompleteness: Observation<unknown>["historyCompleteness"], message: string, sideEffects?: Array<"may_mark_seen">): Observation<unknown> {
  return { source: "phone", nativeRef: `phone:unavailable:${hash(`${options.accountBinding}:${capturedAt}`).slice(0, 20)}`, accountBinding: options.accountBinding, capturedAt, availability, coverage, historyCompleteness, errors: [{ code: availability, message }], ...(sideEffects ? { sideEffects } : {}) };
}

function makeObservation(options: PhoneUiProviderOptions, capturedAt: string, availability: Observation<unknown>["availability"], coverage: Observation<unknown>["coverage"], historyCompleteness: Observation<unknown>["historyCompleteness"], data: unknown, errors: Array<{ code?: string; message: string }>, nativeRef: string, sideEffects?: Array<"may_mark_seen">): Observation<unknown> {
  return { source: "phone", nativeRef, accountBinding: options.accountBinding, capturedAt, availability, coverage, historyCompleteness, data, errors, ...(sideEffects ? { sideEffects } : {}) };
}

async function readInstagramTree(client: PhoneUiClient): Promise<AppiumXmlNode> {
  const root = parseAppiumXml(await client.getSource());
  const apps = appiumXmlFind(root, (node) => node.tag === "XCUIElementTypeApplication" && ["instagram", "com.burbn.instagram"].includes(normalize(label(node))));
  const packageNames = appiumXmlFind(root, (node) => Boolean(node.attributes.package)).map((node) => node.attributes.package!);
  const androidApp = packageNames.length > 0 && new Set(packageNames).size === 1 && packageNames[0] === "com.instagram.android";
  if (apps.length !== 1 && !androidApp) throw new Error("current Appium source does not prove a single Instagram app screen");
  return root;
}

function isOwnProfile(values: string[], handle: string): boolean {
  const normalized = values.map(normalize);
  const exactHandle = normalized.includes(handle.toLowerCase()) || normalized.includes(`@${handle.toLowerCase()}`);
  return exactHandle && normalized.some((value) => ["edit profile", "share profile"].includes(value));
}

function isReelInsights(values: string[]): boolean { return values.includes("Reel insights") && (values.includes("Overview") || values.includes("Summary")); }
function insightScreen(values: string[]): string { return values.includes("Actions after viewing") ? "engagement" : values.includes("Who viewed your reel") ? "audience" : "overview"; }

function extractInsightMetrics(root: AppiumXmlNode, values: string[]): Record<string, { value: number | string; unit: string; label: string }> {
  const rows = appiumXmlFind(root, () => true).map((node, index) => ({ node, index, text: label(node), ...geometry(node) })).filter((row) => row.text && row.node.attributes.visible !== "false");
  const metrics: Record<string, { value: number | string; unit: string; label: string }> = {};
  const add = (key: string, labelText: string, raw: string, unit: string) => {
    const parsed = unit === "percent" ? parsePercent(raw) : unit === "seconds" ? parseSeconds(raw) : parseCount(raw);
    if (parsed !== undefined) metrics[key] = { value: parsed, unit, label: labelText };
  };
  for (const row of rows) {
    const counter = row.text.match(/^([\d,\s\u00a0]+)\s+(Likes|Comments|Reposts|Shares|Saves)$/);
    if (counter && INSIGHT_COUNTERS.has(counter[2]!)) add(counter[2]!.toLowerCase(), counter[2]!, counter[1]!, "count");
  }
  for (const [labelText, key] of Object.entries(INSIGHT_SUMMARY)) {
    const base = rows.find((row) => row.text === labelText);
    if (!base) continue;
    const below = rows.filter((row) => row.y > base.y && row.y <= base.y + 55 && Math.abs(row.x - base.x) <= 16 && row.text !== labelText).sort((a, b) => a.y - b.y)[0];
    if (below) add(key, labelText, below.text, key.endsWith("seconds") ? "seconds" : "count");
  }
  for (const labelText of [...INSIGHT_RATES, ...INSIGHT_ACTIONS]) {
    const base = rows.find((row) => row.text === labelText);
    if (!base) continue;
    let value: (typeof rows)[number] | undefined = rows.filter((row) => row.x >= 300 && row.text !== labelText && row.y >= base.y - 2 && row.y <= base.y + 36 && Math.abs((row.y + row.height / 2) - (base.y + base.height / 2)) <= 26).sort((a, b) => a.x - b.x)[0];
    if (!value) value = rows.find((row) => row.x >= 300 && base.y <= row.y && row.y <= base.y + 36);
    if (value) {
      const percent = labelText.toLowerCase().endsWith("rate");
      add(slug(labelText), labelText, value.text, percent ? "percent" : "count");
    }
  }
  return metrics;
}


function selectionFromRow(node: AppiumXmlNode, index: number, accountBinding: string): (Selection & { peer: string; preview?: string; unread: boolean | "unknown" }) | undefined {
  const texts = directTexts(node);
  const peerMatches = texts.filter((value) => /^@[\p{L}\p{N}._]{1,30}$/u.test(value));
  if (peerMatches.length !== 1) return undefined;
  const peer = peerMatches[0]!;
  const previews = texts.filter((value) => value !== peer && !isUiChrome(value) && !isTimestamp(value));
  const preview = previews[previews.length - 1]?.slice(0, 500);
  const signature = hash(stableStringify({ tag: node.tag, peer, texts }));
  const nativeId = `phone-thread:${hash(`${accountBinding}:${index}:${peer}`).slice(0, 28)}`;
  const unread = texts.some((value) => /^(unread|new message)$/i.test(value)) ? true : texts.some((value) => /^(read|seen)$/i.test(value)) ? false : "unknown";
  return { nativeId, label: peer, peer, preview, unread, signature, index };
}

function selectionFromComment(node: AppiumXmlNode, index: number, media: TargetRef, accountBinding: string): (Selection & { author: string; body: string }) | undefined {
  const texts = commentTexts(node);
  const authors = texts.filter((value) => /^@[\p{L}\p{N}._]{1,30}$/u.test(value));
  if (authors.length !== 1) return undefined;
  const body = texts.filter((value) => value !== authors[0] && !isUiChrome(value) && !isTimestamp(value)).join(" ").slice(0, 2_000);
  if (!body) return undefined;
  const signature = hash(stableStringify({ tag: node.tag, texts }));
  return { nativeId: `phone-comment:${hash(`${accountBinding}:${targetKey(media)}:${index}:${authors[0]}`).slice(0, 28)}`, label: authors[0]!, author: authors[0]!, body, signature, index, node, mediaNativeId: targetKey(media), mediaTarget: safeTarget(media) };
}

function commentTexts(node: AppiumXmlNode): string[] {
  const values: string[] = [];
  const visit = (current: AppiumXmlNode, root: boolean) => {
    if (!root) {
      const nested = directTexts(current);
      const authors = nested.filter((value) => /^@[\p{L}\p{N}._]{1,30}$/u.test(value));
      if (authors.length === 1 && nested.some((value) => value !== authors[0] && !isUiChrome(value) && !isTimestamp(value))) return;
    }
    const value = label(current).trim();
    if (value && !values.includes(value)) values.push(value);
    current.children.forEach((child) => visit(child, false));
  };
  visit(node, true);
  return values;
}

function visibleRows(root: AppiumXmlNode): AppiumXmlNode[] {
  return appiumXmlFind(root, (node) => ["XCUIElementTypeCell", "android.view.ViewGroup"].includes(node.tag) && node.attributes.visible !== "false");
}
function findSelectionRow(root: AppiumXmlNode, selection: Selection): AppiumXmlNode {
  return visibleRows(root)[selection.index] ?? { tag: "missing", attributes: {}, children: [], text: "" };
}
function directTexts(node: AppiumXmlNode): string[] {
  const values: string[] = [];
  const visit = (current: AppiumXmlNode) => {
    const value = label(current).trim();
    if (value && !values.includes(value)) values.push(value);
    current.children.forEach(visit);
  };
  visit(node);
  return values;
}
function label(node: AppiumXmlNode): string { return first(node.attributes.value, node.attributes.label, node.attributes.name, node.attributes["content-desc"], node.text); }
function first(...values: Array<string | undefined>): string { return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? ""; }
function geometry(node: AppiumXmlNode): { x: number; y: number; width: number; height: number } {
  return { x: finite(node.attributes.x), y: finite(node.attributes.y), width: finite(node.attributes.width), height: finite(node.attributes.height) };
}
function finite(value: string | undefined): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function parseCount(value: string): number | undefined { const clean = value.replace(/[\s\u00a0,]/g, ""); return /^\d+$/.test(clean) ? Number(clean) : undefined; }
function parseSeconds(value: string): number | undefined { const match = value.trim().match(/^([\d,\s\u00a0]+)s$/); return match ? parseCount(match[1]!) : undefined; }
function parsePercent(value: string): number | undefined { const match = value.trim().match(/^([\d.]+)%$/); return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : undefined; }
function slug(value: string): string { return value.toLowerCase().replace(/[ -/]+/g, "_"); }
function normalize(value: string): string { return value.trim().toLowerCase(); }
function hasAny(values: string[], expected: string[]): boolean { return expected.some((item) => values.some((value) => value === item || value.includes(item))); }
function targetBoundToAccount(target: TargetRef, binding: string): boolean { return target.accountBinding === binding && Boolean(target.nativeId || target.instagramUrl || target.explicitOwnerRef); }
function targetKey(target: TargetRef): string { return target.nativeId ?? target.explicitOwnerRef ?? extractShortcode(target.instagramUrl) ?? ""; }
function targetMatches(root: AppiumXmlNode, target: TargetRef): boolean {
  const exact = targetKey(target);
  if (!exact) return false;
  return appiumXmlFind(root, (node) => [node.attributes.name, node.attributes.label, node.attributes.value, node.attributes["resource-id"], node.attributes["content-desc"]].some((value) => value === exact)).length > 0;
}
function extractShortcode(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["instagram.com", "www.instagram.com"].includes(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/^\/(?:reel|reels|p)\/([A-Za-z0-9_-]{1,64})\/?$/);
    return match?.[1];
  } catch { return undefined; }
}
function safeTarget(target: TargetRef): TargetRef { return { accountBinding: target.accountBinding, ...(target.nativeId ? { nativeId: target.nativeId } : {}), ...(target.explicitOwnerRef ? { explicitOwnerRef: target.explicitOwnerRef } : {}), ...(target.instagramUrl ? { instagramUrl: target.instagramUrl } : {}) }; }
function isButton(node: AppiumXmlNode): boolean { return /Button$|button/i.test(node.tag) || node.attributes["class"]?.toLowerCase().includes("button") === true; }
function isTimestamp(value: string): boolean { return /^(\d{1,2}:\d{2}|\d+\s*(m|min|h|d|w|mo|y)s?\s*ago|yesterday)$/i.test(value); }
function isUiChrome(value: string): boolean { return /^(messages|inbox|comments|replies|like|reply|send|seen|read|unread|active now|view replies|more)$/i.test(value); }
function boundedLimit(value: number): number { return Number.isInteger(value) ? Math.max(1, Math.min(50, value)) : 20; }
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeError(_error: unknown): string { return "Appium source is malformed, oversized, or belongs to an unknown Instagram UI state."; }
