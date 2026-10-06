import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MutationAction, MutationIntent, MutationOptions, MutationPreview, MutationResult, MutationSource, MutationPayload, TargetRef } from "./domain-types.js";
import { fingerprintIntent, MutationSafety, type MutationExecutor } from "./action-safety.js";
import { payloadHash, verifyActionReadback, type ActionReadbackOutcome, type ActionReadbackRecord, type ActionReadbackStore } from "./action-readback.js";

const actions: MutationAction[] = ["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.hide", "comment.show", "comment.delete", "comment.like", "comment.unlike"];
const actionSet = new Set(actions);
const fail = (reason: string): MutationResult => ({ status: "FAILED", reason });

export interface MutationToolHandlers {
  prepare(input: { source: MutationSource; accountBinding: string; action: MutationAction; target: TargetRef; text?: string; reaction?: string }): Promise<MutationPreview | MutationResult>;
  execute(input: MutationOptions & { requestId: string; expectedFingerprint: string; confirm: true }): Promise<MutationResult>;
  reconcile(input: { requestId: string }): Promise<MutationResult & { requestId?: string; source?: MutationSource; action?: MutationAction; target?: TargetRef }>;
  beginOAuth?(): Promise<{ authorizationUrl: string; expiresInSeconds: number }>;
}

export function createMutationToolHandlers(options: { safety: MutationSafety; executors: readonly MutationExecutor[]; readbackStore: ActionReadbackStore; deleteEnabled?: boolean; beginOAuth?: MutationToolHandlers["beginOAuth"]; now?: () => Date }): MutationToolHandlers {
  const executors = new Map(options.executors.map((executor) => [executor.source, executor]));
  const intents = new Map<string, MutationIntent>();
  const now = options.now ?? (() => new Date());
  async function reconcileRecord(record: ActionReadbackRecord): Promise<MutationResult> {
    if (record.status === "observed") return { status: "OBSERVED", ...(record.receiptId ? { receiptId: record.receiptId } : {}), responseState: record.responseState ?? "unknown",
      dispatchStatus: record.dispatchStatus === "ACK" ? "ACK" : "OUTCOME_UNKNOWN" };
    if (record.status === "failed") return fail("The source explicitly rejected this action; no action was retried.");
    let result: MutationResult;
    const executor = executors.get(record.source);
    try {
      if (!executor?.readback) throw new Error("read-back unavailable");
      const evidence = await executor.readback(record);
      const checked = verifyActionReadback(record, evidence);
      result = { ...checked, dispatchStatus: record.dispatchStatus === "ACK" ? "ACK" : "OUTCOME_UNKNOWN" };
      const proof = checked.status === "OBSERVED" ? checked as Extract<ActionReadbackOutcome, { status: "OBSERVED" }> : undefined;
      await options.readbackStore.put({ ...record, status: proof ? "observed" : "unknown",
        ...(proof?.receiptId ? { receiptId: proof.receiptId } : {}), ...(proof?.responseState ? { responseState: proof.responseState } : { responseState: "unknown" }),
        ...(proof?.observedAt ? { observedAt: proof.observedAt } : {}), ...(proof ? {} : { reason: "The exact action was not independently verified." }) });
    } catch {
      result = { status: "OUTCOME_UNKNOWN", reason: "Read-back is unavailable or incomplete; no write was retried.", responseState: "unknown",
        dispatchStatus: record.dispatchStatus === "ACK" ? "ACK" : "OUTCOME_UNKNOWN" };
      await options.readbackStore.put({ ...record, status: "unknown", responseState: "unknown", reason: "Read-back is unavailable or incomplete." }).catch(() => undefined);
    }
    return result;
  }
  return {
    ...(options.beginOAuth ? { beginOAuth: options.beginOAuth } : {}),
    async prepare(input) {
      try {
        if (!input || !actionSet.has(input.action) || input.target.accountBinding !== input.accountBinding) return fail("Mutation target and account binding must match.");
        const payload = payloadFor(input.action, input.text, input.reaction);
        if (!payload) return fail("The exact typed payload required by this action is missing or invalid.");
        const executor = executors.get(input.source);
        if (!executor) return fail("No executor is available for this fixed source.");
        const draft: MutationIntent = { source: input.source, accountBinding: input.accountBinding, action: input.action, target: input.target, payload, contextHash: "prepare" };
        const seed = executor.bindIntent ? await executor.bindIntent(draft) : draft;
        const fresh = await executor.refreshContext(seed);
        if (!fresh.contextHash || stable(fresh.target) !== stable(input.target)) return fail("The exact target could not be freshly verified in the selected source.");
        const intent = { ...seed, contextHash: fresh.contextHash };
        const preview = await options.safety.handle(intent);
        if ("requiresConfirmation" in preview) intents.set(preview.requestId, intent);
        return "requiresConfirmation" in preview && fresh.sideEffects?.length ? { ...preview, sideEffects: [...fresh.sideEffects] } : preview;
      } catch { return fail("Mutation preparation failed closed; no action was dispatched."); }
    },
    async execute(input) {
      const intent = intents.get(input.requestId);
      if (!intent || fingerprintIntent(intent) !== input.expectedFingerprint) return fail("No fresh matching per-item preview is available.");
      if (intent.action === "comment.delete" && options.deleteEnabled !== true) return fail("The separate delete environment gate is disabled.");
      const expectedPayloadHash = payloadHash("text" in intent.payload ? { text: intent.payload.text } : {});
      const record: ActionReadbackRecord = { version: 1, requestId: input.requestId, fingerprint: input.expectedFingerprint,
        source: intent.source, ...(intent.bridgeId ? { bridgeId: intent.bridgeId } : {}), accountBinding: intent.accountBinding,
        action: intent.action, target: intent.target, ...(expectedPayloadHash ? { payloadHash: expectedPayloadHash } : {}),
        attemptedAt: now().toISOString(), status: "pending" };
      try { await options.readbackStore.put(record); } catch { return fail("Private read-back state is unavailable; mutation was not dispatched."); }
      const result = await options.safety.handle(intent, { dryRun: false, confirm: input.confirm, requestId: input.requestId,
        expectedFingerprint: input.expectedFingerprint, deleteConfirmation: input.deleteConfirmation });
      if (!("requiresConfirmation" in result)) intents.delete(input.requestId);
      if ("requiresConfirmation" in result) return result;
      if (result.status === "ACK" || result.status === "OUTCOME_UNKNOWN" || result.status === "OBSERVED") {
        const pending = { ...record, status: "unknown" as const, dispatchStatus: result.status === "ACK" ? "ACK" as const : "OUTCOME_UNKNOWN" as const,
          ...("receiptId" in result && result.receiptId ? { receiptId: result.receiptId } : {}) };
        await options.readbackStore.put(pending).catch(() => undefined);
        return reconcileRecord(pending);
      }
      await options.readbackStore.put({ ...record, status: "failed", dispatchStatus: "FAILED" }).catch(() => undefined);
      return result as MutationResult;
    },
    async reconcile(input) {
      try {
        const record = await options.readbackStore.get(input.requestId);
        if (!record) return fail("No private action receipt exists for this request id.");
        return { ...await reconcileRecord(record), requestId: record.requestId, source: record.source, action: record.action, target: record.target };
      } catch { return { status: "OUTCOME_UNKNOWN", reason: "Private action receipt could not be read; no write was retried.", responseState: "unknown" }; }
    }
  };
}

