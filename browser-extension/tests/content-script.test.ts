import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const contentScript = await readFile(resolve(root, "browser-extension/content-script.js"), "utf8");
const accountBinding = "owner:alex";

describe("Instagram content script against DOM fixtures", () => {
  it("answers a readiness ping without inspecting the Instagram page", async () => {
    const page = new Window({ url: "https://www.instagram.com/direct/inbox/", settings: { disableJavaScriptEvaluation: false } });
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    try {
      expect(await invoke(listener, { kind: "ping" })).toEqual({ kind: "pong", version: 1 });
    } finally { page.happyDOM.abort(); }
  });

  it("verifies a Direct-page account through the observed own-profile control and returns to the same tab URL", async () => {
    const { result, clicks, url, followup } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", followup: true });

    expect(result).toMatchObject({
      source: "browser", availability: "ready", accountBinding,
      data: { username: "alexfisenkov", loggedIn: true, surface: "instagram" }
    });
    expect(result.nativeRef).toBe("/direct/inbox/");
    expect(url).toBe("https://www.instagram.com/direct/inbox/");
    expect(clicks).toBe(1);
    expect(followup).toMatchObject({ availability: "ready", data: { username: "alexfisenkov", items: [{ nativeId: "thread-7" }] } });
  });

  it.each([
    ["a different profile image", "someoneelse", "Редактировать профиль"],
    ["a public profile without the own Edit profile control", "alexfisenkov", "Поделиться профилем"]
  ])("does not verify account.inspect from %s", async (_reason, avatarHandle, editLabel) => {
    const { result, clicks } = await runOwnProfileInspectFixture({ avatarHandle, editLabel });
    expect(result.availability).toBe("needs_selection");
    expect(result.coverage).toBe("unknown");
    expect(clicks).toBe(avatarHandle === "alexfisenkov" ? 1 : 0);
    expect(result.errors[0]?.code).toBe(avatarHandle === "alexfisenkov" ? "edit_marker_missing" : "expected_handle_mismatch");
  });

  it("reports a missing expected account handle without exposing profile values", async () => {
    const { result, clicks } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", expectedHandle: null });
    expect(result).toMatchObject({ availability: "needs_selection", errors: [{ code: "expected_handle_missing" }] });
    expect(JSON.stringify(result)).not.toContain("alexfisenkov");
    expect(clicks).toBe(0);
  });

  it("reports an expired read task before clicking a profile control", async () => {
    const { result, clicks } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль",
      taskExpiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(result).toMatchObject({ availability: "offline", coverage: "unknown", errors: [{ code: "task_deadline_expired" }] });
    expect(clicks).toBe(0);
  });

  it("restores the Direct tab but does not report account.inspect after its task deadline", async () => {
    const { result, clicks, url } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль",
      taskExpiresAt: new Date(Date.now() + 100).toISOString(), restoreDelayMs: 200 });
    expect(result).toMatchObject({ availability: "offline", coverage: "unknown", errors: [{ code: "task_deadline_expired" }] });
    expect(clicks).toBe(1);
    expect(url).toBe("https://www.instagram.com/direct/inbox/");
  });

  it("rejects an ambiguous own-profile control and does not choose one arbitrarily", async () => {
    const { result, clicks } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", ambiguous: true });
    expect(result.availability).toBe("needs_selection");
    expect(clicks).toBe(0);
    expect(result.errors[0]?.code).toBe("owner_marker_ambiguous");
  });

  it("invalidates the within-document proof when the avatar control changes accounts", async () => {
    const { result, clicks, followup } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", followup: true, switchHandleBeforeFollowup: "otheraccount" });
    expect(result.availability).toBe("ready");
    expect(followup).toMatchObject({ availability: "needs_selection", coverage: "unknown" });
    expect(clicks).toBe(1);
    expect(followup.errors[0]?.code).toBe("expected_handle_mismatch");
  });

  it("does not reuse proof for a replacement control while an expected-handle recipient avatar remains", async () => {
    const { result, clicks, followup } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", followup: true,
      switchHandleBeforeFollowup: "otheraccount", keepExpectedRecipientAvatar: true });
    expect(result.availability).toBe("ready");
    expect(followup).toMatchObject({ availability: "needs_selection", coverage: "unknown" });
    expect(clicks).toBe(1);
    expect(followup.errors[0]?.code).toBe("owner_marker_ambiguous");
  });

  it("re-proves a replacement control even when its href and image alt match the cached values", async () => {
    const { result, clicks, followup } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", followup: true,
      replaceOwnControlWithMatchingAvatar: true });
    expect(result.availability).toBe("ready");
    expect(followup).toMatchObject({ availability: "needs_selection", coverage: "unknown" });
    expect(clicks).toBe(1);
  });

  it("does not read Direct from a matching nav link without the verified owner Profile control", async () => {
    const result = await runUnverifiedInboxFixture();
    expect(result).toMatchObject({ availability: "needs_selection", coverage: "unknown" });
  });

  it("fails closed when browser history does not restore the original Instagram URL", async () => {
    const { result, url, clicks } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", restore: false });
    expect(result.availability).toBe("needs_selection");
    expect(url).toBe("https://www.instagram.com/alexfisenkov/");
    expect(clicks).toBe(1);
    expect(result.errors[0]?.code).toBe("original_url_restore_failed");
  });

  it("returns exact inbox refs and preserves unread versus unanswered", async () => {
    const result = await runFixture("inbox.html", "https://www.instagram.com/direct/inbox/", {
      op: "inbox.list", limit: 10
    });
    expect(result).toMatchObject({
      source: "browser", accountBinding, availability: "ready", coverage: "unknown", historyCompleteness: "limited",
      data: { username: "alexfisenkov", items: [
        { nativeId: "thread-7", unread: true, unanswered: "unknown" },
        { nativeId: "thread-8", unread: "unknown", unanswered: "unknown" }
      ] }, errors: []
    });
  });

  it("does not extract legacy Direct anchors from a non-Inbox, non-thread page", async () => {
    const url = "https://www.instagram.com/p/post-1/";
    const page = new Window({ url, settings: { disableJavaScriptEvaluation: false } });
    page.document.write('<!doctype html><html><body><main><a href="/direct/t/unrelated-thread/">Unrelated Direct link</a></main></body></html>');
    page.document.close();
    makeVisible(page.document.querySelector("main")!);
    makeVisible(page.document.querySelector("main a")!);
    installOwnProfileControlFixture(page, url);
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    try {
      const result = await invoke(listener, { kind: "observe", operation: { op: "inbox.list", limit: 5 }, accountBinding,
        expectedAccountHandle: "alexfisenkov", taskExpiresAt: new Date(Date.now() + 5_000).toISOString() });
      expect(result).toMatchObject({ availability: "unsupported_ui_version", coverage: "unknown", errors: [{ code: "inbox_route_unsupported" }] });
      expect(result.data).toBeUndefined();
    } finally { page.happyDOM.abort(); }
  });

  it("returns ephemeral read-only refs for the observed Direct row cards and opens only the requested row", async () => {
    const { inbox, conversation, conversationAgain, clicks, url } = await runInboxRowContractFixture({ reuseReadRef: true });
    const item = inbox.data.items[0];
    expect(inbox).toMatchObject({ availability: "ready", coverage: "partial", sideEffects: [] });
    expect(inbox.data.items).toHaveLength(2);
    expect(item).toMatchObject({ unread: "unknown", unanswered: "unknown", target: { accountBinding } });
    expect(item.target.explicitOwnerRef).toMatch(/^browser-inbox-row:/);
    expect(item).not.toHaveProperty("nativeId");
    expect(conversation).toMatchObject({ availability: "ready", source: "browser", nativeRef: item.target.explicitOwnerRef, sideEffects: ["may_mark_seen"],
      data: { messages: [{ nativeId: "msg-1", text: "One message" }] } });
    expect(conversation.data).not.toHaveProperty("threadNativeId");
    expect(clicks).toBe(1);
    expect(url).toBe("https://www.instagram.com/direct/t/observed-thread-7/");
    expect(conversationAgain).toMatchObject({ availability: "ready", data: { messages: [{ nativeId: "msg-1" }] } });
  });

  it("reads a second sidebar row after Inbox → thread A → Inbox list without returning thread A content", async () => {
    const { firstRead, inboxOnThread, sameThreadReuse, secondRead, clicks, url } = await runInboxThreadSidebarCycleFixture();
    expect(firstRead).toMatchObject({ availability: "ready", data: { messages: [{ nativeId: "thread-a-message", text: "Thread A message" }] } });
    expect(inboxOnThread.availability).toBe("ready");
    expect(inboxOnThread.data.items[0].target.explicitOwnerRef).toMatch(/^browser-inbox-row:/);
    expect(inboxOnThread.data.items).toHaveLength(2);
    expect(sameThreadReuse).toMatchObject({ availability: "ready", data: { messages: [{ nativeId: "thread-a-message", text: "Thread A message" }] } });
    expect(secondRead).toMatchObject({ availability: "ready", data: { messages: [{ nativeId: "thread-b-message", text: "Thread B message" }] } });
    expect(secondRead.data.messages).not.toContainEqual(expect.objectContaining({ text: "Thread A message" }));
    expect(clicks).toBe(2);
    expect(url).toBe("https://www.instagram.com/direct/t/thread-b/");
  });

  it("rejects a second row navigation while another conversation navigation is in progress", async () => {
    const { conversation, concurrentConversation, clicks } = await runInboxRowContractFixture({ concurrentDistinctRefs: true });
    expect([conversation.availability, concurrentConversation.availability].sort()).toEqual(["offline", "ready"]);
    expect([conversation, concurrentConversation].some((value) => value.errors[0]?.code === "browser_ui_busy")).toBe(true);
    expect(clicks).toBe(1);
  });

  it("rejects account.inspect while conversation navigation is still loading", async () => {
    const { conversation, concurrentInspect, clicks } = await runInboxRowContractFixture({ inspectDuringRead: true, loadMessages: false, readDeadlineMs: 250 });
    expect(concurrentInspect).toMatchObject({ availability: "offline", coverage: "unknown", errors: [{ code: "browser_ui_busy" }] });
    expect(conversation).toMatchObject({ availability: "offline", coverage: "unknown", sideEffects: ["may_mark_seen"] });
    expect(clicks).toBe(1);
  });

  it("fails closed when clicking a new row does not change the current thread route", async () => {
    const { conversation, clicks } = await runInboxRowContractFixture({ noRouteChange: true, loadMessages: false, readDeadlineMs: 250 });
    expect(["needs_selection", "offline"]).toContain(conversation.availability);
    expect(conversation.coverage).toBe("unknown");
    expect(conversation.sideEffects).toEqual(["may_mark_seen"]);
    expect(["conversation_route_not_reached", "task_deadline_expired"]).toContain(conversation.errors[0]?.code);
    expect(conversation.data?.messages).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("waits for a selected row route transition within the existing read deadline", async () => {
    const { conversation, clicks, url } = await runInboxRowContractFixture({ routeChangeDelayMs: 1_700, readDeadlineMs: 4_500 });
    expect(conversation).toMatchObject({ availability: "ready", source: "browser", sideEffects: ["may_mark_seen"],
      data: { messages: [{ nativeId: "msg-1", text: "One message" }] } });
    expect(clicks).toBe(1);
    expect(url).toBe("https://www.instagram.com/direct/t/observed-thread-7/");
  });

  it("does not repeat the row click after the existing read deadline expires", async () => {
    const { conversation, clicks } = await runInboxRowContractFixture({ routeChangeDelayMs: 1_700, readDeadlineMs: 250, settleAfterReadMs: 1_800 });
    expect(conversation).toMatchObject({ availability: "offline", coverage: "unknown", sideEffects: ["may_mark_seen"],
      errors: [{ code: "task_deadline_expired" }] });
    expect(clicks).toBe(1);
  });

  it("does not reuse an opened row ref to navigate to a changed conversation route", async () => {
    const { conversationAgain, clicks, url } = await runInboxRowContractFixture({ reuseReadRef: true, changeRouteBeforeReuse: true });
    expect(conversationAgain).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "stale_inbox_row_ref" }] });
    expect(clicks).toBe(1);
    expect(url).toBe("https://www.instagram.com/direct/t/another-thread/");
  });

  it("does not double-click when the same inbox row ref is read concurrently", async () => {
    const { conversation, conversationDuplicate, clicks } = await runInboxRowContractFixture({ duplicateRead: true });
    expect([conversation.availability, conversationDuplicate.availability].sort()).toEqual(["offline", "ready"]);
    expect([conversation, conversationDuplicate].some((value) => value.errors[0]?.code === "browser_ui_busy")).toBe(true);
    expect(clicks).toBe(1);
  });

  it("returns unknown rather than empty when no supported inbox row structure is present", async () => {
    const { inbox, clicks } = await runInboxRowContractFixture({ shellOnly: true });
    expect(inbox).toMatchObject({ availability: "ready", coverage: "unknown", data: { items: [] } });
    expect(inbox.data.items).toHaveLength(0);
    expect(clicks).toBe(0);
  });

  it("does not report an empty conversation when a selected row route remains loading", async () => {
    const { conversation, clicks } = await runInboxRowContractFixture({ loadMessages: false, readDeadlineMs: 250 });
    expect(conversation).toMatchObject({ availability: "offline", coverage: "unknown", sideEffects: ["may_mark_seen"],
      errors: [{ code: "task_deadline_expired" }] });
    expect(conversation).not.toHaveProperty("data.messages");
    expect(clicks).toBe(1);
  });

  it("does not return a visible pre-click message node as content from the newly selected thread", async () => {
    const { conversation, clicks } = await runInboxRowContractFixture({ preexistingStaleMessage: true, loadMessages: false, readDeadlineMs: 250 });
    expect(conversation).toMatchObject({ availability: "offline", coverage: "unknown", sideEffects: ["may_mark_seen"],
      errors: [{ code: "task_deadline_expired" }] });
    expect(conversation.data?.messages).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("does not treat a hidden pre-click message node as fresh when it becomes visible during navigation", async () => {
    const { conversation, clicks } = await runInboxRowContractFixture({ hiddenStaleMessageRevealed: true, loadMessages: false, readDeadlineMs: 250 });
    expect(conversation).toMatchObject({ availability: "offline", coverage: "unknown", sideEffects: ["may_mark_seen"],
      errors: [{ code: "task_deadline_expired" }] });
    expect(conversation.data?.messages).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("does not treat an out-of-main pre-click node moved into the new main as fresh", async () => {
    const { conversation, clicks } = await runInboxRowContractFixture({ outOfMainStaleMessageMoved: true, loadMessages: false, readDeadlineMs: 250 });
    expect(conversation).toMatchObject({ availability: "offline", coverage: "unknown", sideEffects: ["may_mark_seen"],
      errors: [{ code: "task_deadline_expired" }] });
    expect(conversation.data?.messages).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("fails closed on ambiguous Direct card groups and stale or switched-account row refs", async () => {
    const ambiguous = await runInboxRowContractFixture({ separateGroups: true, skipRead: true });
    expect(ambiguous.inbox).toMatchObject({ availability: "unsupported_ui_version", coverage: "unknown", errors: [{ code: "inbox_rows_ambiguous" }] });
    expect(ambiguous.clicks).toBe(0);

    const stale = await runInboxRowContractFixture({ removeBeforeRead: true });
    expect(stale.conversation).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "stale_inbox_row_ref" }] });
    expect(stale.clicks).toBe(0);

    const switched = await runInboxRowContractFixture({ switchAccountBeforeRead: true });
    expect(switched.conversation.availability).toBe("needs_selection");
    expect(switched.clicks).toBe(0);
  });

  it("requires a verified inbox-row proof before a native target can read the same thread", async () => {
    const { conversationNative } = await runInboxRowContractFixture({ nativeTargetReadAfterProof: true });
    expect(conversationNative).toMatchObject({ availability: "ready", source: "browser", sideEffects: ["may_mark_seen"],
      data: { threadNativeId: "observed-thread-7", unread: "unknown", unanswered: "unknown", messages: [{ nativeId: "msg-1", text: "One message" }] } });
  });

  it("fails closed on a native thread URL with visible data IDs but no verified row proof", async () => {
    const result = await runFixture("thread.html", "https://www.instagram.com/direct/t/thread-7/", {
      op: "thread.read", target: { accountBinding, nativeId: "thread-7" }, limit: 10
    });
    expect(result).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "browser_thread_proof_missing" }] });
    expect(result.data).toBeUndefined();
  });

  it("fails closed instead of reading visible IDs from an unproven current main", async () => {
    const page = new Window({ url: "https://www.instagram.com/direct/t/thread-7/", settings: { disableJavaScriptEvaluation: false } });
    page.document.write('<!doctype html><html><body><main><div data-message-id="current-message">Current conversation message</div><div data-mid="hidden-message" style="display:none">Hidden stale message</div></main><aside><div data-message-id="other-thread-message">Other thread message</div></aside></body></html>');
    page.document.close();
    makeVisible(page.document.querySelector("main")!);
    makeVisible(page.document.querySelector("aside")!);
    for (const node of page.document.querySelectorAll("[data-message-id], [data-mid]")) makeVisible(node);
    const hidden = page.document.querySelector('[data-mid="hidden-message"]') as HTMLElement;
    hidden.style.display = "none";
    installOwnProfileControlFixture(page, "https://www.instagram.com/direct/t/thread-7/");
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    try {
      const result = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        operation: { op: "thread.read", target: { accountBinding, nativeId: "thread-7" }, limit: 5 } });
      expect(result).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "browser_thread_proof_missing" }] });
      expect(result.data).toBeUndefined();
    } finally { page.happyDOM.abort(); }
  });

  it("does not attribute stale role-article nodes to an unproven native target", async () => {
    const page = new Window({ url: "https://www.instagram.com/direct/t/thread-8/", settings: { disableJavaScriptEvaluation: false } });
    page.document.write('<!doctype html><html><body><main role="main"><div role="article" data-message-id="stale-message">Older history is unavailable</div><div role="article">A story was shared</div></main></body></html>');
    page.document.close();
    makeVisible(page.document.querySelector("main")!);
    for (const node of page.document.querySelectorAll('div[role="article"]')) makeVisible(node);
    installOwnProfileControlFixture(page, "https://www.instagram.com/direct/t/thread-8/");
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    try {
      const result = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        operation: { op: "thread.read", target: { accountBinding, nativeId: "thread-8" }, limit: 2 } });
      expect(result).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "browser_thread_proof_missing" }] });
      expect(result.data).toBeUndefined();
    } finally { page.happyDOM.abort(); }
  });

  it("reads only fresh visible event entries created after the selected row opens", async () => {
    const { conversation, clicks } = await runInboxRowContractFixture({ loadMessages: false, loadEventEntries: true });
    expect(conversation).toMatchObject({ availability: "ready", coverage: "partial", historyCompleteness: "unknown",
      sideEffects: ["may_mark_seen"], data: { messages: [], visibleEntries: [
        { text: "Older history is unavailable", type: "unknown" }, { text: "A story was shared", type: "unknown" }
      ] } });
    expect(conversation.data).not.toHaveProperty("threadNativeId");
    expect(clicks).toBe(1);
  });

  it("reuses a proven event read on the same route without another row click", async () => {
    const { conversation, conversationAgain, clicks } = await runInboxRowContractFixture({ loadMessages: false, loadEventEntries: true, reuseReadRef: true });
    expect(conversation).toMatchObject({ availability: "ready", data: { visibleEntries: [{ type: "unknown" }, { type: "unknown" }] } });
    expect(conversationAgain).toMatchObject({ availability: "ready", data: { visibleEntries: [{ type: "unknown" }, { type: "unknown" }] } });
    expect(clicks).toBe(1);
  });

  it("invalidates event proof after leaving and returning to the same thread route", async () => {
    const { conversationAgain, clicks } = await runInboxRowContractFixture({ loadMessages: false, loadEventEntries: true,
      reuseReadRef: true, changeRouteAwayAndBackBeforeReuse: true });
    expect(conversationAgain).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "stale_inbox_row_ref" }] });
    expect(conversationAgain.data).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("fails closed when multiple semantic thread mains contain role-article entries", async () => {
    const page = new Window({ url: "https://www.instagram.com/direct/t/thread-7/", settings: { disableJavaScriptEvaluation: false } });
    page.document.write('<!doctype html><html><body><main role="main"><div role="article">First pane</div></main><main role="main"><div role="article">Second pane</div></main></body></html>');
    page.document.close();
    for (const main of page.document.querySelectorAll("main")) makeVisible(main);
    for (const node of page.document.querySelectorAll('div[role="article"]')) makeVisible(node);
    installOwnProfileControlFixture(page, "https://www.instagram.com/direct/t/thread-7/");
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    try {
      const result = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        operation: { op: "thread.read", target: { accountBinding, nativeId: "thread-7" }, limit: 2 } });
      expect(result).toMatchObject({ availability: "needs_selection", coverage: "unknown", errors: [{ code: "browser_thread_proof_missing" }] });
      expect(result.data).toBeUndefined();
    } finally { page.happyDOM.abort(); }
  });

  it("does not scroll a native target without verified thread proof", async () => {
    const html = await readFile(resolve(root, "browser-extension/tests/fixtures/thread.html"), "utf8");
    const page = new Window({ url: "https://www.instagram.com/direct/t/thread-7/" });
    page.document.write(html); page.document.close();
    makeVisible(page.document.querySelector("main")!);
    for (const node of page.document.querySelectorAll("[data-message-id], [data-mid]")) makeVisible(node);
    installOwnProfileControlFixture(page, "https://www.instagram.com/direct/t/thread-7/");
    const scroller = page.document.querySelector('[role="log"]') as HTMLElement;
    Object.defineProperties(scroller, { scrollHeight: { value: 1_000 }, clientHeight: { value: 200 }, scrollTop: { value: 800, writable: true } });
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    try {
      const first = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        operation: { op: "thread.scroll_older", target: { accountBinding, nativeId: "thread-7" }, pages: 2, limit: 10 } });
      expect(scroller.scrollTop).toBe(800);
      expect(first).toMatchObject({ availability: "needs_selection", errors: [{ code: "browser_thread_proof_missing" }] });
    } finally { page.happyDOM.abort(); }
  });

  it("keeps bounded older scrolling after a fresh row read proves the native thread", async () => {
    const { conversationNative, scroller, clicks } = await runInboxRowContractFixture({
      nativeTargetReadAfterProof: { op: "thread.scroll_older", pages: 2 }, scrollFixture: true
    });
    expect(conversationNative).toMatchObject({ availability: "ready", data: { threadNativeId: "observed-thread-7", olderAvailable: true } });
    expect(scroller?.scrollTop).toBe(300);
    expect(clicks).toBe(1);
  });

  it("reads comment and reply native IDs only on the exact selected post", async () => {
    const result = await runFixture("comments.html", "https://www.instagram.com/p/post-42/", {
      op: "comments.replies", target: { accountBinding, nativeId: "post-42" }, limit: 10
    });
    expect(result.data.comments).toEqual([
      { nativeId: "comment-1", text: "Отличная инструкция Спасибо за вопрос", replies: [{ nativeId: "reply-1", text: "Спасибо за вопрос" }] },
      { nativeId: "comment-2", text: "Жду продолжение", replies: [] }
    ]);
    const wrongTarget = await runFixture("comments.html", "https://www.instagram.com/p/post-42/", {
      op: "comments.list", target: { accountBinding, nativeId: "post-99" }
    });
    expect(wrongTarget.availability).toBe("needs_selection");
  });

  it("prepares fixed-source mutation preview without clicking or sending", async () => {
    const result = await runFixture("thread.html", "https://www.instagram.com/direct/t/thread-7/", {
      op: "message.send", target: { accountBinding, nativeId: "thread-7" }, payload: { text: "Точный ответ" }, contextHash: "context-1"
    });
    expect(result).toMatchObject({
      availability: "unsupported_ui_version", data: {
        execution: "disabled_pending_authenticated_ui_verification",
        preview: { source: "browser", action: "message.send", contextHash: "context-1", requiresApproval: true, payload: { text: "Точный ответ" } }
      }
    });
  });

  it("executes one fixed message send only with an exact approved request and fresh context", async () => {
    const inboxUrl = "https://www.instagram.com/direct/inbox/";
    const page = new Window({ url: inboxUrl, settings: { disableJavaScriptEvaluation: false } });
    page.document.write("<!doctype html><html><body><main><header>Direct</header></main></body></html>");
    page.document.close();
    const main = page.document.querySelector("main")!;
    makeVisible(main);
    const nav = page.document.createElement("nav");
    const accountLink = page.document.createElement("a");
    accountLink.href = "/alexfisenkov/";
    nav.append(accountLink);
    main.append(nav);
    makeVisible(nav); makeVisible(accountLink);
    const list = page.document.createElement("div");
    for (const name of ["target conversation", "other conversation"]) {
      const row = makeInboxRowCard(page.document, name);
      const wrapper = page.document.createElement("div");
      wrapper.append(row);
      makeVisible(wrapper);
      list.append(wrapper);
      if (name === "target conversation") row.addEventListener("click", (event) => {
        event.preventDefault();
        page.history.pushState({}, "", "/direct/t/thread-7/");
        const message = page.document.createElement("div");
        message.setAttribute("data-message-id", "msg-1");
        message.textContent = "One message";
        main.append(message);
        makeVisible(message);
      });
    }
    main.append(list);
    makeVisible(list);
    installOwnProfileControlFixture(page, inboxUrl);
    const form = page.document.createElement("form");
    const input = page.document.createElement("textarea");
    input.setAttribute("aria-label", "Message");
    const submit = page.document.createElement("button");
    submit.type = "submit";
    submit.setAttribute("aria-label", "Send");
    form.append(input, submit);
    page.document.querySelector("main")?.append(form);
    let clicks = 0;
    submit.addEventListener("click", (event) => { event.preventDefault(); clicks += 1; });
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    const requestId = "request-123456789012";
    const target = { accountBinding, nativeId: "thread-7" };
    const inbox = await invoke(listener, { kind: "observe", operation: { op: "inbox.list", limit: 2 }, accountBinding, expectedAccountHandle: "alexfisenkov" });
    const rowRead = await invoke(listener, { kind: "observe", operation: { op: "thread.read", target: inbox.data.items[0].target, limit: 2 }, accountBinding, expectedAccountHandle: "alexfisenkov" });
    expect(rowRead.availability).toBe("ready");
    const observation = await invoke(listener, { kind: "observe", operation: { op: "thread.read", target, limit: 50 }, accountBinding, expectedAccountHandle: "alexfisenkov" });
    expect(observation.availability).toBe("ready");
    const contextHash = observation.data.contextHash;
    const intent = { source: "browser", bridgeId: "bridge-1", accountBinding, action: "message.send",
      payload: { kind: "message.send", text: "Точный ответ" }, target, contextHash };
    const fingerprint = await sha256(stableStringify(intent));
    const expiresAt = new Date(Date.now() + 20_000).toISOString();
    const operation = {
      op: "message.send", target, payload: { text: "Точный ответ" },
      contextHash, approval: { taskId: "task-123456789012", bridgeId: "bridge-1", requestId, fingerprint, expectedFingerprint: fingerprint, contextHash, expiresAt }
    };
    try {
      expect(await invoke(listener, { kind: "execute", operation, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: false })).toMatchObject({ status: "FAILED" });
      expect(await invoke(listener, { kind: "execute", operation, accountBinding, expectedAccountHandle: "someone-else", allowWrites: true })).toMatchObject({ status: "FAILED" });
      const messageNode = page.document.querySelector("[data-message-id]");
      const originalText = messageNode?.textContent;
      if (messageNode) messageNode.textContent = "Изменившийся контекст";
      expect(await invoke(listener, { kind: "execute", operation, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true })).toMatchObject({ status: "FAILED" });
      if (messageNode) messageNode.textContent = originalText || "";
      expect(clicks).toBe(0);
      const result = await invoke(listener, { kind: "execute", operation, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true });
      expect(result).toMatchObject({ status: "OUTCOME_UNKNOWN", requestId, contextHash });
      expect(input.value).toBe("Точный ответ");
      expect(clicks).toBe(1);
      const duplicate = await invoke(listener, { kind: "execute", operation, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true });
      expect(duplicate).toMatchObject({ status: "FAILED" });
      expect(clicks).toBe(1);
    } finally { page.happyDOM.abort(); }
  });

  it("binds comment actions to both the parent post URL and the exact comment ID", async () => {
    const html = await readFile(resolve(root, "browser-extension/tests/fixtures/comments.html"), "utf8");
    const page = new Window({ url: "https://www.instagram.com/p/post-42/" });
    page.document.write(html);
    page.document.close();
    installOwnProfileControlFixture(page, "https://www.instagram.com/p/post-42/");
    const comment = page.document.querySelector('[data-comment-id="comment-1"]');
    const like = page.document.createElement("button");
    like.setAttribute("aria-label", "Like");
    comment?.append(like);
    let clicks = 0;
    like.addEventListener("click", () => { clicks += 1; });
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    const postTarget = { accountBinding, nativeId: "post-42" };
    const context = await invoke(listener, { kind: "observe", operation: { op: "comments.list", target: postTarget, limit: 50 }, accountBinding, expectedAccountHandle: "alexfisenkov" });
    const target = { accountBinding, nativeId: "comment-1", instagramUrl: "https://www.instagram.com/p/post-42/" };
    const intent = { source: "browser", bridgeId: "bridge-1", accountBinding, action: "comment.like",
      payload: { kind: "comment.like" }, target, contextHash: context.data.contextHash };
    const fingerprint = await sha256(stableStringify(intent));
    const expiresAt = new Date(Date.now() + 20_000).toISOString();
    const operation = { op: "comment.like", target, payload: {}, contextHash: context.data.contextHash,
      approval: { taskId: "task-comment-123456", bridgeId: "bridge-1", requestId: "comment-123456789012", fingerprint, expectedFingerprint: fingerprint, contextHash: context.data.contextHash, expiresAt } };
    try {
      const result = await invoke(listener, { kind: "execute", operation, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true });
      expect(result).toMatchObject({ status: "OUTCOME_UNKNOWN", requestId: operation.approval.requestId });
      expect(clicks).toBe(1);
      const wrongParent = { ...operation, target: { ...target, instagramUrl: "https://www.instagram.com/p/another-post/" } };
      expect(await invoke(listener, { kind: "execute", operation: wrongParent, accountBinding, expectedAccountHandle: "alexfisenkov", allowWrites: true })).toMatchObject({ status: "FAILED" });
      expect(clicks).toBe(1);
    } finally { page.happyDOM.abort(); }
  });

  it("keeps extension permissions bounded to bridge, alarms and fixed Instagram injection", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "browser-extension/manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["nativeMessaging", "alarms", "scripting"]);
    expect(manifest.host_permissions).toEqual(["https://www.instagram.com/*", "https://instagram.com/*"]);
    expect(JSON.stringify(manifest)).not.toMatch(/<all_urls>|cookies|"tabs"/i);
  });
});

