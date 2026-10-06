import { createHash } from "node:crypto";
import type { CompanionHub } from "./companion-hub.js";
import type { MutationIntent, MutationResult, MutationSource, Observation, TargetRef } from "./domain-types.js";
import type { MutationAttemptProof, MutationExecutor } from "./action-safety.js";
import type { ApiProvider } from "./api-provider.js";
import type { SourceProvider } from "./source-router.js";
import type { UiApprovalAuthority } from "./ui-approval.js";
import { readbackRequest, type ActionReadbackEvidence, type ActionReadbackRecord } from "./action-readback.js";

export function createMutationExecutors(options: {
  api?: ApiProvider;
  browser?: SourceProvider;
  phone?: SourceProvider;
  hub: CompanionHub;
  authority?: () => Promise<UiApprovalAuthority>;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}): MutationExecutor[] {
  const executors: MutationExecutor[] = [];
  if (options.api) executors.push({
    source: "api",
    async bindIntent(intent) {
      const status = await options.api!.status();
      if (status.capabilities.includes(`${intent.action}:unsupported`)) throw new Error("This action is unsupported by the current Meta API source.");
      if (intent.action === "message.send" && intent.payload.kind === "message.send") return options.api!.direct.prepareSend(intent.target, intent.payload.text);
      if ((intent.action === "message.react" || intent.action === "message.unreact") && intent.payload.kind === intent.action) return options.api!.direct.prepareReaction(intent.target, intent.payload.reaction);
      if ((intent.action === "comment.reply" || intent.action === "comment.private_reply") && intent.payload.kind === intent.action) return options.api!.comments.prepareReply(intent.target, intent.payload.text, intent.action === "comment.private_reply");
      if (["comment.hide", "comment.show", "comment.delete"].includes(intent.action)) return options.api!.comments.prepareAction(intent.target, intent.action);
      return intent;
    },
    refreshContext: (intent) => options.api!.refreshContext(intent),
    async readback(record) {
      const request = readbackRequest(record);
      if (record.source !== "api" || !request) throw new Error("The API source has no read-back for this action.");
      return options.api!.readForAction(request);
    },
    async execute(intent, requestId, contextHash, attempt) {
      if (!attempt?.durableAttempt || attempt.requestId !== requestId) return { status: "FAILED", reason: "A durable MutationSafety attempt is required before API dispatch." };
      return options.api!.execute(intent, requestId, contextHash);
    }
  });
  for (const source of ["browser", "phone"] as const) {
    const provider = source === "browser" ? options.browser : options.phone;
    if (!provider) continue;
    executors.push(uiExecutor(source, provider, options));
  }
  return executors;
}