export function registerMutationTools(server: McpServer, handlers: MutationToolHandlers): void {
  if (handlers.beginOAuth) server.registerTool("meta_begin_oauth", {
    title: "Begin configured Meta authorization",
    description: "Issue a one-time, ten-minute account/mode/redirect-bound OAuth state and return the configured authorization URL to this caller. The URL must be opened only by an authorized client.",
    inputSchema: z.object({}), annotations: { readOnlyHint: false }
  }, async () => json(await handlers.beginOAuth!()));
  server.registerTool("meta_prepare_action", {
    title: "Prepare one Instagram action",
    description: "Prepare one exact source-bound action for review. This does not dispatch it; execution requires the returned requestId and fingerprint.",
    inputSchema: z.object({ source: z.enum(["api", "browser", "phone"]), accountBinding: z.string().min(1).max(128), action: z.enum(actions as [MutationAction, ...MutationAction[]]), target: z.object({ accountBinding: z.string().min(1).max(128), nativeId: z.string().max(512).optional(), instagramUrl: z.string().max(2048).optional(), explicitOwnerRef: z.string().max(512).optional() }), text: z.string().max(10_000).optional(), reaction: z.string().max(64).optional() }),
    annotations: { readOnlyHint: false }
  }, async (args) => json(await handlers.prepare(args)));
  server.registerTool("meta_execute_action", {
    title: "Execute one confirmed Instagram action",
    description: "Execute only the exact fresh preview identified by requestId and fingerprint. Requires confirm=true; comment deletion also requires deleteConfirmation=true.",
    inputSchema: z.object({ requestId: z.string().min(16).max(128), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i), confirm: z.literal(true), deleteConfirmation: z.boolean().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (args) => json(await handlers.execute(args)));
  server.registerTool("meta_reconcile_action", {
    title: "Reconcile one action receipt",
    description: "Read the exact original source and target to verify an uncertain or acknowledged action. This tool is read-only and never retries the action.",
    inputSchema: z.object({ requestId: z.string().min(16).max(128) }),
    annotations: { readOnlyHint: true }
  }, async (args) => json(await handlers.reconcile(args)));
}

function payloadFor(action: MutationAction, text?: string, reaction?: string): MutationPayload | undefined {
  if (["message.send", "comment.reply", "comment.private_reply"].includes(action)) return typeof text === "string" && text.trim() ? { kind: action as "message.send" | "comment.reply" | "comment.private_reply", text } : undefined;
  if (["message.react", "message.unreact"].includes(action)) return typeof reaction === "string" && reaction.trim() ? { kind: action as "message.react" | "message.unreact", reaction } : undefined;
  return { kind: action as "comment.hide" | "comment.show" | "comment.delete" | "comment.like" | "comment.unlike" };
}
function json(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function stable(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stable(row[key])}`).join(",")}}`; }
