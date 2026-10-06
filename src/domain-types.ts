export type SourceId = "api" | "browser" | "phone" | "user_supplied";
export type MutationSource = Exclude<SourceId, "user_supplied">;
export type Availability = "ready" | "permission_blocked" | "missing_scope" | "offline" |
  "not_connected" | "unsupported" | "unsupported_ui_version" | "needs_selection";
export type Coverage = "complete" | "partial" | "unknown";
export type HistoryCompleteness = "complete" | "limited" | "unknown" | "not_applicable";

export interface TargetRef {
  accountBinding: string;
  nativeId?: string;
  instagramUrl?: string;
  explicitOwnerRef?: string;
}

export interface Observation<T> {
  source: SourceId;
  nativeRef: string;
  accountBinding: string;
  capturedAt: string;
  availability: Availability;
  coverage: Coverage;
  historyCompleteness: HistoryCompleteness;
  limits?: { maxMessagesPerConversation?: 20; requestsInactiveDays?: 30 };
  sideEffects?: Array<"may_mark_seen">;
  pagination?: { olderCursor?: string; hasOlder?: boolean; pageBudget?: number };
  data?: T;
  errors: Array<{ code?: string; message: string }>;
}

export type MutationAction = "message.send" | "message.react" | "message.unreact" |
  "comment.reply" | "comment.private_reply" | "comment.hide" | "comment.show" |
  "comment.delete" | "comment.like" | "comment.unlike";

export type MutationPayload =
  | { kind: "message.send"; text: string }
  | { kind: "message.react" | "message.unreact"; reaction: string }
  | { kind: "comment.reply" | "comment.private_reply"; text: string }
  | { kind: "comment.hide" | "comment.show" | "comment.delete" | "comment.like" | "comment.unlike" };

export interface MutationIntent {
  source: MutationSource;
  bridgeId?: string;
  accountBinding: string;
  action: MutationAction;
  payload: MutationPayload;
  target: TargetRef;
  contextHash: string;
}

export interface MutationOptions {
  dryRun?: boolean;
  confirm?: boolean;
  expectedFingerprint?: string;
  requestId?: string;
  deleteConfirmation?: boolean;
}

export interface MutationPreview {
  source: MutationSource;
  bridgeId?: string;
  accountBinding: string;
  action: MutationAction;
  target: TargetRef;
  payload: MutationPayload;
  contextHash: string;
  fingerprint: string;
  requestId: string;
  requiresConfirmation: true;
  sideEffects?: Array<"may_mark_seen">;
}

export type MutationResult =
  | { status: "ACK"; receiptId?: string }
  | { status: "OBSERVED"; receiptId?: string; responseState?: "answered" | "unknown"; dispatchStatus?: "ACK" | "OUTCOME_UNKNOWN" }
  | { status: "OUTCOME_UNKNOWN"; reason: string; responseState?: "unknown"; dispatchStatus?: "ACK" | "OUTCOME_UNKNOWN" }
  | { status: "FAILED"; reason: string };
