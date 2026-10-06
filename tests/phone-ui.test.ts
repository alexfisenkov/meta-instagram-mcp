import { describe, expect, it, vi } from "vitest";
import { createPhoneUiProvider } from "../src/providers/phone-ui.js";

const profileXml = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="@fixture"/><XCUIElementTypeButton label="Edit profile"/><XCUIElementTypeStaticText label="1,234 followers"/><XCUIElementTypeStaticText label="321 following"/><XCUIElementTypeStaticText label="42 posts"/></XCUIElementTypeApplication></AppiumAUT>';

describe("PhoneUiProvider", () => {
  it("returns a bounded profile observation only when the app and selected account are proven", async () => {
    const client = {
      readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })),
      getSource: vi.fn(async () => profileXml),
      clickSemantic: vi.fn(async () => {})
    };
    const provider = createPhoneUiProvider({ client, accountBinding: "acct:fixture", expectedAccountHandle: "fixture", now: () => "2026-10-06T12:00:00.000Z" });
    const result = await provider.observe({ op: "account.snapshot" });
    expect(result).toMatchObject({ source: "phone", accountBinding: "acct:fixture", availability: "ready", coverage: "partial" });
    expect(result.data).toMatchObject({ username: "fixture", followers: 1234, following: 321, posts: 42 });
    expect(JSON.stringify(result)).not.toContain("AppiumAUT");
  });

  it("extracts only recognized visible Reel insight labels for an exact selected media ref", async () => {
    const xml = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="Reel insights"/><XCUIElementTypeStaticText label="Overview"/><XCUIElementTypeStaticText label="fixture-media-1"/><XCUIElementTypeStaticText label="Views" x="100" y="100"/><XCUIElementTypeStaticText label="12,345" x="100" y="135"/><XCUIElementTypeStaticText label="Accounts reached" x="100" y="200"/><XCUIElementTypeStaticText label="1,234" x="100" y="230"/><XCUIElementTypeStaticText label="Average watch time" x="100" y="290"/><XCUIElementTypeStaticText label="8s" x="100" y="320"/><XCUIElementTypeStaticText label="Follows" x="100" y="380"/><XCUIElementTypeStaticText label="17" x="100" y="410"/></XCUIElementTypeApplication></AppiumAUT>';
    const client = { readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })), getSource: vi.fn(async () => xml), clickSemantic: vi.fn(async () => {}) };
    const provider = createPhoneUiProvider({ client, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });
    const result = await provider.observe({ op: "insights.read", target: { accountBinding: "acct:fixture", nativeId: "fixture-media-1" } });
    expect(result).toMatchObject({ availability: "ready", coverage: "partial", source: "phone" });
    expect(result.data).toMatchObject({ scope: "reel", metrics: { views: { value: 12345 }, accounts_reached: { value: 1234 }, average_watch_time_seconds: { value: 8 }, follows: { value: 17 } } });
    expect(JSON.stringify(result)).not.toContain("AppiumAUT");
  });

  it("fails closed on wrong app, wrong account, or stale media identity", async () => {
    const wrongAppClient = { readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })), getSource: vi.fn(async () => '<AppiumAUT><XCUIElementTypeApplication name="Settings"/></AppiumAUT>'), clickSemantic: vi.fn(async () => {}) };
    const wrongApp = await createPhoneUiProvider({ client: wrongAppClient, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" }).observe({ op: "account.snapshot" });
    expect(wrongApp.availability).toBe("unsupported_ui_version");
    expect(wrongApp.data).toBeUndefined();

    const otherProfile = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="@someone-else"/><XCUIElementTypeButton label="Edit profile"/></XCUIElementTypeApplication></AppiumAUT>';
    const wrongAccountClient = { readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })), getSource: vi.fn(async () => otherProfile), clickSemantic: vi.fn(async () => {}) };
    const wrongAccount = await createPhoneUiProvider({ client: wrongAccountClient, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" }).observe({ op: "account.snapshot" });
    expect(wrongAccount.availability).toBe("unsupported_ui_version");
    expect(wrongAccount.data).toBeUndefined();

    const insights = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="Reel insights"/><XCUIElementTypeStaticText label="Overview"/><XCUIElementTypeStaticText label="other-media"/><XCUIElementTypeStaticText label="Views" x="1" y="1"/><XCUIElementTypeStaticText label="99" x="1" y="20"/></XCUIElementTypeApplication></AppiumAUT>';
    const staleClient = { readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })), getSource: vi.fn(async () => insights), clickSemantic: vi.fn(async () => {}) };
    const stale = await createPhoneUiProvider({ client: staleClient, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" }).observe({ op: "insights.read", target: { accountBinding: "acct:fixture", nativeId: "requested-media" } });
    expect(stale.availability).toBe("unsupported_ui_version");
    expect(stale.data).toBeUndefined();
  });

  it("returns bounded inbox rows and reads only a freshly selected unique peer", async () => {
    const inbox = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="Messages"/><XCUIElementTypeCell visible="true"><XCUIElementTypeStaticText label="@peer"/><XCUIElementTypeStaticText label="Latest preview"/><XCUIElementTypeStaticText label="2m"/><XCUIElementTypeStaticText label="Unread"/></XCUIElementTypeCell></XCUIElementTypeApplication></AppiumAUT>';
    const conversation = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeNavigationBar label="@peer"/><XCUIElementTypeCell><XCUIElementTypeStaticText label="Earlier message"/></XCUIElementTypeCell><XCUIElementTypeCell><XCUIElementTypeStaticText label="Latest reply"/></XCUIElementTypeCell></XCUIElementTypeApplication></AppiumAUT>';
    let sources = [inbox, inbox, conversation];
    const clicks: string[] = [];
    const client = {
      readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })),
      getSource: vi.fn(async () => sources.shift() ?? conversation),
      clickSemantic: vi.fn(async (control: string, label?: string) => { clicks.push(`${control}:${label ?? ""}`); })
    };
    const provider = createPhoneUiProvider({ client, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });
    const listed = await provider.observe({ op: "inbox.list", limit: 10 });
    const thread = (listed.data as { threads: Array<{ target: { accountBinding: string; nativeId: string }; peer: string; unread: boolean }> }).threads[0]!;
    expect(listed).toMatchObject({ availability: "ready", coverage: "complete" });
    expect(thread).toMatchObject({ peer: "@peer", unread: true, target: { accountBinding: "acct:fixture" } });
    const read = await provider.observe({ op: "thread.read", target: thread.target, limit: 10 });
    expect(read).toMatchObject({ availability: "ready", coverage: "partial", historyCompleteness: "limited", sideEffects: ["may_mark_seen"] });
    expect((read.data as { messages: Array<{ direction: string; text: string }> }).messages.map((message) => message.text)).toEqual(["Earlier message", "Latest reply"]);
    expect(clicks).toEqual(["selected_row:@peer"]);
  });

  it("keeps unread and unanswered unknown and marks bounded thread, comments, and replies history", async () => {
    const inbox = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="Messages"/><XCUIElementTypeCell visible="true"><XCUIElementTypeStaticText label="@peer"/><XCUIElementTypeStaticText label="Preview"/></XCUIElementTypeCell></XCUIElementTypeApplication></AppiumAUT>';
    const conversation = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeNavigationBar label="@peer"/><XCUIElementTypeCell><XCUIElementTypeStaticText label="Earlier message"/></XCUIElementTypeCell><XCUIElementTypeCell><XCUIElementTypeStaticText label="Latest reply"/></XCUIElementTypeCell></XCUIElementTypeApplication></AppiumAUT>';
    const comments = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="Comments"/><XCUIElementTypeStaticText label="fixture-media"/><XCUIElementTypeCell visible="true"><XCUIElementTypeStaticText label="@commenter"/><XCUIElementTypeStaticText label="First comment"/><XCUIElementTypeOther><XCUIElementTypeStaticText label="@replyone"/><XCUIElementTypeStaticText label="First reply"/></XCUIElementTypeOther><XCUIElementTypeOther><XCUIElementTypeStaticText label="@replytwo"/><XCUIElementTypeStaticText label="Second reply"/></XCUIElementTypeOther></XCUIElementTypeCell><XCUIElementTypeCell visible="true"><XCUIElementTypeStaticText label="@another"/><XCUIElementTypeStaticText label="Second comment"/></XCUIElementTypeCell></XCUIElementTypeApplication></AppiumAUT>';
    let sources = [inbox, inbox, conversation, comments, comments];
    const client = {
      readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })),
      getSource: vi.fn(async () => sources.shift() ?? comments),
      clickSemantic: vi.fn(async () => {})
    };
    const provider = createPhoneUiProvider({ client, accountBinding: "acct:fixture", expectedAccountHandle: "fixture" });

    const listed = await provider.observe({ op: "inbox.list", limit: 10 });
    const thread = (listed.data as { threads: Array<{ target: { accountBinding: string; nativeId: string }; unread: boolean | "unknown"; unanswered: boolean | "unknown" }> }).threads[0]!;
    expect(thread).toMatchObject({ unread: "unknown", unanswered: "unknown", target: { accountBinding: "acct:fixture" } });
    const history = await provider.observe({ op: "thread.read", target: thread.target, limit: 1 });
    expect(history).toMatchObject({ source: "phone", availability: "ready", coverage: "partial", historyCompleteness: "limited", sideEffects: ["may_mark_seen"] });
    expect((history.data as { messages: Array<{ nativeRef: string; text: string; direction: string; timestamp: string }> }).messages).toEqual([
      expect.objectContaining({ nativeRef: expect.stringMatching(/^phone-message:/), text: "Latest reply", direction: "unknown", timestamp: "unknown" })
    ]);
    expect(history.errors.map((error) => error.code)).toContain("bounded_limit");

    const listedComments = await provider.observe({ op: "comments.list", target: { accountBinding: "acct:fixture", nativeId: "fixture-media" }, limit: 1 });
    expect(listedComments).toMatchObject({ source: "phone", availability: "ready", coverage: "partial", historyCompleteness: "limited" });
    expect(listedComments.errors.map((error) => error.code)).toContain("bounded_limit");
    const firstComment = (listedComments.data as { comments: Array<{ target: { accountBinding: string; nativeId: string }; author: string; text: string }> }).comments[0]!;
    expect(firstComment).toMatchObject({ target: { accountBinding: "acct:fixture" }, author: "@commenter", text: "First comment" });
    const listedReplies = await provider.observe({ op: "comments.replies", target: firstComment.target, limit: 1 });
    expect(listedReplies).toMatchObject({ source: "phone", availability: "ready", coverage: "partial", historyCompleteness: "limited" });
    expect((listedReplies.data as { replies: Array<{ author: string; text: string }> }).replies).toEqual([{ author: "@replyone", text: "First reply" }]);
    expect(listedReplies.errors.map((error) => error.code)).toContain("bounded_limit");
    expect(listedComments.nativeRef).toMatch(/^comments:/);
    expect(listedReplies.nativeRef).toMatch(/^replies:/);
  });

  it("dispatches a unique comment like once only after fresh media/comment context and explicit local gate", async () => {
    const xml = '<AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="Comments"/><XCUIElementTypeStaticText label="fixture-media"/><XCUIElementTypeCell visible="true"><XCUIElementTypeStaticText label="@commenter"/><XCUIElementTypeStaticText label="Good work"/><XCUIElementTypeButton label="Like"/></XCUIElementTypeCell></XCUIElementTypeApplication></AppiumAUT>';
    const clicks: string[] = [];
    const client = {
      readiness: vi.fn(async () => ({ availability: "ready" as const, capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" as const })),
      getSource: vi.fn(async () => xml),
      clickSemantic: vi.fn(async (control: string) => { clicks.push(control); })
    };
    const provider = createPhoneUiProvider({ client, accountBinding: "acct:fixture", expectedAccountHandle: "fixture", writeEnabled: true });
    const listed = await provider.observe({ op: "comments.list", target: { accountBinding: "acct:fixture", nativeId: "fixture-media" }, limit: 10 });
    const target = (listed.data as { comments: Array<{ target: { accountBinding: string; nativeId: string } }> }).comments[0]!.target;
    const initial: import("../src/domain-types.js").MutationIntent = {
      source: "phone", accountBinding: "acct:fixture", action: "comment.like", payload: { kind: "comment.like" }, target, contextHash: "preview"
    };
    const fresh = await provider.refreshContext(initial);
    const intent = { ...initial, contextHash: fresh.contextHash };
    await expect(provider.execute(intent, "request-id-00000001", fresh.contextHash)).resolves.toMatchObject({ status: "OUTCOME_UNKNOWN" });
    await expect(provider.execute(intent, "request-id-00000001", fresh.contextHash)).resolves.toMatchObject({ status: "OUTCOME_UNKNOWN" });
    expect(clicks).toEqual(["comment_like"]);
  });
});
