import { mkdir, open, readFile, chmod, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredWebhookEvent {
  id: string;
  type: "message" | "echo" | "reaction" | "comment";
  source: "meta_webhook";
  receivedAt?: string;
  occurredAt?: string;
  accountId?: string;
  objectId?: string;
  data: Record<string, unknown>;
}
export interface WebhookJournalOptions { path: string; now?: () => string }
export interface WebhookAppendResult { inserted: number; duplicate: number }

const queues = new Map<string, Promise<unknown>>();

/** Private, append-only webhook journal. Callers receive only persistence counts. */
export class WebhookJournal {
  readonly path: string;
  private readonly now: () => string;
  constructor(options: WebhookJournalOptions) { this.path = options.path; this.now = options.now ?? (() => new Date().toISOString()); }

  append(events: readonly StoredWebhookEvent[]): Promise<WebhookAppendResult> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.appendExclusive(events));
    queues.set(this.path, operation);
    void operation.finally(() => { if (queues.get(this.path) === operation) queues.delete(this.path); }).catch(() => undefined);
    return operation;
  }

  private async appendExclusive(events: readonly StoredWebhookEvent[]): Promise<WebhookAppendResult> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const lockPath = `${this.path}.lock`;
    let lockHandle;
    const deadline = Date.now() + 5_000;
    while (!lockHandle) {
      try { lockHandle = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if (!isCode(error, "EEXIST") || Date.now() >= deadline) throw new Error("Webhook journal lock unavailable.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      let existing = new Set<string>();
      try {
        const text = await readFile(this.path, "utf8");
        existing = new Set(text.split("\n").filter(Boolean).map((line) => {
          const row = JSON.parse(line) as { id?: unknown };
          if (typeof row.id !== "string") throw new Error("Webhook journal record is invalid.");
          return row.id;
        }));
      } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
      const seen = new Set(existing);
      const rows: string[] = [];
      let duplicate = 0;
      for (const event of events) {
        validateEvent(event);
        if (seen.has(event.id)) { duplicate += 1; continue; }
        seen.add(event.id);
        rows.push(JSON.stringify({ id: event.id, receivedAt: event.receivedAt ?? this.now(), event }));
      }
      if (rows.length) {
        const handle = await open(this.path, "a", 0o600);
        try { await handle.writeFile(`${rows.join("\n")}\n`, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await chmod(this.path, 0o600);
      }
      return { inserted: rows.length, duplicate };
    } finally {
      await lockHandle.close();
      await rm(lockPath, { force: true });
    }
  }
}

function validateEvent(event: StoredWebhookEvent): void {
  if (!event.id || event.id.length > 256 || !["message", "echo", "reaction", "comment"].includes(event.type) || event.source !== "meta_webhook" || !event.data || typeof event.data !== "object") {
    throw new Error("Webhook event is invalid.");
  }
}
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