async function runFixture(file: string, url: string, operation: Record<string, unknown>) {
  const html = await readFile(resolve(root, "browser-extension/tests/fixtures", file), "utf8");
  const page = new Window({ url, settings: { disableJavaScriptEvaluation: false } });
  page.document.write(html);
  page.document.close();
  makeVisible(page.document.querySelector("main")!);
  for (const node of page.document.querySelectorAll("[data-message-id], [data-mid]")) makeVisible(node);
  installOwnProfileControlFixture(page, url);
  let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
  Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
  page.eval(contentScript);
  if (!listener) throw new Error("content script did not register its message listener");
  try {
    return await new Promise<any>((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error("content script fixture timed out")), 1_000);
      listener?.({ kind: "observe", operation, accountBinding, expectedAccountHandle: "alexfisenkov" }, {}, (value) => {
        clearTimeout(timer);
        resolveResult(value);
      });
    });
  } finally { page.happyDOM.abort(); }
}

async function runInboxRowContractFixture(options: { shellOnly?: boolean; separateGroups?: boolean; skipRead?: boolean; removeBeforeRead?: boolean;
  switchAccountBeforeRead?: boolean; loadMessages?: boolean; readDeadlineMs?: number; reuseReadRef?: boolean; changeRouteBeforeReuse?: boolean;
  changeRouteAwayAndBackBeforeReuse?: boolean;
  duplicateRead?: boolean; concurrentDistinctRefs?: boolean; inspectDuringRead?: boolean; noRouteChange?: boolean;
  routeChangeDelayMs?: number;
  settleAfterReadMs?: number;
  preexistingStaleMessage?: boolean; hiddenStaleMessageRevealed?: boolean; outOfMainStaleMessageMoved?: boolean;
  loadEventEntries?: boolean; nativeTargetReadAfterProof?: boolean | { op: string; pages?: number }; scrollFixture?: boolean } = {}) {
  const url = "https://www.instagram.com/direct/inbox/";
  const page = new Window({ url, settings: { disableJavaScriptEvaluation: false } });
  page.document.write("<!doctype html><html><body><main><header>Direct</header></main></body></html>");
  page.document.close();
  makeVisible(page.document.querySelector("main")!);
  let staleToReveal: HTMLElement | undefined;
  let staleToMove: HTMLElement | undefined;
  let scroller: HTMLElement | undefined;
  if (options.preexistingStaleMessage || options.hiddenStaleMessageRevealed) {
    const stale = page.document.createElement("div");
    stale.setAttribute("data-message-id", "stale-pre-click");
    stale.textContent = "Stale previous thread";
    page.document.querySelector("main")?.append(stale);
    makeVisible(stale);
    if (options.hiddenStaleMessageRevealed) stale.style.display = "none";
    if (options.hiddenStaleMessageRevealed) staleToReveal = stale;
  }
  if (options.outOfMainStaleMessageMoved) {
    const outside = page.document.createElement("aside");
    staleToMove = page.document.createElement("div");
    staleToMove.setAttribute("data-mid", "stale-outside-main");
    staleToMove.textContent = "Stale outside main";
    outside.append(staleToMove);
    page.document.body.append(outside);
    makeVisible(staleToMove);
  }
  let clicks = 0;
  const rows: HTMLElement[] = [];
  if (!options.shellOnly) {
    const groupCount = options.separateGroups ? 2 : 1;
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const list = page.document.createElement("div");
      if (options.separateGroups) {
        const heading = page.document.createElement("div");
        heading.textContent = `Group ${groupIndex}`;
        list.append(heading);
        makeVisible(heading);
      }
      const rowCount = options.separateGroups ? 1 : 2;
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = makeInboxRowCard(page.document, `Conversation ${groupIndex}-${rowIndex}`);
        rows.push(row);
        row.addEventListener("click", (event) => {
          event.preventDefault();
          clicks++;
          const finishNavigation = () => {
            if (!options.noRouteChange) page.history.pushState({}, "", "/direct/t/observed-thread-7/");
            if (staleToReveal) staleToReveal.style.display = "";
            if (staleToMove) page.document.querySelector("main")?.append(staleToMove);
            if (options.loadEventEntries) {
              page.document.querySelector("main")?.setAttribute("role", "main");
              for (const text of ["Older history is unavailable", "A story was shared"]) {
                const entry = page.document.createElement("div");
                entry.setAttribute("role", "article");
                entry.textContent = text;
                page.document.querySelector("main")?.append(entry);
                makeVisible(entry);
              }
            }
            if (options.loadMessages !== false) {
              const message = page.document.createElement("div");
              message.setAttribute("data-message-id", "msg-1");
              message.textContent = "One message";
              page.document.querySelector("main")?.append(message);
              makeVisible(message);
            }
            if (options.loadMessages !== false && options.scrollFixture) {
              scroller = page.document.createElement("div");
              scroller.setAttribute("role", "log");
              page.document.querySelector("main")?.append(scroller);
              Object.defineProperties(scroller, { scrollHeight: { value: 1_000 }, clientHeight: { value: 200 }, scrollTop: { value: 800, writable: true } });
              makeVisible(scroller);
            }
          };
          if (options.routeChangeDelayMs) setTimeout(finishNavigation, options.routeChangeDelayMs);
          else finishNavigation();
        });
        const wrapper1 = page.document.createElement("div");
        const wrapper2 = page.document.createElement("div");
        const wrapper3 = page.document.createElement("div");
        wrapper1.append(row); wrapper2.append(wrapper1); wrapper3.append(wrapper2); list.append(wrapper3);
        makeVisible(wrapper1); makeVisible(wrapper2); makeVisible(wrapper3);
      }
      makeVisible(list);
      page.document.querySelector("main")?.append(list);
    }
  }
  installOwnProfileControlFixture(page, url);
  let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
  Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
  page.eval(contentScript);
  try {
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    const inbox = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: expiresAt,
      operation: { op: "inbox.list", limit: 2 } });
    if (options.skipRead || !inbox.data?.items?.[0]?.target) return { inbox, clicks, url: page.location.href };
    if (options.removeBeforeRead) rows[0]?.remove();
    if (options.switchAccountBeforeRead) {
      const profile = page.document.querySelector('a[role="link"]');
      const image = profile?.querySelector("img");
      if (profile) profile.href = "/otheraccount/";
      if (image) image.alt = "Profile picture of otheraccount";
    }
    const readExpiresAt = new Date(Date.now() + (options.readDeadlineMs ?? 5_000)).toISOString();
    const readMessage = { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: readExpiresAt,
      operation: { op: "thread.read", target: inbox.data.items[0].target, limit: 2 } };
    let conversation;
    let conversationDuplicate;
    let concurrentConversation;
    let concurrentInspect;
    if (options.duplicateRead) [conversation, conversationDuplicate] = await Promise.all([invoke(listener, readMessage), invoke(listener, readMessage)]);
    else if (options.concurrentDistinctRefs) {
      const secondMessage = { ...readMessage, operation: { op: "thread.read", target: inbox.data.items[1].target, limit: 2 } };
      [conversation, concurrentConversation] = await Promise.all([invoke(listener, readMessage), invoke(listener, secondMessage)]);
    } else if (options.inspectDuringRead) {
      const pendingConversation = invoke(listener, readMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      concurrentInspect = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        taskExpiresAt: new Date(Date.now() + 5_000).toISOString(), operation: { op: "account.inspect" } });
      conversation = await pendingConversation;
    } else conversation = await invoke(listener, readMessage);
    let conversationNative;
    if (options.nativeTargetReadAfterProof) {
      const nativeOperation = typeof options.nativeTargetReadAfterProof === "object"
        ? { ...options.nativeTargetReadAfterProof, target: { accountBinding, nativeId: "observed-thread-7" }, limit: 2 }
        : { op: "thread.read", target: { accountBinding, nativeId: "observed-thread-7" }, limit: 2 };
      conversationNative = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        taskExpiresAt: new Date(Date.now() + 5_000).toISOString(), operation: nativeOperation });
    }
    let conversationAgain;
    if (options.reuseReadRef) {
      if (options.changeRouteBeforeReuse) page.history.pushState({}, "", "/direct/t/another-thread/");
      if (options.changeRouteAwayAndBackBeforeReuse) {
        page.history.pushState({}, "", "/direct/t/another-thread/");
        page.document.body.append(page.document.createElement("div"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        page.history.pushState({}, "", "/direct/t/observed-thread-7/");
        page.document.body.append(page.document.createElement("div"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      conversationAgain = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        taskExpiresAt: new Date(Date.now() + 5_000).toISOString(), operation: { op: "thread.read", target: inbox.data.items[0].target, limit: 2 } });
    }
    if (options.settleAfterReadMs) await new Promise((resolve) => setTimeout(resolve, options.settleAfterReadMs));
    return { inbox, conversation, conversationAgain, conversationDuplicate, concurrentConversation, concurrentInspect, conversationNative, scroller, clicks, url: page.location.href };
  } finally { page.happyDOM.abort(); }
}

async function runInboxThreadSidebarCycleFixture() {
  const inboxUrl = "https://www.instagram.com/direct/inbox/";
  const page = new Window({ url: inboxUrl, settings: { disableJavaScriptEvaluation: false } });
  page.document.write("<!doctype html><html><body><main><header>Direct</header></main></body></html>");
  page.document.close();
  makeVisible(page.document.querySelector("main")!);
  let clicks = 0;
  const group = page.document.createElement("div");
  for (const [index, routeId] of ["thread-a", "thread-b"].entries()) {
    const row = makeInboxRowCard(page.document, `Conversation ${routeId}`);
    row.addEventListener("click", (event) => {
      event.preventDefault();
      clicks += 1;
      page.history.pushState({}, "", `/direct/t/${routeId}/`);
      const message = page.document.createElement("div");
      message.setAttribute("data-message-id", `${routeId}-message`);
      message.textContent = `Thread ${index === 0 ? "A" : "B"} message`;
      page.document.querySelector("main")?.append(message);
      makeVisible(message);
    });
    const outer = page.document.createElement("div");
    const middle = page.document.createElement("div");
    const inner = page.document.createElement("div");
    inner.append(row); middle.append(inner); outer.append(middle); group.append(outer);
    makeVisible(outer); makeVisible(middle); makeVisible(inner);
  }
  makeVisible(group);
  page.document.querySelector("main")?.append(group);
  installOwnProfileControlFixture(page, inboxUrl);
  let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
  Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
  page.eval(contentScript);
  const deadline = () => new Date(Date.now() + 5_000).toISOString();
  try {
    const inbox = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: deadline(),
      operation: { op: "inbox.list", limit: 2 } });
    const firstRead = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: deadline(),
      operation: { op: "thread.read", target: inbox.data.items[0]?.target, limit: 2 } });
    const inboxOnThread = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: deadline(),
      operation: { op: "inbox.list", limit: 2 } });
    const sameThreadReuse = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: deadline(),
      operation: { op: "thread.read", target: inboxOnThread.data.items[0]?.target, limit: 2 } });
    const secondRead = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: deadline(),
      operation: { op: "thread.read", target: inboxOnThread.data.items[1]?.target, limit: 2 } });
    return { firstRead, inboxOnThread, sameThreadReuse, secondRead, clicks, url: page.location.href };
  } finally { page.happyDOM.abort(); }
}

