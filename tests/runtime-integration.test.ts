import { createServer as createNetServer } from "node:net";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionHub } from "../src/companion-hub.js";
import { createCompanionSourceProvider } from "../src/companion-source-provider.js";
import { createBrowserNativeHost, type BrowserBridgeClient } from "../src/companion/browser-native-host.js";
import { NativeFrameDecoder, encodeNativeFrame } from "../src/companion/native-framing.js";
import { createRuntime } from "../src/runtime.js";
import { ensurePrivateFile } from "../src/private-fs.js";
import type { ExistingToolHandlers } from "../src/mcp-server.js";
import type { SourceProvider } from "../src/source-router.js";
import type { Observation } from "../src/domain-types.js";
import type { MutationExecutor } from "../src/action-safety.js";
import type { Listener } from "../src/http-server.js";
import { PassThrough } from "node:stream";
import { requestJsonHttp } from "../src/http-json.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));

const bearer = "runtime-integration-test-bearer-token-0123456789";
const listeners: Listener[] = [];
const dirs: string[] = [];

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fixtureHandlers(): ExistingToolHandlers {
  return new Proxy({ scopePresets: () => [{ id: "fixture" }] }, {
    get(target, property) { return Reflect.get(target, property) ?? (async () => ({ ok: true })); }
  }) as unknown as ExistingToolHandlers;
}

const fixtureObservation: Observation<unknown> = {
  source: "browser", nativeRef: "browser:inbox", accountBinding: "instagram:42", capturedAt: "2026-10-06T12:00:00.000Z",
  availability: "ready", coverage: "partial", historyCompleteness: "limited",
  data: { items: [{ id: "thread-42", unread: true, unanswered: "unknown" }] }, errors: []
};
const readRequests: unknown[] = [];
const fixtureProvider: SourceProvider = {
  source: "browser",
  status: async () => ({ source: "browser", availability: "ready", capabilities: ["inbox.list", "conversation.read", "comments.list", "comments.replies", "insights.read"] }),
  read: async (request) => { readRequests.push(request); return fixtureObservation; }
};

