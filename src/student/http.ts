import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateSubject, safeEqual, type SubjectAuthConfig } from "./auth.js";
import { StudentBroker } from "./broker.js";
import { createStudentMcp } from "./mcp.js";
import { StudentRegistry } from "./registry.js";
import { StudentVault } from "./vault.js";
import { BrokerError } from "./types.js";
import { receiveStudentWebhook } from "./webhooks.js";
import { renderLegal, validateLegal, type LegalConfig } from "./legal.js";
interface Options { broker: StudentBroker; registry: StudentRegistry; vault: StudentVault; auth: SubjectAuthConfig; port: number; allowedHosts?: string[]; legal?: LegalConfig }
export async function startStudentServer(options: Options): Promise<{ url: string; close(): Promise<void> }> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535 || options.auth.serviceToken.length < 32 || options.auth.subjectKey.length < 32) throw new BrokerError("invalid_server_config");
  if (options.legal) validateLegal(options.legal);
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => { void dispatch(request, response).catch((error) => { if (!response.headersSent) json(response, error instanceof BrokerError && error.code === "unauthorized" ? 401 : error instanceof BrokerError && error.code === "request_too_large" ? 413 : 400, { error: error instanceof BrokerError ? error.code : "invalid_request" }); else response.destroy(); }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new BrokerError("listener_failed");
  const url = `http://127.0.0.1:${address.port}`;
  // Только счётчик текущего процесса: ни содержимого callback, ни строк журнала.
  let callbacksReceived = 0;
  async function dispatch(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
    const counts = new Map<string, number>(); for (let i = 0; i < request.rawHeaders.length; i += 2) { const name = request.rawHeaders[i].toLowerCase(); counts.set(name, (counts.get(name) ?? 0) + 1); }
    if (["host", "authorization", "x-meta-subject", "origin", "x-hub-signature-256", "content-length", "transfer-encoding"].some((key) => (counts.get(key) ?? 0) > 1)) throw new BrokerError("ambiguous_security_header");
    if (!(options.allowedHosts ?? [`127.0.0.1:${address && typeof address !== "string" ? address.port : options.port}`]).includes(request.headers.host ?? "")) return json(response, 403, { error: "host_not_allowed" });
    if (request.headers.origin) return json(response, 403, { error: "origin_not_allowed" });
    const parsed = new URL(request.url ?? "/", url);
    if (parsed.pathname === "/privacy" || parsed.pathname === "/data-deletion") {
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"); response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (!options.legal) return json(response, 503, { error: "not_configured" });
      response.statusCode = 200; response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(renderLegal(options.legal, parsed.pathname === "/data-deletion")); return;
    }
    if (parsed.pathname === "/health") return json(response, request.method === "GET" ? 200 : 405, { status: "ok", callbacksReceived });
    if (parsed.pathname === "/student/oauth/callback") {
      if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      callbacksReceived = Math.min(Number.MAX_SAFE_INTEGER, callbacksReceived + 1);
      if (["state", "code", "error"].some((key) => parsed.searchParams.getAll(key).length > 1)) throw new BrokerError("invalid_callback");
      const target = await options.broker.callback({ state: parsed.searchParams.get("state") ?? undefined, code: parsed.searchParams.get("code") ?? undefined, error: parsed.searchParams.get("error") ?? undefined });
      response.statusCode = 303; response.setHeader("Location", target); response.end(); return;
    }
    if (parsed.pathname.startsWith("/student/webhooks/")) {
      const key = parsed.pathname.slice("/student/webhooks/".length); const config = options.registry.byKey(key); if (!config) return json(response, 404, { error: "not_found" });
      if (request.method === "GET") {
        const challenge = parsed.searchParams.get("hub.challenge") ?? "";
        if (!config.webhookVerifyToken || parsed.searchParams.get("hub.mode") !== "subscribe" || !safeEqual(parsed.searchParams.get("hub.verify_token") ?? "", config.webhookVerifyToken) || !/^[A-Za-z0-9._-]{1,256}$/.test(challenge)) return json(response, 403, { error: "verification_failed" });
        response.statusCode = 200; response.setHeader("Content-Type", "text/plain"); response.end(challenge); return;
      }
      if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      const signature = request.headers["x-hub-signature-256"];
      await receiveStudentWebhook(options.vault, config, await body(request, 262_144), typeof signature === "string" ? signature : undefined);
      return json(response, 200, { status: "received" });
    }
    if (parsed.pathname !== "/student/mcp") return json(response, 404, { error: "not_found" });
    const subject = authenticateSubject(request.headers.authorization, typeof request.headers["x-meta-subject"] === "string" ? request.headers["x-meta-subject"] : undefined, options.auth);
    if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
    if (parsed.search) throw new BrokerError("query_not_allowed");
    const data = JSON.parse((await body(request, 65_536)).toString("utf8"));
    const mcp = createStudentMcp(options.broker, subject), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await mcp.connect(transport); await transport.handleRequest(request, response, data); }
    finally { await mcp.close().catch(() => undefined); await transport.close().catch(() => undefined); }
  }
  return { url, close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
async function body(request: IncomingMessage, limit: number): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > limit) throw new BrokerError("request_too_large"); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks); }
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); }
