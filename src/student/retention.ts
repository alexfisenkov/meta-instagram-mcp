import type { ReplyAttempt, StoredEvent } from "./types.js";
import type { StudentVault } from "./vault.js";
export const EVENT_TTL_MS = 30 * 86_400_000;
export function eventWithinRetention(event: StoredEvent, now: number): boolean {
  const receivedAt = Date.parse(event.receivedAt);
  return Number.isFinite(receivedAt) && receivedAt <= now && receivedAt > now - EVENT_TTL_MS;
}
export const REPLY_RECEIPT_TTL_MS = 30 * 86_400_000;
export function replyWithinRetention(attempt: ReplyAttempt, now: number): boolean { const created = Date.parse(attempt.createdAt); return Number.isFinite(created) && created <= now && created > now - REPLY_RECEIPT_TTL_MS; }
export async function sweepStudentEvents(vault: StudentVault, now: number): Promise<void> {
  const current = await vault.snapshot();
  if (!current.events.some((event) => !eventWithinRetention(event, now)) && !(current.replyAttempts ?? []).some((attempt) => !replyWithinRetention(attempt, now))) return;
  await vault.transaction((db) => { db.events = db.events.filter((event) => eventWithinRetention(event, now)); if (db.replyAttempts) db.replyAttempts = db.replyAttempts.filter((attempt) => replyWithinRetention(attempt, now)); });
}
