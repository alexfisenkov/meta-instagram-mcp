(() => {
  "use strict";

  const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
  const RESERVED = new Set(["accounts", "about", "api", "challenge", "developer", "direct", "explore", "legal", "oauth", "p", "privacy", "reel", "reels", "stories", "web"]);
  const READ_OPS = new Set(["account.inspect", "account.snapshot", "inbox.list", "thread.read", "thread.scroll_older", "comments.list", "comments.replies", "insights.read"]);
  const PREVIEW_OPS = new Set(["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"]);
  const MUTATION_OPS = PREVIEW_OPS;
  const LIVE_CAPABILITIES = Object.freeze(["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies",
    "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"]);
  const executedRequests = new Set();
  const MAX_LIMIT = 100;
  const MAX_SCROLL_PAGES = 5;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !["observe", "execute"].includes(message.kind)) return false;
    const task = message.kind === "execute" ? runMutation(message) : runOperation(message);
    void task.then(sendResponse).catch(() => sendResponse(failure(message.accountBinding, "unsupported_ui_version", "browser operation failed")));
    return true;
  });

  async function runOperation(message) {
    const { operation, accountBinding, expectedAccountHandle } = message;
    if (!isInstagramPage() || !validBinding(accountBinding) || !validHandle(expectedAccountHandle) || !isRecord(operation) || typeof operation.op !== "string") {
      return failure(accountBinding, "unsupported_ui_version", "invalid Instagram page or operation");
    }
    const username = findAccountHandle();
    if (!username) return failure(accountBinding, "needs_selection", "current Instagram account could not be identified");
    if (username.toLowerCase() !== expectedAccountHandle.toLowerCase()) return failure(accountBinding, "needs_selection", "current Instagram account does not match the assigned account");
    if (PREVIEW_OPS.has(operation.op)) return previewResult(operation, accountBinding, username);
    if (!READ_OPS.has(operation.op)) return failure(accountBinding, "unsupported", "operation is not allowlisted");

    if (operation.op === "account.inspect" || operation.op === "account.snapshot") {
      return observation(accountBinding, { username, accountBinding, loggedIn: true, surface: "instagram", capabilities: LIVE_CAPABILITIES }, "ready", "complete", "not_applicable", []);
    }
    if (operation.op === "inbox.list") return readInbox(accountBinding, username, operation.limit);
    if (operation.op === "thread.read" || operation.op === "thread.scroll_older") return readThread(accountBinding, username, operation);
    if (operation.op === "comments.list" || operation.op === "comments.replies") return readComments(accountBinding, username, operation);
    if (operation.op === "insights.read") return failure(accountBinding, "unsupported_ui_version", "insights semantic controls are not verified");
    return failure(accountBinding, "unsupported", "operation is not allowlisted");
  }

  function readInbox(accountBinding, username, requestedLimit) {
    const limit = boundedInteger(requestedLimit, 1, MAX_LIMIT, 50);
    const items = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll('a[href^="/direct/t/"]')) {
      const url = safeInstagramUrl(anchor.href);
      const id = url?.pathname.match(/^\/direct\/t\/([^/]+)\/?$/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row = anchor.closest('[role="listitem"], li, [role="link"]') || anchor;
      const text = cleanText(row.innerText || row.textContent, 600);
      const labels = [anchor.getAttribute("aria-label"), row.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
      const unread = /\b(unread|new)\b|непрочитан|нов(ое|ый)/i.test(labels) ? true : "unknown";
      items.push({ nativeId: id, href: url.pathname, label: text || "", unread, unanswered: "unknown" });
      if (items.length >= limit) break;
    }
    const coverage = items.length >= limit ? "partial" : "unknown";
    return observation(accountBinding, { username, items }, "ready", coverage, "limited", [], { sideEffects: [] });
  }

  async function readThread(accountBinding, username, operation) {
    const target = operation.target;
    if (!isRecord(target) || !validBinding(target.accountBinding) || target.accountBinding !== accountBinding || typeof target.nativeId !== "string") {
      return failure(accountBinding, "needs_selection", "an exact conversation reference is required");
    }
    const expectedId = target.nativeId.slice(0, 256);
    const currentId = location.pathname.match(/^\/direct\/t\/([^/]+)\/?$/)?.[1];
    if (!currentId || currentId !== expectedId) return failure(accountBinding, "needs_selection", "the selected conversation does not match the requested reference");

    const pages = operation.op === "thread.scroll_older" ? boundedInteger(operation.pages, 1, MAX_SCROLL_PAGES, 1) : 0;
    let scroller = findMessageScroller();
    if (pages > 0) {
      if (!scroller) return failure(accountBinding, "unsupported_ui_version", "the message history scroll area was not found");
      for (let index = 0; index < pages; index += 1) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(250, scroller.clientHeight || 500));
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      scroller = findMessageScroller();
    }

    const limit = boundedInteger(operation.limit, 1, MAX_LIMIT, 50);
    const messages = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('[data-message-id], [data-mid]')) {
      const id = node.getAttribute("data-message-id") || node.getAttribute("data-mid");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = [node.getAttribute("aria-label"), node.getAttribute("data-testid")].filter(Boolean).join(" ");
      const direction = /you sent|sent by you|вы отправили|отправлено вами/i.test(label) ? "outbound"
        : /sent by|отправил|отправила/i.test(label) ? "inbound" : "unknown";
      messages.push({ nativeId: id.slice(0, 256), text: cleanText(node.innerText || node.textContent, 2_000), direction, timestamp: node.getAttribute("data-timestamp") || "unknown" });
      if (messages.length >= limit) break;
    }
    const data = { username, threadNativeId: expectedId, messages, unread: readUnreadState(), unanswered: "unknown",
      olderAvailable: Boolean(scroller && scroller.scrollTop > 0) };
    const contextHash = await digest(stableStringify({ accountBinding, target: { nativeId: expectedId }, data }));
    return observation(accountBinding, { ...data, contextHash }, "ready", messages.length >= limit ? "partial" : "unknown", "limited", ["may_mark_seen"], { sideEffects: ["may_mark_seen"] });
  }

  async function readComments(accountBinding, username, operation) {
    const target = operation.target;
    if (!isRecord(target) || target.accountBinding !== accountBinding || typeof target.nativeId !== "string") return failure(accountBinding, "needs_selection", "an exact post reference is required");
    const currentMediaId = safeInstagramUrl(location.href)?.pathname.match(/^\/(?:p|reel|tv)\/([^/]+)\/?$/)?.[1];
    const selectedPostId = target.instagramUrl ? mediaIdFromUrl(target.instagramUrl) : target.nativeId;
    if (!currentMediaId || currentMediaId !== selectedPostId) return failure(accountBinding, "needs_selection", "the selected post does not match the requested reference");
    const limit = boundedInteger(operation.limit, 1, MAX_LIMIT, 50);
    const comments = [];
    const seen = new Set();
    for (const node of document.querySelectorAll("[data-comment-id]")) {
      const id = node.getAttribute("data-comment-id");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const replies = [];
      if (operation.op === "comments.replies") {
        for (const reply of node.querySelectorAll("[data-reply-id]")) {
          const replyId = reply.getAttribute("data-reply-id");
          if (replyId) replies.push({ nativeId: replyId.slice(0, 256), text: cleanText(reply.innerText || reply.textContent, 2_000) });
        }
      }
      comments.push({ nativeId: id.slice(0, 256), text: cleanText(node.innerText || node.textContent, 2_000), replies });
      if (comments.length >= limit) break;
    }
    const data = { username, postNativeId: currentMediaId.slice(0, 256), comments };
    const contextHash = await digest(stableStringify({ accountBinding, target: { nativeId: currentMediaId }, data }));
    return observation(accountBinding, { ...data, contextHash }, "ready", comments.length >= limit ? "partial" : "unknown", "limited", []);
  }

  function previewResult(operation, accountBinding, username) {
    const target = operation.target;
    const payload = operation.payload;
    if (!isRecord(target) || target.accountBinding !== accountBinding || typeof target.nativeId !== "string" || !isRecord(payload)) {
      return failure(accountBinding, "needs_selection", "an exact target and typed payload are required");
    }
    if (operation.op.startsWith("message.")) {
      const threadId = safeInstagramUrl(location.href)?.pathname.match(/^\/direct\/t\/([^/]+)\/?$/)?.[1];
      if (threadId !== target.nativeId) return failure(accountBinding, "needs_selection", "the selected conversation does not match the requested reference");
    } else {
      const mediaId = safeInstagramUrl(location.href)?.pathname.match(/^\/(?:p|reel|tv)\/([^/]+)\/?$/)?.[1];
      const expectedPost = target.instagramUrl ? mediaIdFromUrl(target.instagramUrl) : target.nativeId;
      if (mediaId !== expectedPost) return failure(accountBinding, "needs_selection", "the selected post does not match the requested reference");
    }
    if (typeof operation.contextHash !== "string" || operation.contextHash.length < 1 || operation.contextHash.length > 128) {
      return failure(accountBinding, "needs_selection", "a fresh context fingerprint is required");
    }
    const text = typeof payload.text === "string" ? payload.text.slice(0, 2_000) : undefined;
    if (["message.send", "comment.reply", "comment.private_reply"].includes(operation.op) && text === undefined) {
      return failure(accountBinding, "unsupported", "the exact reply text is required");
    }
    const reaction = typeof payload.reaction === "string" ? payload.reaction.slice(0, 64) : undefined;
    if (["message.react", "message.unreact"].includes(operation.op) && !reaction) {
      return failure(accountBinding, "unsupported", "the exact reaction is required");
    }
    return observation(accountBinding, {
      username,
      preview: { source: "browser", action: operation.op, target: { accountBinding, nativeId: target.nativeId.slice(0, 256) }, payload: text !== undefined ? { text } : reaction !== undefined ? { reaction } : {}, contextHash: operation.contextHash, requiresApproval: true },
      execution: "disabled_pending_authenticated_ui_verification"
    }, "unsupported_ui_version", "unknown", "not_applicable", []);
  }

  async function runMutation(message) {
    const operation = message.operation;
    const accountBinding = message.accountBinding;
    if (message.allowWrites !== true) return mutationFailure("FAILED", "browser write gate is disabled");
    if (!isInstagramPage() || !validBinding(accountBinding) || !isRecord(operation) || !MUTATION_OPS.has(operation.op)) return mutationFailure("FAILED", "operation is not allowlisted");
    const username = findAccountHandle();
    if (!username || username.toLowerCase() !== String(message.expectedAccountHandle || "").toLowerCase()) return mutationFailure("FAILED", "current Instagram account does not match the assigned account");
    const approval = operation.approval;
    if (!isRecord(approval) || typeof approval.requestId !== "string" || !/^[\w-]{16,128}$/.test(approval.requestId) ||
        typeof approval.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(approval.fingerprint) || approval.expectedFingerprint !== approval.fingerprint ||
        approval.contextHash !== operation.contextHash || !approval.taskId || !approval.expiresAt ||
        Date.parse(approval.expiresAt) <= Date.now() || Date.parse(approval.expiresAt) - Date.now() > 30_000 ||
        executedRequests.has(approval.requestId)) return mutationFailure("FAILED", "the write approval is missing, stale, or already used");
    const target = operation.target;
    const payload = operation.payload;
    if (!isRecord(target) || target.accountBinding !== accountBinding || !isRecord(payload) ||
        typeof operation.contextHash !== "string" || !/^[a-f\d]{16,128}$/i.test(operation.contextHash)) return mutationFailure("FAILED", "exact target, payload, and context are required");
    const actualHash = await freshContextHash(operation, accountBinding);
    if (!actualHash || actualHash !== operation.contextHash) return mutationFailure("FAILED", "the UI target or context changed after approval");
    const typedPayload = operation.op === "message.send" || operation.op === "comment.reply" || operation.op === "comment.private_reply"
      ? { kind: operation.op, text: payload.text }
      : operation.op === "message.react" || operation.op === "message.unreact"
        ? { kind: operation.op, reaction: payload.reaction } : { kind: operation.op };
    const intent = { source: "browser", bridgeId: approval.bridgeId, accountBinding, action: operation.op,
      payload: typedPayload, target, contextHash: operation.contextHash };
    if (!approval.bridgeId || await digest(stableStringify(intent)) !== approval.fingerprint) return mutationFailure("FAILED", "the approval fingerprint does not match this exact action");
    const dispatchHash = await freshContextHash(operation, accountBinding);
    if (!dispatchHash || dispatchHash !== operation.contextHash || Date.parse(approval.expiresAt) <= Date.now()) return mutationFailure("FAILED", "the UI context or approval lease changed before dispatch");
    const action = findMutationControl(operation);
    if (!action) return mutationFailure("FAILED", "the exact semantic control is missing or ambiguous");
    if (!payloadMatches(operation)) return mutationFailure("FAILED", "the exact typed payload is invalid");
    executedRequests.add(approval.requestId);
    if (executedRequests.size > 512) executedRequests.delete(executedRequests.values().next().value);
    try {
      if (action.input) {
        action.input.focus();
        setNativeValue(action.input, payload.text);
        action.input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        action.input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      action.button.click();
      return { status: "OUTCOME_UNKNOWN", reason: "One final browser control was clicked; delivery was not independently read back.", requestId: approval.requestId, contextHash: operation.contextHash };
    } catch {
      return { status: "OUTCOME_UNKNOWN", reason: "Browser control dispatch may have started; no retry was made.", requestId: approval.requestId, contextHash: operation.contextHash };
    }
  }

  async function freshContextHash(operation, accountBinding) {
    const target = operation.target;
    if (operation.op.startsWith("message.")) {
      const threadId = safeInstagramUrl(location.href)?.pathname.match(/^\/direct\/t\/([^/]+)\/?$/)?.[1];
      if (!threadId || threadId !== target.nativeId) return "";
      const messages = Array.from(document.querySelectorAll("[data-message-id], [data-mid]"), (node) => {
        const id = node.getAttribute("data-message-id") || node.getAttribute("data-mid");
        const label = [node.getAttribute("aria-label"), node.getAttribute("data-testid")].filter(Boolean).join(" ");
        const direction = /you sent|sent by you|вы отправили|отправлено вами/i.test(label) ? "outbound"
          : /sent by|отправил|отправила/i.test(label) ? "inbound" : "unknown";
        return { nativeId: id.slice(0, 256), text: cleanText(node.innerText || node.textContent, 2_000), direction, timestamp: node.getAttribute("data-timestamp") || "unknown" };
      }).slice(0, 50);
      const scroller = findMessageScroller();
      const data = { username: findAccountHandle(), threadNativeId: threadId, messages, unread: readUnreadState(), unanswered: "unknown",
        olderAvailable: Boolean(scroller && scroller.scrollTop > 0) };
      return digest(stableStringify({ accountBinding, target: { nativeId: threadId }, data }));
    }
    const postId = target.instagramUrl ? mediaIdFromUrl(target.instagramUrl) : "";
    const currentPost = safeInstagramUrl(location.href)?.pathname.match(/^\/(?:p|reel|tv)\/([^/]+)\/?$/)?.[1];
    if (!postId || postId !== currentPost) return "";
    const comments = Array.from(document.querySelectorAll("[data-comment-id]"), (node) => {
      const replies = [];
      if (operation.op === "comments.replies") for (const reply of node.querySelectorAll("[data-reply-id]")) {
        const replyId = reply.getAttribute("data-reply-id");
        if (replyId) replies.push({ nativeId: replyId.slice(0, 256), text: cleanText(reply.innerText || reply.textContent, 2_000) });
      }
      return { nativeId: node.getAttribute("data-comment-id").slice(0, 256), text: cleanText(node.innerText || node.textContent, 2_000), replies };
    }).slice(0, 50);
    return digest(stableStringify({ accountBinding, target: { nativeId: postId }, data: { username: findAccountHandle(), postNativeId: postId, comments } }));
  }

  function findMutationControl(operation) {
    if (operation.op === "message.send") {
      const inputs = Array.from(document.querySelectorAll('main textarea[aria-label], main [contenteditable="true"][aria-label]'))
        .filter((node) => /^(message|сообщение)$/i.test(node.getAttribute("aria-label") || ""));
      if (inputs.length !== 1) return null;
      const forms = inputs[0].closest("form");
      const buttons = forms ? Array.from(forms.querySelectorAll("button[type=submit]"))
        .filter((node) => /^(send|отправить)$/i.test(node.getAttribute("aria-label") || node.innerText || "")) : [];
      return buttons.length === 1 ? { input: inputs[0], button: buttons[0] } : null;
    }
    const target = operation.target;
    if (operation.op.startsWith("message.")) {
      const messageNativeId = target.explicitOwnerRef;
      if (!messageNativeId) return null;
      const nodes = Array.from(document.querySelectorAll("[data-message-id], [data-mid]")).filter((node) => (node.getAttribute("data-message-id") || node.getAttribute("data-mid")) === messageNativeId);
      if (nodes.length !== 1) return null;
      const labels = operation.op === "message.react" ? [`React with ${operation.payload.reaction}`] : [`Remove ${operation.payload.reaction} reaction`];
      return uniqueButton(nodes[0], labels);
    }
    const comments = Array.from(document.querySelectorAll("[data-comment-id]")).filter((node) => node.getAttribute("data-comment-id") === target.nativeId);
    if (comments.length !== 1) return null;
    const node = comments[0];
    if (operation.op === "comment.reply" || operation.op === "comment.private_reply") {
      if (operation.op === "comment.private_reply" && (!target.explicitOwnerRef || node.getAttribute("data-author-id") !== target.explicitOwnerRef)) return null;
      const label = operation.op === "comment.private_reply" ? "Private reply" : "Reply";
      const inputs = Array.from(node.querySelectorAll('textarea[aria-label], [contenteditable="true"][aria-label]')).filter((entry) => (entry.getAttribute("aria-label") || "").toLowerCase() === label.toLowerCase());
      if (inputs.length !== 1) return null;
      const form = inputs[0].closest("form");
      const buttons = form ? Array.from(form.querySelectorAll("button[type=submit]")) : [];
      return buttons.length === 1 ? { input: inputs[0], button: buttons[0] } : null;
    }
    const label = operation.op === "comment.like" ? "Like" : "Unlike";
    return uniqueButton(node, [label]);
  }

  function uniqueButton(root, labels) {
    const matches = Array.from(root.querySelectorAll("button[aria-label]"))
      .filter((node) => labels.includes(node.getAttribute("aria-label")));
    return matches.length === 1 ? { button: matches[0] } : null;
  }

  function payloadMatches(operation) {
    if (["message.send", "comment.reply", "comment.private_reply"].includes(operation.op)) return typeof operation.payload.text === "string" && operation.payload.text.length > 0 && operation.payload.text.length <= 2_200;
    if (["message.react", "message.unreact"].includes(operation.op)) return typeof operation.payload.reaction === "string" && operation.payload.reaction.length > 0 && operation.payload.reaction.length <= 16;
    return true;
  }

  function mutationFailure(status, reason) { return { status, reason }; }
  function setNativeValue(input, value) { const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value"); if (descriptor?.set) descriptor.set.call(input, value); else input.value = value; }
  function mediaIdFromUrl(value) { const url = safeInstagramUrl(value); return url?.pathname.match(/^\/(?:p|reel|tv)\/([^/]+)\/?$/)?.[1] || ""; }
  async function digest(value) { const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
  function stableStringify(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; }

  function findMessageScroller() {
    for (const node of document.querySelectorAll('main [role="log"], main [role="list"], main [data-scrollable="true"]')) {
      if (node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  function readUnreadState() {
    const labels = Array.from(document.querySelectorAll('[aria-label]'), (node) => node.getAttribute("aria-label") || "").join(" ");
    if (/\b(unread|new)\b|непрочитан|нов(ое|ый)/i.test(labels)) return true;
    return "unknown";
  }

  function findAccountHandle() {
    const current = safeInstagramUrl(location.href)?.pathname.match(/^\/([^/]+)\/?$/)?.[1];
    if (current && !RESERVED.has(current.toLowerCase())) return current;
    const candidates = new Set();
    for (const anchor of document.querySelectorAll('nav a[href]')) {
      const path = safeInstagramUrl(anchor.href)?.pathname.match(/^\/([^/]+)\/?$/)?.[1];
      if (path && !RESERVED.has(path.toLowerCase())) candidates.add(path);
    }
    return candidates.size === 1 ? [...candidates][0] : "";
  }

  function observation(accountBinding, data, availability, coverage, historyCompleteness, sideEffects, extras = {}) {
    return {
      source: "browser", nativeRef: location.pathname.slice(0, 512), accountBinding,
      capturedAt: new Date().toISOString(), availability, coverage, historyCompleteness,
      ...(sideEffects.length ? { sideEffects } : {}), data, errors: [], ...extras
    };
  }

  function failure(accountBinding, availability, message) {
    return observation(validBinding(accountBinding) ? accountBinding : "unknown", undefined, availability, "unknown", "unknown", [], { errors: [{ code: availability, message }] });
  }

  function safeInstagramUrl(value) {
    try {
      const url = new URL(value, location.origin);
      return INSTAGRAM_HOSTS.has(url.hostname) && url.protocol === "https:" ? url : null;
    } catch { return null; }
  }

  function isInstagramPage() { return INSTAGRAM_HOSTS.has(location.hostname) && location.protocol === "https:"; }
  function validBinding(value) { return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value); }
  function validHandle(value) { return typeof value === "string" && /^[a-zA-Z0-9._]{1,30}$/.test(value); }
  function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
  function boundedInteger(value, min, max, fallback) { return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback; }
  function cleanText(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
})();
