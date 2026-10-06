import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWebhookReceiver, type WebhookReceiver } from "../src/webhooks.js";
import type { StoredWebhookEvent } from "../src/webhook-journal.js";

const secret = "fake-app-secret";
const body = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: "fake-account", time: 1, messaging: [{ sender: { id: "fake-sender" }, recipient: { id: "fake-account" }, timestamp: 2, message: { mid: "fake-message", text: "private test text" } }] }] }));
function signature(input: Buffer): string { return `sha256=${createHmac("sha256", secret).update(input).digest("hex")}`; }
type AppendFn = (events: readonly StoredWebhookEvent[]) => Promise<{ inserted: number; duplicate: number }>;
function receiver(append: ReturnType<typeof vi.fn<AppendFn>> = vi.fn<AppendFn>(async (_events) => ({ inserted: 1, duplicate: 0 })), maxBodyBytes = 10_000): WebhookReceiver {
  return createWebhookReceiver({ appSecret: secret, verifyToken: "fake-verify-token", expectedAccountIds: ["fake-account"], journal: { append }, maxBodyBytes });
}

describe("Meta webhook receiver", () => {
  it("fails closed when no expected account IDs are configured", () => {
    expect(() => createWebhookReceiver({
      appSecret: secret, verifyToken: "fake-verify-token", expectedAccountIds: [], journal: { append: async () => ({ inserted: 0, duplicate: 0 }) },
    })).toThrow("Webhook receiver configuration is incomplete.");
  });

  it("answers a valid subscription challenge and durably accepts a signed message", async () => {
    const append = vi.fn<AppendFn>(async (_events) => ({ inserted: 1, duplicate: 0 }));
    const target = receiver(append);
    await expect(target.handle({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=fake-verify-token&hub.challenge=123456" }))
      .resolves.toMatchObject({ status: 200, body: "123456" });
    const result = await target.handle({ method: "POST", url: "/webhook", headers: { "x-hub-signature-256": signature(body) }, rawBody: body });
    expect(result.status).toBe(200);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]![0][0]).toMatchObject({ type: "message", accountId: "fake-account", data: { messageId: "fake-message", text: "private test text" } });
    expect(JSON.stringify(result)).not.toContain("private test text");
  });

  it("rejects a one-byte signature mismatch and oversized bodies before persistence", async () => {
    const append = vi.fn<AppendFn>(async (_events) => ({ inserted: 1, duplicate: 0 }));
    const target = receiver(append, body.length);
    const changed = Buffer.from(body); changed[changed.length - 2] ^= 1;
    await expect(target.handle({ method: "POST", url: "/webhook", headers: { "x-hub-signature-256": signature(body) }, rawBody: changed }))
      .resolves.toMatchObject({ status: 401 });
    await expect(target.handle({ method: "POST", url: "/webhook", headers: { "x-hub-signature-256": signature(body) }, rawBody: Buffer.concat([body, Buffer.from(" ")]) }))
      .resolves.toMatchObject({ status: 413 });
    expect(append).not.toHaveBeenCalled();
  });

  it("returns 503 when durable persistence fails", async () => {
    const target = receiver(vi.fn(async () => { throw new Error("disk unavailable"); }));
    await expect(target.handle({ method: "POST", url: "/webhook", headers: { "x-hub-signature-256": signature(body) }, rawBody: body }))
      .resolves.toMatchObject({ status: 503 });
  });

  it("does not acknowledge until the journal append resolves", async () => {
    let finish!: (value: { inserted: number; duplicate: number }) => void;
    const append = vi.fn<AppendFn>(() => new Promise((resolve) => { finish = resolve; }));
    const target = receiver(append);
    let settled = false;
    const pending = target.handle({ method: "POST", url: "/webhook", headers: { "x-hub-signature-256": signature(body) }, rawBody: body })
      .then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ inserted: 1, duplicate: 0 });
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it("rejects invalid verify tokens and malformed event schemas", async () => {
    const append = vi.fn<AppendFn>(async (_events) => ({ inserted: 1, duplicate: 0 }));
    const target = receiver(append);
    await expect(target.handle({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=%3Cscript%3E" }))
      .resolves.toMatchObject({ status: 403 });
    const invalid = Buffer.from('{"object":"unknown","entry":[]}');
    await expect(target.handle({ method: "POST", url: "/webhook", headers: { "x-hub-signature-256": signature(invalid) }, rawBody: invalid }))
      .resolves.toMatchObject({ status: 400 });
    expect(append).not.toHaveBeenCalled();
  });

  it("rejects foreign-account and mixed-account envelopes before journal append", async () => {
    const append = vi.fn<AppendFn>(async (_events) => ({ inserted: 1, duplicate: 0 }));
    const target = receiver(append);
    const foreign = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: "foreign-account", messaging: [{ message: { mid: "foreign-message" } }] }] }));
    const mixed = Buffer.from(JSON.stringify({ object: "instagram", entry: [
      { id: "fake-account", messaging: [{ message: { mid: "owned-message" } }] },
      { id: "foreign-account", messaging: [{ message: { mid: "foreign-message" } }] },
    ] }));
    for (const rawBody of [foreign, mixed]) {
      await expect(target.handle({ method: "POST", url: "/webhook", headers: { "x-hub-signature-256": signature(rawBody) }, rawBody }))
        .resolves.toMatchObject({ status: 403 });
    }
    expect(append).not.toHaveBeenCalled();
  });
});