function makeInboxRowCard(document: Document, label: string): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  const image = document.createElement("img");
  image.alt = "Conversation avatar";
  row.append(image);
  let parent: HTMLElement = row;
  for (let index = 0; index < 15; index += 1) {
    const child = document.createElement("div");
    if (index === 0) child.textContent = label;
    parent.append(child);
    parent = child;
  }
  for (let index = 0; index < 13; index += 1) {
    const span = document.createElement("span");
    span.textContent = index === 0 ? label : `Part ${index}`;
    parent.append(span);
  }
  makeVisible(row); makeVisible(image);
  return row;
}

function installOwnProfileControlFixture(page: Window, returnUrl: string) {
  const rail = page.document.createElement("div");
  const profile = page.document.createElement("a");
  profile.setAttribute("role", "link");
  profile.href = "/alexfisenkov/";
  const image = page.document.createElement("img");
  image.alt = "Profile picture of alexfisenkov";
  profile.append(image);
  rail.append(profile);
  page.document.body.append(rail);
  makeVisible(profile);
  makeVisible(image);
  let header: HTMLElement | undefined;
  profile.addEventListener("click", (event) => {
    event.preventDefault();
    page.history.pushState({}, "", "/alexfisenkov/");
    header = page.document.createElement("header");
    const edit = page.document.createElement("a");
    edit.setAttribute("role", "link");
    edit.href = "/accounts/edit/";
    edit.textContent = "Редактировать профиль";
    header.append(edit);
    page.document.body.append(header);
    makeVisible(edit);
  });
  Object.defineProperty(page.history, "back", { value: () => {
    header?.remove();
    page.history.pushState({}, "", new URL(returnUrl).pathname);
  } });
}

