const NATIVE_HOST_NAME = "com.alexfisenkov.instagram_companion";
const RECONNECT_ALARM = "instagram-native-reconnect";
const RECONNECT_BASE_MS = 30_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const INSTAGRAM_URL_PATTERNS = ["https://www.instagram.com/*", "https://instagram.com/*"];
const OPERATION_MAP = Object.freeze({
  "account.inspect": "account.inspect",
  "account.snapshot": "account.snapshot",
  "inbox.list": "inbox.list",
  "conversation.read": "thread.read",
  "comments.list": "comments.list",
  "comments.replies": "comments.replies",
  "insights.read": "insights.read",
  "message.send": "message.send",
  "message.react": "message.react",
  "message.unreact": "message.unreact",
  "comment.reply": "comment.reply",
  "comment.private_reply": "comment.private_reply",
  "comment.like": "comment.like",
  "comment.unlike": "comment.unlike"
});
const READ_KEYS = new Set(["limit", "pages"]);
const WRITE_KEYS = new Set(["text", "reaction"]);
const MUTATION_OPS = new Set(["message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply", "comment.like", "comment.unlike"]);

let nativePort;
let bridgeReady;
let expectedAccountHandle;
let accountBinding;
let allowWrites = false;
let reconnectAttempts = 0;
let reconnectScheduled = false;
const inFlightWrites = new Set();
const writeApprovals = new Map();

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  reconnectScheduled = false;
  if (!nativePort) connectNative();
});
connectNative();

function connectNative() {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      nativePort = undefined;
      bridgeReady = false;
      expectedAccountHandle = undefined;
      accountBinding = undefined;
      allowWrites = false;
      inFlightWrites.clear();
      writeApprovals.clear();
      scheduleReconnect();
    });
    port.postMessage({ kind: "hello", version: 1 });
  } catch {
    nativePort = undefined;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectScheduled || nativePort) return;
  reconnectScheduled = true;
  reconnectAttempts = Math.min(reconnectAttempts + 1, 16);
  const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempts - 1, 4));
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: delayMs / 60_000 });
}

async function onNativeMessage(message) {
  if (!isRecord(message)) return;
  if (message.kind === "ready" && message.version === 1 && typeof message.accountBinding === "string" &&
      /^[a-zA-Z0-9:_-]{1,128}$/.test(message.accountBinding) && typeof message.expectedAccountHandle === "string" &&
      /^[a-zA-Z0-9._]{1,30}$/.test(message.expectedAccountHandle) && typeof message.allowWrites === "boolean") {
    bridgeReady = true;
    accountBinding = message.accountBinding;
    expectedAccountHandle = message.expectedAccountHandle;
    allowWrites = message.allowWrites;
    reconnectAttempts = 0;
    reconnectScheduled = false;
    void chrome.alarms.clear(RECONNECT_ALARM);
    return;
  }
  if (message.kind === "heartbeat") return;
  if (message.kind !== "task" || !bridgeReady || !validTask(message.task)) return;
  const task = message.task;
  if (task.kind === "read" && Date.parse(task.expiresAt) <= Date.now()) {
    sendResult(task, unavailable("offline", "the read task expired before browser UI execution", "task_deadline_expired"));
    return;
  }
  if (task.kind === "write" && (!allowWrites || !message.approval || !nativePort || !isApproval(task, message.approval))) {
    sendResult(task, { status: "FAILED", reason: "the assigned browser host did not approve this write lease" });
    return;
  }
  if (task.kind === "write" && inFlightWrites.has(task.id)) return;
  if (task.kind === "write") {
    inFlightWrites.add(task.id);
    writeApprovals.set(task.id, message.approval);
  }
  const tab = await selectUniqueTab(task);
  if (!tab) {
    sendResult(task, unavailable("needs_selection", "an exact Instagram tab could not be selected"));
    return;
  }
  if (task.kind === "read" && Date.parse(task.expiresAt) <= Date.now()) {
    sendResult(task, unavailable("offline", "the read task expired before browser UI dispatch", "task_deadline_expired"));
    return;
  }
  const operation = taskToOperation(task, message.approval);
  if (!operation) {
    sendResult(task, unavailable("unsupported", "the operation is not allowlisted"));
    return;
  }
  if (task.kind === "read" && Date.parse(task.expiresAt) <= Date.now()) {
    sendResult(task, unavailable("offline", "the read task expired before browser UI dispatch", "task_deadline_expired"));
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      kind: task.kind === "write" ? "execute" : "observe", operation,
      accountBinding, expectedAccountHandle, allowWrites, approval: message.approval, taskExpiresAt: task.expiresAt
    });
    sendResult(task, result);
  } catch {
    sendResult(task, unavailable("unsupported_ui_version", "the fixed content script is not available in the selected tab"));
  }
}

