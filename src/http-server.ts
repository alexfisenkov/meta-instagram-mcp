import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CompanionHub, constantTimeEqual } from "./companion-hub.js";
import { createMcpServer } from "./mcp-server.js";
import { createHttpOptions } from "./transport-config.js";
import type { WebhookReceiver } from "./webhooks.js";

export interface HttpOptions {
  host: "127.0.0.1";
  port: number;
  bearerSecret: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxRequestBytes: number;
}
export interface HttpServerOptions extends HttpOptions {
  hub: CompanionHub;
  mcpFactory?: () => McpServer;
  oauthPath?: string;
  oauthHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  webhookPath?: string;
  webhookReceiver?: WebhookReceiver;
}
export interface Listener { close(): Promise<void> }

export async function startHttpServer(options: HttpServerOptions): Promise<Listener> {
  createHttpOptions(options);
  assertOptionalRoute(options.oauthPath ?? "/oauth/callback");
  assertOptionalRoute(options.webhookPath ?? "/webhook");
  if ((options.oauthPath ?? "/oauth/callback") === (options.webhookPath ?? "/webhook")) throw new Error("OAuth and webhook paths must differ");
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    void dispatch(request, response, options).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function dispatch(request: IncomingMessage, response: ServerResponse, options: HttpServerOptions): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const repeated = repeatedHeaders(request.rawHeaders);
  if (repeated.has("host") || repeated.has("origin")) return sendJson(response, 403, { error: "ambiguous_host_or_origin" });
  if (["authorization", "x-api-protocol-version", "x-bridge-source", "x-hub-signature-256", "content-length", "transfer-encoding"].some((name) => repeated.has(name))) return sendJson(response, 400, { error: "ambiguous_security_header" });
  if (!options.allowedHosts.includes((request.headers.host ?? "").toLowerCase())) return sendJson(response, 403, { error: "host_not_allowed" });
  const origin = request.headers.origin;
  if (origin !== undefined && !options.allowedOrigins.includes(origin)) return sendJson(response, 403, { error: "origin_not_allowed" });
  if (path === (options.oauthPath ?? "/oauth/callback")) {
    if (!options.oauthHandler) return sendJson(response, 404, { error: "not_found" });
    return options.oauthHandler(request, response);
  }
  if (path === (options.webhookPath ?? "/webhook")) {
    if (!options.webhookReceiver) return sendJson(response, 404, { error: "not_found" });
    let rawBody: Buffer | undefined;
    try { if (request.method === "POST") rawBody = await readRawBody(request, options.maxRequestBytes); }
    catch (error) { return sendJson(response, error instanceof BodyLimitError ? 413 : 400, { error: error instanceof BodyLimitError ? "request_too_large" : "invalid_request" }); }
    const result = await options.webhookReceiver.handle({ method: request.method ?? "", url: request.url ?? "/", headers: request.headers, rawBody });
    response.statusCode = result.status;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", result.contentType);
    response.end(result.body);
    return;
  }
  if (path === "/health") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "method_not_allowed" });
    return sendJson(response, 200, { status: "ok" });
  }
  if (path !== "/mcp" && !path.startsWith("/bridge/")) return sendJson(response, 404, { error: "not_found" });
  if (!validBearer(request.headers.authorization, options.bearerSecret)) return sendJson(response, 401, { error: "unauthorized" });

  if (path === "/mcp") {
    if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });
    let body: unknown;
    try { body = await readJsonBody(request, options.maxRequestBytes); }
    catch (error) { return sendJson(response, error instanceof BodyLimitError ? 413 : 400, { error: error instanceof BodyLimitError ? "request_too_large" : "invalid_json" }); }
    const mcpServer = (options.mcpFactory ?? createMcpServer)();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await mcpServer.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
    return;
  }

  if (!path.startsWith("/bridge/")) return sendJson(response, 404, { error: "not_found" });
  if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });
  const bridgeSource = request.headers["x-bridge-source"];
  if (request.headers["x-api-protocol-version"] !== "1" || typeof bridgeSource !== "string" || !["browser", "phone"].includes(bridgeSource)) {
    return sendJson(response, 426, { error: "unsupported_bridge_protocol" });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request, options.maxRequestBytes);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return sendJson(response, error instanceof BodyLimitError ? 413 : 400, { error: error instanceof BodyLimitError ? "request_too_large" : "invalid_json" });
  }
  try {
    if (path === "/bridge/register") {
      const bodySource = body.source ?? (body.mode === "browser_native_host" ? "browser" : body.mode === "phone_standalone" ? "phone" : undefined);
      if (bodySource !== bridgeSource) return sendJson(response, 400, { error: "bridge_source_mismatch" });
      const result = await options.hub.register(body as never);
      return sendJson(response, 201, result);
    }
    const bridgeId = stringField(body, "bridgeId");
    const bridgeToken = stringField(body, "bridgeToken");
    if (path === "/bridge/heartbeat") {
      await options.hub.heartbeat({ bridgeId, bridgeToken, source: bridgeSource as "browser" | "phone", status: body.status });
      return sendJson(response, 204);
    }
    if (path === "/bridge/poll") {
      const tasks = await options.hub.poll(bridgeId, Number(body.maxTasks), bridgeToken, bridgeSource as "browser" | "phone");
      return sendJson(response, 200, { tasks });
    }
    if (path === "/bridge/result") {
      await options.hub.submit(bridgeId, stringField(body, "taskId"), body.result, typeof body.contextHash === "string" ? body.contextHash : undefined, bridgeToken, bridgeSource as "browser" | "phone");
      return sendJson(response, 204);
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch {
    return sendJson(response, 400, { error: "bridge_request_rejected" });
  }
}

function repeatedHeaders(rawHeaders: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}
function assertOptionalRoute(path: string): void {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path === "/health" || path === "/mcp" || path.startsWith("/bridge/")) throw new Error("invalid optional route path");
}

function validBearer(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ") || header.length < 40 || header.length > 8_200) return false;
  return constantTimeEqual(header.slice(7), secret);
}
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error("invalid bridge field");
  return value;
}
class BodyLimitError extends Error {}
async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const raw = await readRawBody(request, limit);
  if (raw.byteLength === 0) return undefined;
  try { return JSON.parse(raw.toString("utf8")) as unknown; }
  catch { throw new Error("invalid json"); }
}
async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && !/^\d+$/.test(declared)) throw new Error("invalid Content-Length");
  if (declared !== undefined && Number(declared) > limit) { request.resume(); throw new BodyLimitError(); }
  const chunks: Buffer[] = [];
  let total = 0;
  let oversized = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) { oversized = true; chunks.length = 0; continue; }
    if (!oversized) chunks.push(buffer);
  }
  if (oversized) throw new BodyLimitError();
  return Buffer.concat(chunks);
}
function sendJson(response: ServerResponse, status: number, value?: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  if (status === 204) { response.end(); return; }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}