function uiExecutor(source: "browser" | "phone", provider: SourceProvider, options: {
  hub: CompanionHub; authority?: () => Promise<UiApprovalAuthority>; waitMs?: number; pollMs?: number; now?: () => number;
}): MutationExecutor {
  const waitMs = options.waitMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  return {
    source,
    async readback(record: ActionReadbackRecord): Promise<ActionReadbackEvidence> {
      const request = readbackRequest(record);
      if (record.source !== source || record.bridgeId === undefined || !request) throw new Error("The fixed companion has no read-back for this action.");
      const status = await options.hub.sourceStatus(source, record.accountBinding);
      if (status.availability !== "ready" || status.bridgeId !== record.bridgeId) throw new Error("The original companion is not the same ready source.");
      const observation = await provider.read(request);
      if (observation.source !== source || observation.accountBinding !== record.accountBinding) throw new Error("Companion read-back source or account binding changed.");
      return { observation };
    },
    async bindIntent(intent) {
      const status = await options.hub.sourceStatus(source, intent.accountBinding);
      if (status.availability !== "ready" || !status.bridgeId || !status.capabilities.includes(intent.action)) throw new Error("No ready companion with the requested operation is selected.");
      return { ...intent, bridgeId: status.bridgeId };
    },
    async refreshContext(intent) {
      if (intent.source !== source || intent.target.accountBinding !== intent.accountBinding) throw new Error("mutation source or account binding mismatch");
      if (source === "phone" && provider.refreshContext) {
        const fresh = await provider.refreshContext(intent);
        if (fresh.availability !== "ready" || !fresh.contextHash) throw new Error("the selected phone source has no fresh context for this exact target");
        return { target: fresh.target, contextHash: fresh.contextHash, ...(fresh.sideEffects ? { sideEffects: fresh.sideEffects } : {}) };
      }
      const status = await options.hub.sourceStatus(source, intent.accountBinding);
      if (status.availability !== "ready" || status.bridgeId !== intent.bridgeId || !status.capabilities.includes(intent.action)) throw new Error("The selected companion is no longer the same ready source.");
      const operation = intent.action.startsWith("message.") ? "conversation.read" as const : "comments.list" as const;
      const observation = await provider.read({ operation, target: intent.target, limit: 50 });
      const contextHash = observationContextHash(source, observation, intent.target);
      if (observation.availability !== "ready" || !contextHash) throw new Error("the selected source has no fresh mutation context");
      return { target: intent.target, contextHash, ...(observation.sideEffects ? { sideEffects: observation.sideEffects } : {}) };
    },
    async execute(intent, requestId, contextHash, attempt?: MutationAttemptProof): Promise<MutationResult> {
      if (!attempt?.durableAttempt || attempt.requestId !== requestId) return { status: "FAILED", reason: "A durable MutationSafety attempt is required before a UI task can be created." };
      if (!options.authority) return { status: "FAILED", reason: "The UI approval authority is not configured." };
      const authority = await options.authority();
      options.hub.setApprovalPublicKey(authority.publicKey);
      const task = await options.hub.enqueueApprovedWrite({
        kind: "write", source, bridgeId: intent.bridgeId, accountBinding: intent.accountBinding, operation: intent.action,
        payload: intent.payload, targetRefs: [targetStrings(intent.target)], contextHash, requestId, fingerprint: attempt.fingerprint, ttlMs: 30_000
      }, (pending) => authority.sign(pending));
      const deadline = now() + waitMs;
      while (now() < deadline) {
        const receipt = await options.hub.result(task.id);
        if (receipt.status === "complete") return validResult(receipt.result) ? receipt.result : { status: "OUTCOME_UNKNOWN", reason: "The companion returned an invalid mutation receipt; no retry was made." };
        if (["expired", "outcome_unknown"].includes(receipt.status)) return { status: "OUTCOME_UNKNOWN", reason: "The companion write lease expired or became uncertain; no retry was made." };
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - now()))));
      }
      return { status: "OUTCOME_UNKNOWN", reason: "The companion has not returned a receipt before the bounded wait elapsed; no retry was made." };
    }
  };
}

function observationContextHash(source: MutationSource, observation: Observation<unknown>, target: TargetRef): string | undefined {
  if (!observation.data || observation.coverage === "unknown") return undefined;
  const data = observation.data as Record<string, unknown>;
  if (source === "browser" && typeof data.contextHash === "string" && /^[a-f\d]{16,128}$/i.test(data.contextHash)) return data.contextHash;
  if (source === "phone") return createHash("sha256").update(stable({ account: target.accountBinding, target: safeTarget(target), data }), "utf8").digest("hex");
  return undefined;
}
function targetStrings(target: TargetRef): Record<string, string> {
  return Object.fromEntries(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function safeTarget(target: TargetRef): TargetRef { return { accountBinding: target.accountBinding, ...(target.nativeId ? { nativeId: target.nativeId } : {}), ...(target.instagramUrl ? { instagramUrl: target.instagramUrl } : {}), ...(target.explicitOwnerRef ? { explicitOwnerRef: target.explicitOwnerRef } : {}) }; }
function validResult(value: unknown): value is MutationResult { return Boolean(value && typeof value === "object" && ["ACK", "OBSERVED", "OUTCOME_UNKNOWN", "FAILED"].includes(String((value as { status?: unknown }).status))); }
function stable(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(row[key])}`).join(",")}}`; }
