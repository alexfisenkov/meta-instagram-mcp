(() => {
  "use strict";

  const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
  const RESERVED = new Set(["accounts", "about", "api", "challenge", "developer", "direct", "explore", "legal", "oauth", "p", "privacy", "reel", "reels", "stories", "web"]);
  const READ_OPS = new Set(["account.inspect", "account.snapshot", "inbox.list", "thread.read", "thread.scroll_older", "comments.list", "comments.replies", "insights.read"]);
  const PREVIEW_OPS = new Set(["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"]);
  const MUTATION_OPS = PREVIEW_OPS;
  const BROWSER_INBOX_ROW_REF_PREFIX = "browser-inbox-row:";
  const LIVE_CAPABILITIES = Object.freeze(["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies",
    "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"]);
  const executedRequests = new Set();
  const inboxRowRefs = new Map();
  let verifiedOwnProfileProof;
  const MAX_LIMIT = 100;
  const MAX_SCROLL_PAGES = 5;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === "ping") {
      sendResponse({ kind: "pong", version: 1 });
      return false;
    }
    if (!message || !["observe", "execute"].includes(message.kind)) return false;
    const task = message.kind === "execute" ? runMutation(message) : runOperation(message);
    void task.then(sendResponse).catch(() => sendResponse(failure(message.accountBinding, "unsupported_ui_version", "browser operation failed")));
    return true;
  });

  async function runOperation(message) {
    const { operation, accountBinding, expectedAccountHandle } = message;
    if (!isInstagramPage() || !validBinding(accountBinding) || !isRecord(operation) || typeof operation.op !== "string") {
      return failure(accountBinding, "unsupported_ui_version", "invalid Instagram page or operation");
    }
    if (!READ_OPS.has(operation.op) && !PREVIEW_OPS.has(operation.op)) return failure(accountBinding, "unsupported", "operation is not allowlisted");
    if (typeof expectedAccountHandle !== "string" || !expectedAccountHandle.trim()) {
      return failure(accountBinding, "needs_selection", "expected account verification context is unavailable", "expected_handle_missing");
    }
    if (!validHandle(expectedAccountHandle)) return failure(accountBinding, "needs_selection", "expected account verification context is invalid", "expected_handle_invalid");
    if (taskDeadlineReached(message.taskExpiresAt)) return failure(accountBinding, "offline", "read task deadline expired", "task_deadline_expired");
    const verificationStage = await verifyOwnAccount(expectedAccountHandle, message.taskExpiresAt);
    if (verificationStage) return failure(accountBinding, verificationStage === "task_deadline_expired" ? "offline" : "needs_selection",
      "owner account verification stopped at a fail-closed stage", verificationStage);
    if (taskDeadlineReached(message.taskExpiresAt)) return failure(accountBinding, "offline", "read task deadline expired", "task_deadline_expired");
    const username = expectedAccountHandle;
    if (PREVIEW_OPS.has(operation.op)) return previewResult(operation, accountBinding, username);
    if (!READ_OPS.has(operation.op)) return failure(accountBinding, "unsupported", "operation is not allowlisted");

    if (operation.op === "account.inspect" || operation.op === "account.snapshot") {
      return observation(accountBinding, { username, accountBinding, loggedIn: true, surface: "instagram", capabilities: LIVE_CAPABILITIES }, "ready", "complete", "not_applicable", []);
    }
    if (operation.op === "inbox.list") return readInbox(accountBinding, username, operation.limit);
    if (operation.op === "thread.read" || operation.op === "thread.scroll_older") return readThread(accountBinding, username, operation, message.taskExpiresAt);
    if (operation.op === "comments.list" || operation.op === "comments.replies") return readComments(accountBinding, username, operation);
    if (operation.op === "insights.read") return failure(accountBinding, "unsupported_ui_version", "insights semantic controls are not verified");
    return failure(accountBinding, "unsupported", "operation is not allowlisted");
  }

  function readInbox(accountBinding, username, requestedLimit) {
    const limit = boundedInteger(requestedLimit, 1, MAX_LIMIT, 50);
    inboxRowRefs.clear();
    const items = [];
    const seen = new Set();
    const cards = findInboxRowCards();
    if (cards.ambiguous) return failure(accountBinding, "unsupported_ui_version", "the Direct inbox row container is ambiguous", "inbox_rows_ambiguous");
    if (cards.rows.length > 0) {
      const proof = verifiedOwnProfileProof;
      if (!proof || proof.handle !== username.toLowerCase()) return failure(accountBinding, "needs_selection", "the verified owner proof is unavailable for inbox rows", "owner_proof_missing");
      for (const row of cards.rows.slice(0, limit)) {
        const explicitOwnerRef = `${BROWSER_INBOX_ROW_REF_PREFIX}${crypto.randomUUID()}`;
        inboxRowRefs.set(explicitOwnerRef, { row, document, accountBinding, expectedAccountHandle: username.toLowerCase(), ownerProof: proof,
          path: location.pathname, snapshot: inboxRowSnapshot(row), expiresAt: Date.now() + 5 * 60_000 });
        items.push({ target: { accountBinding, explicitOwnerRef }, label: cleanText(row.innerText || row.textContent, 600), unread: "unknown", unanswered: "unknown" });
      }
    } else {
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
    }
    const coverage = items.length >= limit ? "partial" : "unknown";
    return observation(accountBinding, { username, items }, "ready", coverage, "limited", [], { sideEffects: [] });
  }

  function findInboxRowCards() {
    if (location.pathname.replace(/\/$/, "") !== "/direct/inbox") return { rows: [], ambiguous: false };
    const groups = new Map();
    for (const row of document.querySelectorAll('div[role="button"][tabindex="0"]')) {
      if (!isInboxRowCard(row)) continue;
      const container = nearestBranchingContainer(row);
      if (!container) continue;
      const rows = groups.get(container) || [];
      rows.push(row);
      groups.set(container, rows);
    }
    if (groups.size > 1) return { rows: [], ambiguous: true };
    return { rows: groups.size === 1 ? [...groups.values()][0] : [], ambiguous: false };
  }

  function isInboxRowCard(row) {
    if (row.tagName !== "DIV" || row.getAttribute("role") !== "button" || row.getAttribute("tabindex") !== "0" ||
        row.hasAttribute("aria-label") || row.hasAttribute("title") || !isVisible(row) || row.querySelector("a, button")) return false;
    const images = Array.from(row.querySelectorAll("img[alt]")).filter(isVisible);
    const spans = row.querySelectorAll("span").length;
    const divs = row.querySelectorAll("div").length;
    return images.length === 1 && spans >= 8 && divs >= 12 && divs <= 32;
  }

  function nearestBranchingContainer(row) {
    let ancestor = row.parentElement;
    for (let depth = 1; ancestor && depth <= 8; depth += 1, ancestor = ancestor.parentElement) {
      const visibleChildren = Array.from(ancestor.children).filter(isVisible);
      if (visibleChildren.length > 1) return ancestor;
    }
    return undefined;
  }

  function inboxRowSnapshot(row) {
    return stableStringify({
      text: cleanText(row.innerText || row.textContent, 3_000),
      attributes: ["role", "tabindex", "aria-label", "title", "href", "data-visualcompletion"].map((name) => [name, row.getAttribute(name)]),
      imageAlts: Array.from(row.querySelectorAll("img[alt]"), (image) => cleanText(image.getAttribute("alt"), 256)),
      descendants: Array.from(row.querySelectorAll("*"), (element) => [element.tagName, element.getAttribute("role"), element.getAttribute("tabindex")])
    });
  }

  function isFreshInboxRow(record) {
    return record.document === document && record.row.ownerDocument === document && record.row.isConnected &&
      isInboxRowCard(record.row) &&
      inboxRowSnapshot(record.row) === record.snapshot;
  }

  function directThreadIdFromPath() {
    return location.pathname.match(/^\/direct\/t\/([^/]+)\/?$/)?.[1];
  }

  function threadMessageNodes() {
    const main = document.querySelector("main");
    if (!main) return [];
    return Array.from(main.querySelectorAll("[data-message-id], [data-mid]")).filter(isVisible);
  }

  function allThreadMessageNodes() {
    const main = document.querySelector("main");
    if (!main) return [];
    return Array.from(main.querySelectorAll("[data-message-id], [data-mid]"));
  }

  function readSideEffectFailure(accountBinding, availability, message, code) {
    return { ...failure(accountBinding, availability, message, code), sideEffects: ["may_mark_seen"] };
  }

  async function readThread(accountBinding, username, operation, taskExpiresAt) {
    const target = operation.target;
    if (!isRecord(target) || !validBinding(target.accountBinding) || target.accountBinding !== accountBinding) {
      return failure(accountBinding, "needs_selection", "an exact conversation reference is required");
    }
    let expectedId;
    if (typeof target.nativeId === "string") {
      expectedId = target.nativeId.slice(0, 256);
      const currentId = directThreadIdFromPath();
      if (!currentId || currentId !== expectedId) return failure(accountBinding, "needs_selection", "the selected conversation does not match the requested reference");
    } else if (typeof target.explicitOwnerRef === "string" && target.explicitOwnerRef.startsWith(BROWSER_INBOX_ROW_REF_PREFIX)) {
      const rowRef = target.explicitOwnerRef;
      const record = inboxRowRefs.get(rowRef);
      if (!record || record.expiresAt <= Date.now() || record.accountBinding !== accountBinding ||
          record.expectedAccountHandle !== username.toLowerCase() || record.ownerProof !== verifiedOwnProfileProof || record.document !== document) {
        inboxRowRefs.delete(rowRef);
        return failure(accountBinding, "needs_selection", "the selected inbox row reference is stale or no longer matches its verified owner", "stale_inbox_row_ref");
      }
      if (record.openedNativeId) {
        const currentId = directThreadIdFromPath();
        if (!currentId || currentId !== record.openedNativeId) {
          return failure(accountBinding, "needs_selection", "the selected inbox row was already opened in another route", "stale_inbox_row_ref");
        }
        expectedId = currentId.slice(0, 256);
      } else {
        if (record.navigationStarted) {
          return readSideEffectFailure(accountBinding, "offline", "navigation for this inbox row is already in progress or ended without a verified route", "inbox_row_navigation_unknown");
        }
        if (record.path !== "/direct/inbox/" || location.pathname !== record.path || !isFreshInboxRow(record)) {
          inboxRowRefs.delete(rowRef);
          return failure(accountBinding, "needs_selection", "the selected inbox row node changed before navigation", "stale_inbox_row_ref");
        }
        if (taskDeadlineReached(taskExpiresAt)) {
          return readSideEffectFailure(accountBinding, "offline", "the read task deadline expired before inbox row navigation", "task_deadline_expired");
        }
        const priorMessages = new Set(allThreadMessageNodes());
        record.navigationStarted = true;
        try { record.row.click(); }
        catch { return readSideEffectFailure(accountBinding, "needs_selection", "the selected inbox row could not be opened", "inbox_row_navigation_failed"); }
        const navigated = await waitUntil(() => Boolean(directThreadIdFromPath()), 1_500, taskExpiresAt);
        const routeId = directThreadIdFromPath();
        if (!navigated || !routeId) {
          return readSideEffectFailure(accountBinding, taskDeadlineReached(taskExpiresAt) ? "offline" : "needs_selection",
            "the selected inbox row did not reach a conversation route", taskDeadlineReached(taskExpiresAt) ? "task_deadline_expired" : "conversation_route_not_reached");
        }
        record.openedNativeId = routeId.slice(0, 256);
        expectedId = record.openedNativeId;
        const loaded = await waitUntil(() => threadMessageNodes().some((node) => !priorMessages.has(node)), 2_500, taskExpiresAt);
        if (!loaded) return readSideEffectFailure(accountBinding, "offline", "new conversation messages did not load within the bounded read",
          taskDeadlineReached(taskExpiresAt) ? "task_deadline_expired" : "conversation_content_not_loaded");
        operation.freshMessageNodes = threadMessageNodes().filter((node) => !priorMessages.has(node));
      }
    } else {
      return failure(accountBinding, "needs_selection", "the conversation reference is not supported by this browser reader");
    }

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
    if (directThreadIdFromPath() !== expectedId) return failure(accountBinding, "needs_selection", "the selected conversation route changed before the read completed", "conversation_route_changed");

    const limit = boundedInteger(operation.limit, 1, MAX_LIMIT, 50);
    const messages = [];
    const seen = new Set();
    const messageNodes = Array.isArray(operation.freshMessageNodes) ? operation.freshMessageNodes : threadMessageNodes();
    for (const node of messageNodes) {
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

  async function verifyOwnAccount(expectedHandle, taskExpiresAt) {
    if (taskDeadlineReached(taskExpiresAt)) return "task_deadline_expired";
    const controls = ownProfileControls();
    if (controls.length === 0) { verifiedOwnProfileProof = undefined; return "owner_marker_missing"; }
    if (controls.length !== 1) { verifiedOwnProfileProof = undefined; return "owner_marker_ambiguous"; }
    const control = controls[0];
    if (control.handle.toLowerCase() !== expectedHandle.toLowerCase()) { verifiedOwnProfileProof = undefined; return "expected_handle_mismatch"; }
    if (verifiedOwnProfileProof && verifiedOwnProfileProof.handle === expectedHandle.toLowerCase() &&
        verifiedOwnProfileProof.element === control.element && verifiedOwnProfileProof.href === control.href && verifiedOwnProfileProof.alt === control.alt) return undefined;
    if (isExpectedProfilePath(expectedHandle)) {
      const editStage = ownEditProfileStage(expectedHandle);
      if (editStage) { verifiedOwnProfileProof = undefined; return editStage; }
      verifiedOwnProfileProof = { handle: expectedHandle.toLowerCase(), element: control.element, href: control.href, alt: control.alt };
      return undefined;
    }

    const original = safeInstagramUrl(location.href);
    if (!original) return "original_url_unavailable";
    if (taskDeadlineReached(taskExpiresAt)) return "task_deadline_expired";
    try { control.element.click(); } catch { return "profile_control_click_failed"; }
    await waitUntil(() => isExpectedProfilePath(expectedHandle) && !ownEditProfileStage(expectedHandle), 1_500, taskExpiresAt);
    const pathReached = isExpectedProfilePath(expectedHandle);
    const editStage = pathReached ? ownEditProfileStage(expectedHandle) : "profile_path_not_reached";
    let restored = isSameUrl(original);
    if (!restored) {
      try { history.back(); } catch { return "original_url_restore_failed"; }
      restored = await waitUntil(() => isSameUrl(original), 1_500);
    }
    if (!restored) { verifiedOwnProfileProof = undefined; return "original_url_restore_failed"; }
    if (taskDeadlineReached(taskExpiresAt)) { verifiedOwnProfileProof = undefined; return "task_deadline_expired"; }
    if (!pathReached) { verifiedOwnProfileProof = undefined; return "profile_path_not_reached"; }
    if (editStage) { verifiedOwnProfileProof = undefined; return editStage; }
    const currentControls = ownProfileControls();
    if (currentControls.length === 0) { verifiedOwnProfileProof = undefined; return "post_restore_marker_missing"; }
    if (currentControls.length !== 1) { verifiedOwnProfileProof = undefined; return "post_restore_marker_ambiguous"; }
    const currentControl = currentControls[0];
    if (currentControl.href !== control.href || currentControl.alt !== control.alt ||
        currentControl.handle.toLowerCase() !== expectedHandle.toLowerCase()) {
      verifiedOwnProfileProof = undefined;
      return "post_restore_marker_changed";
    }
    verifiedOwnProfileProof = { handle: expectedHandle.toLowerCase(), element: currentControl.element, href: currentControl.href, alt: currentControl.alt };
    return undefined;
  }

  function ownProfileControls() {
    return Array.from(document.querySelectorAll('a[role="link"]')).flatMap((element) => {
      if (element.closest("nav, header, aside, main") || element.hasAttribute("aria-label") || element.hasAttribute("title") || !isVisible(element)) return [];
      if (element.target && element.target.toLowerCase() !== "_self") return [];
      const url = safeInstagramUrl(element.href);
      const handle = url?.pathname.match(/^\/([^/]+)\/?$/)?.[1];
      if (!url || url.username || url.password || url.port || !handle || RESERVED.has(handle.toLowerCase()) || url.search || url.hash) return [];
      const images = Array.from(element.querySelectorAll("img[alt]")).filter(isVisible);
      if (images.length !== 1) return [];
      const alt = cleanText(images[0]?.getAttribute("alt"), 256);
      if (!profileImageAltContainsHandle(alt, handle)) return [];
      return [{ element, handle, href: `${url.origin}${url.pathname}`, alt }];
    });
  }

  function profileImageAltContainsHandle(value, handle) {
    const tokens = String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9._]*/g) || [];
    return tokens.includes(handle.toLowerCase());
  }

  function isExpectedProfilePath(handle) {
    const url = safeInstagramUrl(location.href);
    return Boolean(url && !url.search && !url.hash && url.pathname.replace(/\/$/, "").toLowerCase() === `/${handle.toLowerCase()}`);
  }

  function ownEditProfileStage(handle) {
    if (!isExpectedProfilePath(handle)) return "profile_path_not_reached";
    const controls = Array.from(document.querySelectorAll('header a[role="link"][href]')).filter((element) => {
      if (!isVisible(element) || element.hasAttribute("aria-label") || element.hasAttribute("title")) return false;
      const url = safeInstagramUrl(element.href);
      return url && !url.username && !url.password && !url.port && url.pathname === "/accounts/edit/" && !url.search && !url.hash;
    });
    if (controls.length > 1) return "edit_marker_ambiguous";
    if (controls.length === 0 || cleanText(controls[0].textContent, 128).toLowerCase() !== "редактировать профиль") return "edit_marker_missing";
    return undefined;
  }

  function isVisible(element) {
    if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  }

  function isSameUrl(url) {
    try { return safeInstagramUrl(location.href)?.href === url.href; } catch { return false; }
  }

  function taskDeadline(taskExpiresAt) {
    if (typeof taskExpiresAt !== "string") return undefined;
    const deadline = Date.parse(taskExpiresAt);
    return Number.isFinite(deadline) ? deadline : Number.NEGATIVE_INFINITY;
  }

  function taskDeadlineReached(taskExpiresAt) {
    const deadline = taskDeadline(taskExpiresAt);
    return deadline !== undefined && Date.now() >= deadline;
  }

  async function waitUntil(predicate, timeoutMs, taskExpiresAt) {
    const deadline = Math.min(Date.now() + timeoutMs, taskDeadline(taskExpiresAt) ?? Number.POSITIVE_INFINITY);
    while (Date.now() <= deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return Boolean(predicate());
  }

  function observation(accountBinding, data, availability, coverage, historyCompleteness, sideEffects, extras = {}) {
    return {
      source: "browser", nativeRef: location.pathname.slice(0, 512), accountBinding,
      capturedAt: new Date().toISOString(), availability, coverage, historyCompleteness,
      ...(sideEffects.length ? { sideEffects } : {}), data, errors: [], ...extras
    };
  }

  function failure(accountBinding, availability, message, code = availability) {
    return observation(validBinding(accountBinding) ? accountBinding : "unknown", undefined, availability, "unknown", "unknown", [], { errors: [{ code, message }] });
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
