import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrivateFile } from "../src/private-fs.js";
import { WebhookJournal } from "../src/webhook-journal.js";

describe("WebhookJournal", () => {
  it("durably appends once, deduplicates concurrent retries, and keeps the journal private", async () => {
    const directory = await mkdtemp(join(tmpdir(), "instagram-webhook-"));
    const path = join(directory, "events", "journal.jsonl");
    const journal = new WebhookJournal({ path, now: () => "2026-10-06T00:00:00.000Z" });
    const event = { id: "fake-event-1", type: "message" as const, source: "meta_webhook" as const, data: { messageId: "fake-mid", text: "private fake text" } };

    const results = await Promise.all([journal.append([event]), journal.append([event])]);

    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toEqual(event);
    await expect(assertPrivateFile(path)).resolves.toBeUndefined();
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