async function runOwnProfileInspectFixture(options: { avatarHandle: string; editLabel: string; ambiguous?: boolean; restore?: boolean; restoreDelayMs?: number; followup?: boolean; switchHandleBeforeFollowup?: string; keepExpectedRecipientAvatar?: boolean; replaceOwnControlWithMatchingAvatar?: boolean; expectedHandle?: string | null; taskExpiresAt?: string }) {
  const initialUrl = "https://www.instagram.com/direct/inbox/";
  const page = new Window({ url: initialUrl, settings: { disableJavaScriptEvaluation: false } });
  page.document.write("<!doctype html><html><body></body></html>");
  page.document.close();
  const rail = page.document.createElement("div");
  const profile = page.document.createElement("a");
  profile.setAttribute("role", "link");
  profile.href = `/${options.avatarHandle}/`;
  const image = page.document.createElement("img");
  image.alt = `Profile picture of ${options.avatarHandle}`;
  profile.append(image);
  rail.append(profile);
  page.document.body.append(rail);
  makeVisible(profile);
  makeVisible(image);
  const conversation = page.document.createElement("a");
  conversation.href = "/direct/t/thread-7/";
  conversation.textContent = "Conversation fixture";
  page.document.body.append(conversation);
  if (options.ambiguous) {
    const duplicate = profile.cloneNode(true) as HTMLAnchorElement;
    rail.append(duplicate);
    makeVisible(duplicate);
    makeVisible(duplicate.querySelector("img")!);
  }
  let clicks = 0;
  let profileHeader: HTMLElement | undefined;
  profile.addEventListener("click", (event) => {
    event.preventDefault();
    clicks += 1;
    page.history.pushState({}, "", `/${options.avatarHandle}/`);
    const header = page.document.createElement("header");
    profileHeader = header;
    const edit = page.document.createElement("a");
    edit.setAttribute("role", "link");
    edit.href = "/accounts/edit/";
    edit.textContent = options.editLabel;
    header.append(edit);
    page.document.body.append(header);
    makeVisible(edit);
  });
  Object.defineProperty(page.history, "back", { value: () => {
    if (options.restore !== false) {
      profileHeader?.remove();
      if (options.restoreDelayMs) setTimeout(() => page.history.pushState({}, "", "/direct/inbox/"), options.restoreDelayMs);
      else page.history.pushState({}, "", "/direct/inbox/");
    }
  } });
  let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
  Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
  page.eval(contentScript);
  try {
    const result = await invoke(listener, { kind: "observe", accountBinding,
      ...(options.expectedHandle === null ? {} : { expectedAccountHandle: options.expectedHandle ?? "alexfisenkov" }),
      ...(options.taskExpiresAt ? { taskExpiresAt: options.taskExpiresAt } : {}), operation: { op: "account.inspect" } });
    if (options.switchHandleBeforeFollowup) {
      profile.href = `/${options.switchHandleBeforeFollowup}/`;
      image.alt = `Profile picture of ${options.switchHandleBeforeFollowup}`;
      if (options.keepExpectedRecipientAvatar) {
        const recipient = profile.cloneNode(true) as HTMLAnchorElement;
        recipient.href = "/alexfisenkov/";
        recipient.querySelector("img")!.alt = "Profile picture of alexfisenkov";
        rail.append(recipient);
        makeVisible(recipient);
        makeVisible(recipient.querySelector("img")!);
      }
    }
    if (options.replaceOwnControlWithMatchingAvatar) {
      profile.remove();
      const replacement = profile.cloneNode(true) as HTMLAnchorElement;
      rail.append(replacement);
      makeVisible(replacement);
      makeVisible(replacement.querySelector("img")!);
    }
    const followup = options.followup
      ? await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", taskExpiresAt: new Date(Date.now() + 60_000).toISOString(), operation: { op: "inbox.list", limit: 5 } })
      : undefined;
    return { result, clicks, url: page.location.href, followup };
  } finally { page.happyDOM.abort(); }
}

async function runUnverifiedInboxFixture() {
  const page = new Window({ url: "https://www.instagram.com/direct/inbox/", settings: { disableJavaScriptEvaluation: false } });
  page.document.write('<!doctype html><html><body><nav><a href="/alexfisenkov/" aria-label="Profile">Profile</a></nav><main><a href="/direct/t/thread-7/">Conversation</a></main></body></html>');
  page.document.close();
  let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
  Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
  page.eval(contentScript);
  try { return await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", operation: { op: "inbox.list", limit: 5 } }); }
  finally { page.happyDOM.abort(); }
}

function makeVisible(element: Element) {
  Object.defineProperty(element, "getBoundingClientRect", { value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 32, bottom: 32, width: 32, height: 32, toJSON: () => ({}) }) });
  Object.defineProperty(element, "getClientRects", { value: () => [{ length: 1 }] });
}

function invoke(listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined, message: unknown) {
  if (!listener) throw new Error("content script did not register its message listener");
  return new Promise<any>((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error("content script fixture timed out")), 3_000);
    listener?.(message, {}, (value) => { clearTimeout(timer); resolveResult(value); });
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
