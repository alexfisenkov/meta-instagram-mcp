import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const contentScript = await readFile(resolve(root, "browser-extension/content-script.js"), "utf8");
const accountBinding = "owner:alex";

describe("Instagram content script against DOM fixtures", () => {
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
    ["a different profile image", "someone-else", "Редактировать профиль"],
    ["a public profile without the own Edit profile control", "alexfisenkov", "Поделиться профилем"]
  ])("does not verify account.inspect from %s", async (_reason, avatarHandle, editLabel) => {
    const { result, clicks } = await runOwnProfileInspectFixture({ avatarHandle, editLabel });
    expect(result.availability).toBe("needs_selection");
    expect(result.coverage).toBe("unknown");
    expect(clicks).toBe(avatarHandle === "alexfisenkov" ? 1 : 0);
  });

  it("rejects an ambiguous own-profile control and does not choose one arbitrarily", async () => {
    const { result, clicks } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", ambiguous: true });
    expect(result.availability).toBe("needs_selection");
    expect(clicks).toBe(0);
  });

  it("invalidates the within-document proof when the avatar control changes accounts", async () => {
    const { result, clicks, followup } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", followup: true, switchHandleBeforeFollowup: "otheraccount" });
    expect(result.availability).toBe("ready");
    expect(followup).toMatchObject({ availability: "needs_selection", coverage: "unknown" });
    expect(clicks).toBe(1);
  });

  it("does not reuse proof for a replacement control while an expected-handle recipient avatar remains", async () => {
    const { result, clicks, followup } = await runOwnProfileInspectFixture({ avatarHandle: "alexfisenkov", editLabel: "Редактировать профиль", followup: true,
      switchHandleBeforeFollowup: "otheraccount", keepExpectedRecipientAvatar: true });
    expect(result.availability).toBe("ready");
    expect(followup).toMatchObject({ availability: "needs_selection", coverage: "unknown" });
    expect(clicks).toBe(1);
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

  it("reads only the selected thread and marks the possible mark-seen side effect", async () => {
    const result = await runFixture("thread.html", "https://www.instagram.com/direct/t/thread-7/", {
      op: "thread.read", target: { accountBinding, nativeId: "thread-7" }, limit: 10
    });
    expect(result).toMatchObject({
      availability: "ready", source: "browser", sideEffects: ["may_mark_seen"],
      data: { threadNativeId: "thread-7", unread: "unknown", unanswered: "unknown", messages: [
        { nativeId: "msg-101", direction: "inbound" }, { nativeId: "msg-102", direction: "outbound" }
      ] }
    });
    const wrongTarget = await runFixture("thread.html", "https://www.instagram.com/direct/t/thread-7/", {
      op: "thread.read", target: { accountBinding, nativeId: "thread-8" }
    });
    expect(wrongTarget.availability).toBe("needs_selection");
  });

  it("scrolls the exact selected thread by the bounded older-history page budget", async () => {
    const html = await readFile(resolve(root, "browser-extension/tests/fixtures/thread.html"), "utf8");
    const page = new Window({ url: "https://www.instagram.com/direct/t/thread-7/" });
    page.document.write(html); page.document.close();
    installOwnProfileControlFixture(page, "https://www.instagram.com/direct/t/thread-7/");
    const scroller = page.document.querySelector('[role="log"]') as HTMLElement;
    Object.defineProperties(scroller, { scrollHeight: { value: 1_000 }, clientHeight: { value: 200 }, scrollTop: { value: 800, writable: true } });
    let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
    Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
    page.eval(contentScript);
    try {
      const first = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        operation: { op: "thread.scroll_older", target: { accountBinding, nativeId: "thread-7" }, pages: 2, limit: 10 } });
      expect(scroller.scrollTop).toBe(300);
      expect(first).toMatchObject({ availability: "ready", data: { olderAvailable: true } });
      const second = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov",
        operation: { op: "thread.scroll_older", target: { accountBinding, nativeId: "thread-7" }, pages: 2, limit: 10 } });
      expect(scroller.scrollTop).toBe(0);
      expect(second.data.olderAvailable).toBe(false);
    } finally { page.happyDOM.abort(); }
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
    const html = await readFile(resolve(root, "browser-extension/tests/fixtures/thread.html"), "utf8");
    const page = new Window({ url: "https://www.instagram.com/direct/t/thread-7/" });
    page.document.write(html);
    page.document.close();
    installOwnProfileControlFixture(page, "https://www.instagram.com/direct/t/thread-7/");
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
    const observation = await invoke(listener, { kind: "observe", operation: { op: "thread.read", target, limit: 50 }, accountBinding, expectedAccountHandle: "alexfisenkov" });
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

  it("keeps extension permissions limited to Instagram and Native Messaging", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "browser-extension/manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual(["https://www.instagram.com/*", "https://instagram.com/*"]);
    expect(JSON.stringify(manifest)).not.toMatch(/<all_urls>|cookies|tabs|scripting/i);
  });
});

async function runFixture(file: string, url: string, operation: Record<string, unknown>) {
  const html = await readFile(resolve(root, "browser-extension/tests/fixtures", file), "utf8");
  const page = new Window({ url, settings: { disableJavaScriptEvaluation: false } });
  page.document.write(html);
  page.document.close();
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

async function runOwnProfileInspectFixture(options: { avatarHandle: string; editLabel: string; ambiguous?: boolean; restore?: boolean; followup?: boolean; switchHandleBeforeFollowup?: string; keepExpectedRecipientAvatar?: boolean; replaceOwnControlWithMatchingAvatar?: boolean }) {
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
      page.history.pushState({}, "", "/direct/inbox/");
    }
  } });
  let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
  Object.defineProperty(page, "chrome", { value: { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } } });
  page.eval(contentScript);
  try {
    const result = await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", operation: { op: "account.inspect" } });
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
      ? await invoke(listener, { kind: "observe", accountBinding, expectedAccountHandle: "alexfisenkov", operation: { op: "inbox.list", limit: 5 } })
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