describe("runtime composition", () => {
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("composes browser-only sources with MCP and Streamable HTTP while absent optional routes return 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-runtime-")); dirs.push(dir);
    const mutationCalls: string[] = [];
    const mutationExecutor: MutationExecutor = {
      source: "api",
      refreshContext: async (intent) => ({ target: intent.target, contextHash: "a".repeat(64) }),
      execute: async (intent, requestId, _contextHash, proof) => {
        mutationCalls.push(`${requestId}:${proof?.durableAttempt === true}`);
        if (intent.action === "comment.hide") return { status: "OUTCOME_UNKNOWN", reason: "synthetic disconnect" };
        return { status: "ACK", receiptId: "fixture-receipt" };
      }
    };
    const runtime = createRuntime({
      existingHandlers: fixtureHandlers(),
      config: { authMode: "instagram", graphApiVersion: "v25.0", tokenStorePath: join(dir, "token.json"), publishLogPath: join(dir, "publish.jsonl"), writeEnabled: true },
      approvalKeyPath: join(dir, "approval-key.json"), auditPath: join(dir, "mutation-audit.jsonl"), mutationExecutors: [mutationExecutor],
      providers: [fixtureProvider],
      hub: new CompanionHub({ storagePath: join(dir, "hub.json") })
    });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const listener = await runtime.startHttpServer({
      host: "127.0.0.1", port, bearerSecret: bearer,
      allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [`${url}`], maxRequestBytes: 1_024
    });
    listeners.push(listener);

    expect((await fetch(`${url}/oauth/callback`)).status).toBe(404);
    expect((await fetch(`${url}/webhook`)).status).toBe(404);

    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } }
    });
    const client = new Client({ name: "runtime-composition", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(27);
      expect(tools.tools.map((tool) => tool.name)).toContain("meta_prepare_action");
      const response = await client.callTool({ name: "meta_triage_inbox", arguments: { source: "auto", limit: 4 } });
      const content = (response as { content?: Array<{ text?: string }> }).content;
      expect(JSON.parse(content?.[0]?.text ?? "{}")).toMatchObject({
        triedSources: ["browser"],
        items: [{ threadRef: { accountBinding: "instagram:42", nativeId: "thread-42" }, unread: true, unanswered: "unknown", state: "unknown" }]
      });
      const selected = await client.callTool({ name: "meta_read_source", arguments: { operation: "conversation.read", target: { accountBinding: "instagram:42", nativeId: "thread-42" }, olderCursor: "page-older" } });
      expect(JSON.parse(((selected as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ triedSources: ["browser"], observations: [fixtureObservation] });
      expect(readRequests.at(-1)).toMatchObject({ operation: "conversation.read", target: { nativeId: "thread-42" }, olderCursor: "page-older" });
      const draft = await client.callTool({ name: "meta_prepare_action", arguments: {
        source: "api", accountBinding: "instagram:42", action: "comment.reply",
        target: { accountBinding: "instagram:42", nativeId: "comment-42" }, text: "Exact approved text"
      } });
      const preview = JSON.parse(((draft as { content: Array<{ text: string }> }).content[0]!).text);
      expect(preview).toMatchObject({ requiresConfirmation: true, contextHash: "a".repeat(64), payload: { text: "Exact approved text" } });
      expect(mutationCalls).toEqual([]);
      const wrongBinding = await client.callTool({ name: "meta_prepare_action", arguments: {
        source: "api", accountBinding: "instagram:42", action: "comment.reply",
        target: { accountBinding: "instagram:other", nativeId: "comment-42" }, text: "Exact approved text"
      } });
      expect(JSON.parse(((wrongBinding as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
      const forged = await client.callTool({ name: "meta_execute_action", arguments: { requestId: preview.requestId, expectedFingerprint: "f".repeat(64), confirm: true } });
      expect(JSON.parse(((forged as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
      expect(mutationCalls).toEqual([]);
      const executed = await client.callTool({ name: "meta_execute_action", arguments: { requestId: preview.requestId, expectedFingerprint: preview.fingerprint, confirm: true } });
      console.log(((executed as { content: Array<{ text: string }> }).content[0]!).text);
      expect(JSON.parse(((executed as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "OUTCOME_UNKNOWN", responseState: "unknown" });
      expect(mutationCalls).toHaveLength(1);
      const receipt = await client.callTool({ name: "meta_reconcile_action", arguments: { requestId: preview.requestId } });
      expect(JSON.parse(((receipt as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
      expect(mutationCalls).toHaveLength(1);
      const replay = await client.callTool({ name: "meta_execute_action", arguments: { requestId: preview.requestId, expectedFingerprint: preview.fingerprint, confirm: true } });
      expect(JSON.parse(((replay as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
      expect(mutationCalls).toHaveLength(1);
      const unknownDraft = await client.callTool({ name: "meta_prepare_action", arguments: {
        source: "api", accountBinding: "instagram:42", action: "comment.hide",
        target: { accountBinding: "instagram:42", nativeId: "comment-43" }
      } });
      const unknownPreview = JSON.parse(((unknownDraft as { content: Array<{ text: string }> }).content[0]!).text);
      const unknownResult = await client.callTool({ name: "meta_execute_action", arguments: { requestId: unknownPreview.requestId, expectedFingerprint: unknownPreview.fingerprint, confirm: true } });
      expect(JSON.parse(((unknownResult as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
      expect(mutationCalls).toHaveLength(2);
      const [restartClientTransport, restartServerTransport] = InMemoryTransport.createLinkedPair();
      const restartedClient = new Client({ name: "runtime-restart", version: "1.0.0" });
      const restartedServer = createRuntime({ existingHandlers: fixtureHandlers(), config: { authMode: "instagram", graphApiVersion: "v25.0", tokenStorePath: join(dir, "token.json"), publishLogPath: join(dir, "publish.jsonl"), writeEnabled: true }, approvalKeyPath: join(dir, "approval-key.json"), auditPath: join(dir, "mutation-audit.jsonl"), mutationExecutors: [mutationExecutor], providers: [fixtureProvider] }).createMcpServer();
      try {
        await restartedServer.connect(restartServerTransport);
        await restartedClient.connect(restartClientTransport);
        const retryAfterRestart = await restartedClient.callTool({ name: "meta_execute_action", arguments: { requestId: unknownPreview.requestId, expectedFingerprint: unknownPreview.fingerprint, confirm: true } });
        expect(JSON.parse(((retryAfterRestart as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
        const readOnlyReconcile = await restartedClient.callTool({ name: "meta_reconcile_action", arguments: { requestId: unknownPreview.requestId } });
        expect(JSON.parse(((readOnlyReconcile as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
        expect(mutationCalls).toHaveLength(2);
      } finally { await restartedClient.close(); await restartedServer.close(); }
    } finally { await client.close(); }
  });

  it("uses the default runtime factory across Hub bootstrap and API write reconciliation without retries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-default-runtime-")); dirs.push(dir);
    const tokenStorePath = join(dir, "token.json");
    await (await import("node:fs/promises")).writeFile(tokenStorePath, JSON.stringify({
      accessToken: "synthetic-integration-token", authMode: "instagram", userId: "42", permissions: ["instagram_business_manage_comments"]
    }), { mode: 0o600 });
    await ensurePrivateFile(tokenStorePath);
    let writeCount = 0;
    vi.mocked(requestJsonHttp).mockImplementation(async (url, init = {}) => {
      const path = url.pathname;
      let body: unknown = {};
      if ((init.method ?? "GET") === "POST" && path.endsWith("/replies")) {
        writeCount += 1;
        body = { id: path.includes("comment-42") ? "reply-42" : "reply-43" };
      } else if (path.endsWith("/comment-42/replies")) {
        body = { data: [{ id: "reply-42", text: "Exact approved reply", timestamp: new Date().toISOString(), from: { id: "42" } }] };
      } else if (path.endsWith("/comment-43/replies")) {
        body = { data: [] };
      } else if (path.endsWith("/comment-42") || path.endsWith("/comment-43")) {
        body = { id: path.endsWith("comment-42") ? "comment-42" : "comment-43", text: "Original comment", timestamp: "2026-10-06T12:00:00.000Z", from: { id: "peer-7" } };
      } else {
        throw new Error("Unexpected synthetic Graph transport path.");
      }
      return { ok: true, status: 200, body, text: JSON.stringify(body), attempts: [{ route: "synthetic-http-edge", ok: true, status: 200 }] };
    });
    const config = { authMode: "instagram" as const, graphApiVersion: "v25.0", tokenStorePath, publishLogPath: join(dir, "publish.jsonl"), writeEnabled: true };
    const hubStoragePath = join(dir, "hub.json");
    const approvalKeyPath = join(dir, "approval-key.json");
    const auditPath = join(dir, "mutation-audit.jsonl");
    const readbackPath = join(dir, "mutation-readback.json");
    const runtime = createRuntime({ config, hubStoragePath, approvalKeyPath, auditPath, readbackPath });
    let bridgeToken = "";
    const bridgeClient: BrowserBridgeClient = {
      async register() {
        const registration = await runtime.hub.register({ mode: "browser_native_host", source: "browser", accountBinding: "instagram:42",
          capabilities: ["account.inspect", "inbox.list", "conversation.read", "comments.list", "comments.replies"] });
        bridgeToken = registration.bridgeToken;
        return { bridgeId: registration.bridgeId };
      },
      async heartbeat(id, status) { await runtime.hub.heartbeat({ bridgeId: id!, bridgeToken, source: "browser", status }); },
      poll: async (id, max) => runtime.hub.poll(id, max, bridgeToken),
      submit: async (id, taskId, result, contextHash) => runtime.hub.submit(id, taskId, result, contextHash, bridgeToken)
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new NativeFrameDecoder();
    const frames: unknown[] = [];
    output.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        frames.push(message);
        if (!isRecord(message) || message.kind !== "task" || !isRecord(message.task)) continue;
        const task = message.task as unknown as { id: string; contextHash?: string; operation: string };
        const data = task.operation === "account.inspect"
          ? { username: "synthetic.account", accountBinding: "instagram:42", loggedIn: true, surface: "instagram", capabilities: ["account.inspect", "inbox.list", "conversation.read", "comments.list", "comments.replies"] }
          : { username: "synthetic.account", items: [{ id: "thread-7", unread: true, unanswered: "unknown" }] };
        const result = { source: "browser", nativeRef: task.operation === "account.inspect" ? "/direct/inbox/" : "browser:inbox",
          accountBinding: "instagram:42", capturedAt: new Date().toISOString(), availability: "ready", coverage: "partial",
          historyCompleteness: "limited", data, errors: [] };
        input.write(encodeNativeFrame({ kind: "result", taskId: task.id, result, ...(task.contextHash ? { contextHash: task.contextHash } : {}) }));
      }
    });
    const host = createBrowserNativeHost({ client: bridgeClient, accountBinding: "instagram:42", expectedAccountHandle: "synthetic.account", input, output, pollIntervalMs: 250, log: vi.fn() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "default-runtime-proof", version: "1.0.0" });
    const server = runtime.createMcpServer();
    let restartedServer: ReturnType<typeof runtime.createMcpServer> | undefined;
    let restartedClient: Client | undefined;
    try {
      await runtime.initialize();
      await host.start();
      input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
      await waitForIntegration(() => frames.some((message) => isRecord(message) && message.kind === "ready"));
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(27);
      expect(listed.tools.map((tool) => tool.name)).toContain("meta_reconcile_action");
      const browserRead = await client.callTool({ name: "meta_read_source", arguments: { operation: "account.inspect" } });
      expect(JSON.parse(((browserRead as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ triedSources: ["browser"], observations: [{ availability: "ready" }] });
      const queue = await client.callTool({ name: "meta_triage_inbox", arguments: { source: "auto", limit: 4 } });
      const queueResult = JSON.parse(((queue as { content: Array<{ text: string }> }).content[0]!).text);
      expect(queueResult).toMatchObject({ triedSources: ["browser"], items: [{ unread: true, unanswered: "unknown", state: "unknown" }] });
      const apiRead = await client.callTool({ name: "meta_read_source", arguments: { operation: "comments.replies", target: { accountBinding: "instagram:42", nativeId: "comment-42" }, limit: 10 } });
      const apiResult = JSON.parse(((apiRead as { content: Array<{ text: string }> }).content[0]!).text);
      expect(apiResult).toMatchObject({ triedSources: ["api"], observations: [{ source: "api", data: { items: [{ id: "reply-42" }] } }] });

      const wrongAccount = await client.callTool({ name: "meta_prepare_action", arguments: { source: "api", accountBinding: "instagram:42", action: "comment.reply", target: { accountBinding: "instagram:wrong", nativeId: "comment-42" }, text: "Exact approved reply" } });
      expect(JSON.parse(((wrongAccount as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
      const draft = await client.callTool({ name: "meta_prepare_action", arguments: { source: "api", accountBinding: "instagram:42", action: "comment.reply", target: { accountBinding: "instagram:42", nativeId: "comment-42" }, text: "Exact approved reply" } });
      const preview = JSON.parse(((draft as { content: Array<{ text: string }> }).content[0]!).text);
      expect(preview).toMatchObject({ requiresConfirmation: true, payload: { text: "Exact approved reply" } });
      const badSignature = await client.callTool({ name: "meta_execute_action", arguments: { requestId: preview.requestId, expectedFingerprint: "f".repeat(64), confirm: true } });
      expect(JSON.parse(((badSignature as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
      expect(writeCount).toBe(0);
      const executed = await client.callTool({ name: "meta_execute_action", arguments: { requestId: preview.requestId, expectedFingerprint: preview.fingerprint, confirm: true } });
      const executedResult = JSON.parse(((executed as { content: Array<{ text: string }> }).content[0]!).text);
      expect(executedResult).toMatchObject({ status: "OBSERVED", dispatchStatus: "ACK", receiptId: "reply-42", responseState: "unknown" });
      const receipt = await client.callTool({ name: "meta_reconcile_action", arguments: { requestId: preview.requestId } });
      expect(JSON.parse(((receipt as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "OBSERVED", responseState: "unknown" });
      const replay = await client.callTool({ name: "meta_execute_action", arguments: { requestId: preview.requestId, expectedFingerprint: preview.fingerprint, confirm: true } });
      expect(JSON.parse(((replay as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
      expect(writeCount).toBe(1);

      const unknownDraft = await client.callTool({ name: "meta_prepare_action", arguments: { source: "api", accountBinding: "instagram:42", action: "comment.reply", target: { accountBinding: "instagram:42", nativeId: "comment-43" }, text: "Exact approved reply" } });
      const unknownPreview = JSON.parse(((unknownDraft as { content: Array<{ text: string }> }).content[0]!).text);
      const unknownExecution = await client.callTool({ name: "meta_execute_action", arguments: { requestId: unknownPreview.requestId, expectedFingerprint: unknownPreview.fingerprint, confirm: true } });
      expect(JSON.parse(((unknownExecution as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "OUTCOME_UNKNOWN", dispatchStatus: "ACK" });
      const pair = InMemoryTransport.createLinkedPair();
      restartedClient = new Client({ name: "default-runtime-restart", version: "1.0.0" });
      const restartedRuntime = createRuntime({ config, hubStoragePath, approvalKeyPath, auditPath, readbackPath });
      restartedServer = restartedRuntime.createMcpServer();
      await restartedServer.connect(pair[1]);
      await restartedClient.connect(pair[0]);
      const restartReplay = await restartedClient.callTool({ name: "meta_execute_action", arguments: { requestId: unknownPreview.requestId, expectedFingerprint: unknownPreview.fingerprint, confirm: true } });
      expect(JSON.parse(((restartReplay as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "FAILED" });
      const restartReadback = await restartedClient.callTool({ name: "meta_reconcile_action", arguments: { requestId: unknownPreview.requestId } });
      expect(JSON.parse(((restartReadback as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject({ status: "OUTCOME_UNKNOWN", dispatchStatus: "ACK" });
      expect(writeCount).toBe(2);
    } finally {
      await client.close(); await server.close(); await restartedClient?.close(); await restartedServer?.close();
      host.close(); input.end(); output.end();
    }
  }, process.platform === "win32" ? 90_000 : 15_000);

  it("automatically verifies a registered browser before Direct inbox reads through Hub, router, and MCP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-browser-bootstrap-")); dirs.push(dir);
    const hub = new CompanionHub({ storagePath: join(dir, "hub.json") });
    let bridgeToken = "";
    const bridgeClient: BrowserBridgeClient = {
      async register() {
        const registration = await hub.register({ mode: "browser_native_host", source: "browser", accountBinding: "instagram:42",
          capabilities: ["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies"] });
        bridgeToken = registration.bridgeToken;
        return { bridgeId: registration.bridgeId };
      },
      async heartbeat(id, status) { await hub.heartbeat({ bridgeId: id!, bridgeToken, source: "browser", status }); },
      poll: async (id, max) => hub.poll(id, max, bridgeToken),
      submit: async (id, taskId, result, contextHash) => hub.submit(id, taskId, result, contextHash, bridgeToken)
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new NativeFrameDecoder();
    const frames: unknown[] = [];
    output.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        frames.push(message);
        if (!isRecord(message) || message.kind !== "task" || !isRecord(message.task)) continue;
        const task = message.task as unknown as { id: string; contextHash?: string; operation: string };
        const data = task.operation === "account.inspect"
          ? { username: "alexfisenkov", accountBinding: "instagram:42", loggedIn: true, surface: "instagram",
              capabilities: ["account.inspect", "account.snapshot", "inbox.list", "conversation.read", "comments.list", "comments.replies"] }
          : { username: "alexfisenkov", items: [{ id: "thread-42", unread: true, unanswered: "unknown" }] };
        const result = { source: "browser", nativeRef: "/direct/inbox/", accountBinding: "instagram:42", capturedAt: new Date().toISOString(),
          availability: "ready", coverage: "complete", historyCompleteness: "not_applicable", data, errors: [] };
        input.write(encodeNativeFrame({ kind: "result", taskId: task.id, result, ...(task.contextHash ? { contextHash: task.contextHash } : {}) }));
      }
    });
    const host = createBrowserNativeHost({ client: bridgeClient, accountBinding: "instagram:42", expectedAccountHandle: "alexfisenkov", input, output, pollIntervalMs: 250, log: vi.fn() });
    const runtime = createRuntime({
      existingHandlers: fixtureHandlers(), config: { authMode: "instagram", graphApiVersion: "v25.0", tokenStorePath: join(dir, "token.json"), publishLogPath: join(dir, "publish.jsonl") },
      hub, providers: [createCompanionSourceProvider({ hub, source: "browser", waitMs: process.platform === "win32" ? 30_000 : 2_000, pollMs: 25 })]
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "browser-bootstrap", version: "1.0.0" });
    let server: ReturnType<typeof runtime.createMcpServer> | undefined;
    try {
      await host.start();
      input.write(encodeNativeFrame({ kind: "hello", version: 1 }));
      await waitForIntegration(() => frames.some((message) => isRecord(message) && message.kind === "ready"));
      server = runtime.createMcpServer();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({ name: "meta_read_inbox", arguments: { source: "auto", limit: 4 } });
      const result = JSON.parse(((response as { content: Array<{ text: string }> }).content[0]!).text);
      expect(result).toMatchObject({ triedSources: ["browser"], items: [{ source: "browser", threadRef: { nativeId: "thread-42" } }], channelCoverage: { direct: "complete" } });
      expect(await hub.sourceStatus("browser", "instagram:42")).toMatchObject({ availability: "ready", accountHandle: "alexfisenkov", surface: "instagram", capabilities: expect.arrayContaining(["inbox.list"]) });
    } finally {
      await client.close(); await server?.close(); host.close(); input.end(); output.end();
    }
  }, process.platform === "win32" ? 90_000 : 15_000);

  it("builds OAuth and signed webhook routes from configured runtime settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instagram-runtime-configured-")); dirs.push(dir);
    const previous = {
      verify: process.env.META_WEBHOOK_VERIFY_TOKEN,
      accounts: process.env.META_WEBHOOK_ACCOUNT_IDS,
      journal: process.env.META_WEBHOOK_JOURNAL_PATH
    };
    process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
    process.env.META_WEBHOOK_ACCOUNT_IDS = "ig-account-42";
    process.env.META_WEBHOOK_JOURNAL_PATH = join(dir, "events.jsonl");
    try {
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      const runtime = createRuntime({
        existingHandlers: fixtureHandlers(), providers: [fixtureProvider], mutationExecutors: [],
        config: { authMode: "instagram", appId: "synthetic-app-id", appSecret: "synthetic-app-secret", redirectUri: "https://example.test/oauth/callback",
          graphApiVersion: "v25.0", tokenStorePath: join(dir, "token.json"), publishLogPath: join(dir, "publish.jsonl") },
        approvalKeyPath: join(dir, "approval-key.json"), auditPath: join(dir, "mutation-audit.jsonl"),
        hub: new CompanionHub({ storagePath: join(dir, "hub.json") })
      });
      const listener = await runtime.startHttpServer({ host: "127.0.0.1", port, bearerSecret: bearer,
        allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [url], maxRequestBytes: 4_096 });
      listeners.push(listener);
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
      const client = new Client({ name: "configured-runtime", version: "1.0.0" });
      try {
        await client.connect(transport);
        const start = await client.callTool({ name: "meta_begin_oauth", arguments: {} });
        const login = JSON.parse(((start as { content: Array<{ text: string }> }).content[0]!).text);
        const loginUrl = new URL(login.authorizationUrl);
        expect(loginUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(login.expiresInSeconds).toBe(600);
        const rejected = await fetch(`${url}/oauth/callback?code=synthetic-code&state=${"x".repeat(43)}`);
        expect(rejected.status).toBe(400);
        const challenge = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-42`);
        expect([challenge.status, await challenge.text()]).toEqual([200, "challenge-42"]);
        const event = JSON.stringify({ object: "instagram", entry: [{ id: "ig-account-42", time: 1, messaging: [{ message: { mid: "synthetic-message" } }] }] });
        const signature = createHmac("sha256", "synthetic-app-secret").update(event).digest("hex");
        const received = await fetch(`${url}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` }, body: event });
        expect([received.status, await received.text()]).toEqual([200, "EVENT_RECEIVED"]);
        expect(await readFile(join(dir, "events.jsonl"), "utf8")).toContain("synthetic-message");
      } finally { await client.close(); }
    } finally {
      restoreEnv("META_WEBHOOK_VERIFY_TOKEN", previous.verify);
      restoreEnv("META_WEBHOOK_ACCOUNT_IDS", previous.accounts);
      restoreEnv("META_WEBHOOK_JOURNAL_PATH", previous.journal);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
function waitForIntegration(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const poll = () => predicate() ? resolve() : Date.now() >= end ? reject(new Error("timed out waiting for integration event")) : setTimeout(poll, 5);
    poll();
  });
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