async function selectUniqueTab(task) {
  const tabs = await chrome.tabs.query({ url: INSTAGRAM_URL_PATTERNS });
  let eligible = tabs.filter((tab) => typeof tab.id === "number" && isInstagramUrl(tab.url));
  const targetId = task.targetRefs.length === 1 ? task.targetRefs[0].nativeId : undefined;
  if (targetId && (task.operation === "conversation.read" || task.operation.startsWith("message."))) {
    const expectedPath = `/direct/t/${encodeURIComponent(targetId)}`;
    eligible = eligible.filter((tab) => {
      try { return new URL(tab.url).pathname.replace(/\/$/, "") === expectedPath; } catch { return false; }
    });
  } else if (targetId && (task.operation.startsWith("comment.") || ["comments.list", "comments.replies"].includes(task.operation))) {
    eligible = eligible.filter((tab) => {
      try {
        const actual = new URL(tab.url);
        const target = task.targetRefs[0];
        const expected = target?.instagramUrl ? new URL(target.instagramUrl) : undefined;
        return expected
          ? expected.origin === actual.origin && expected.pathname.replace(/\/$/, "") === actual.pathname.replace(/\/$/, "")
          : !task.operation.startsWith("comment.") && actual.pathname.split("/").includes(targetId);
      } catch { return false; }
    });
  }
  return eligible.length === 1 ? eligible[0] : undefined;
}

function taskToOperation(task, approval) {
  const op = OPERATION_MAP[task.operation];
  if (!op || !isRecord(task.payload)) return undefined;
  const isWrite = MUTATION_OPS.has(task.operation);
  const allowed = isWrite ? WRITE_KEYS : READ_KEYS;
  if (Object.keys(task.payload).some((key) => !allowed.has(key))) return undefined;
  const payload = {};
  if (Number.isInteger(task.payload.limit)) payload.limit = Math.max(1, Math.min(100, task.payload.limit));
  if (Number.isInteger(task.payload.pages)) payload.pages = Math.max(1, Math.min(5, task.payload.pages));
  if (typeof task.payload.text === "string" && task.payload.text.length <= 2_000) payload.text = task.payload.text;
  if (typeof task.payload.reaction === "string" && task.payload.reaction.length <= 64) payload.reaction = task.payload.reaction;
  const targetRef = task.targetRefs[0];
  const operation = { op: op === "thread.read" && payload.pages ? "thread.scroll_older" : op, ...payload };
  if (["thread.read", "comments.list", "comments.replies"].includes(op) || MUTATION_OPS.has(op)) {
    if (!targetRef || targetRef.accountBinding !== task.accountBinding || typeof targetRef.nativeId !== "string") return undefined;
    operation.target = { ...targetRef };
  }
  if (MUTATION_OPS.has(op)) {
    operation.payload = payload;
    if (typeof task.contextHash !== "string" || task.contextHash.length > 128) return undefined;
    operation.contextHash = task.contextHash;
    if (task.kind === "write") {
      if (!isApproval(task, approval)) return undefined;
      operation.approval = approval;
    }
  }
  return operation;
}

function sendResult(task, result) {
  if (!nativePort || !bridgeReady || !isRecord(result)) return;
  if (task.kind === "write") {
    const approval = writeApprovals.get(task.id);
    const mutationResult = ["ACK", "OBSERVED", "OUTCOME_UNKNOWN"].includes(String(result.status)) &&
      approval && result.requestId === approval.requestId && result.contextHash === task.contextHash;
    if (!mutationResult && result.status !== "FAILED") result = { status: "FAILED", reason: "browser did not confirm a guarded semantic action" };
    nativePort.postMessage({ kind: "result", taskId: task.id, result, contextHash: task.contextHash });
    writeApprovals.delete(task.id);
    return;
  }
  const resultAccount = result.accountBinding;
  if (resultAccount !== accountBinding) {
    result = unavailable("needs_selection", "result account did not match the assigned account");
  }
  nativePort.postMessage({ kind: "result", taskId: task.id, result, contextHash: task.contextHash });
}

function unavailable(availability, message, code = availability) {
  return {
    source: "browser", nativeRef: "", accountBinding, capturedAt: new Date().toISOString(),
    availability, coverage: "unknown", historyCompleteness: "unknown", errors: [{ code, message }]
  };
}

function validTask(value) {
  if (!isRecord(value) || !bridgeReady || value.accountBinding !== accountBinding || value.source !== "browser" ||
      !["read", "preview", "write"].includes(value.kind) || typeof value.id !== "string" || value.id.length > 128 ||
      !Object.hasOwn(OPERATION_MAP, value.operation) || !Array.isArray(value.targetRefs) || value.targetRefs.length > 1 ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || !isRecord(value.payload)) return false;
  return value.targetRefs.every((target) => isRecord(target) && target.accountBinding === accountBinding &&
    Object.keys(target).every((key) => ["accountBinding", "nativeId", "instagramUrl", "explicitOwnerRef"].includes(key)) &&
    Object.values(target).every((entry) => typeof entry === "string" && entry.length <= 512));
}

function isApproval(task, approval) {
  return task.kind === "write" && isRecord(approval) && approval.taskId === task.id &&
    typeof approval.requestId === "string" && /^[\w-]{16,128}$/.test(approval.requestId) &&
    approval.bridgeId === task.bridgeId &&
    approval.contextHash === task.contextHash &&
    approval.expiresAt === task.expiresAt &&
    typeof approval.fingerprint === "string" && /^[a-f0-9]{64}$/.test(approval.fingerprint) &&
    approval.expectedFingerprint === approval.fingerprint && typeof task.contextHash === "string" &&
    /^[a-f0-9]{16,128}$/i.test(task.contextHash) && Date.parse(task.expiresAt) > Date.now() &&
    Date.parse(task.expiresAt) - Date.now() <= 30_000;
}

function isInstagramUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname); }
  catch { return false; }
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
