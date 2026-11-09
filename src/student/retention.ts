import type { StoredEvent } from "./types.js";
import type { StudentVault } from "./vault.js";
export const EVENT_TTL_MS = 30 * 86_400_000;
export function eventWithinRetention(event: StoredEvent, now: number): boolean {
  const receivedAt = Date.parse(event.receivedAt);
  return Number.isFinite(receivedAt) && receivedAt <= now && receivedAt > now - EVENT_TTL_MS;
}
export async function sweepStudentEvents(vault: StudentVault, now: number): Promise<void> {
  if (!(await vault.snapshot()).events.some((event) => !eventWithinRetention(event, now))) return;
  await vault.transaction((db) => { db.events = db.events.filter((event) => eventWithinRetention(event, now)); });
}
