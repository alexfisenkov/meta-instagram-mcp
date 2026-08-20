import { request as httpsRequest, type RequestOptions } from "node:https";

export interface JsonHttpRequestInit {
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string | Buffer | URLSearchParams;
  timeoutMs?: number;
}

export interface JsonHttpAttempt {
  route: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface JsonHttpResponse {
  ok: boolean;
  status: number;
  body: unknown;
  text: string;
  attempts: JsonHttpAttempt[];
}

export class JsonHttpNetworkError extends Error {
  readonly attempts: JsonHttpAttempt[];

  constructor(url: URL, attempts: JsonHttpAttempt[]) {
    super(`Meta HTTP network failure for ${safeUrlLabel(url)} after ${attempts.length} attempt(s): ${lastAttemptError(attempts)}`);
    this.name = "JsonHttpNetworkError";
    this.attempts = attempts;
  }
}

export async function requestJsonHttp(url: URL, init: JsonHttpRequestInit = {}): Promise<JsonHttpResponse> {
  const routes = buildRoutes(url.hostname);
  const attempts: JsonHttpAttempt[] = [];

  for (const route of routes) {
    try {
      const response = await requestOnce(url, init, route.ip);
      attempts.push({ route: route.label, ok: true, status: response.status });
      return { ...response, attempts };
    } catch (error) {
      attempts.push({ route: route.label, ok: false, error: errorMessage(error) });
    }
  }

  throw new JsonHttpNetworkError(url, attempts);
}

function requestOnce(url: URL, init: JsonHttpRequestInit, fallbackIp?: string): Promise<Omit<JsonHttpResponse, "attempts">> {
  return new Promise((resolve, reject) => {
    const body = normalizeBody(init.body);
    const headers = normalizeHeaders(init.headers);
    if (body && !hasHeader(headers, "content-length")) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers,
      timeout: init.timeoutMs ?? metaHttpTimeoutMs()
    };

    if (fallbackIp) {
      options.lookup = (_hostname, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
        const lookupOptions = typeof optionsOrCallback === "object" ? optionsOrCallback : {};
        const family = fallbackIp.includes(":") ? 6 : 4;
        if (!callback) throw new Error("lookup callback was not provided");
        if (lookupOptions.all) {
          callback(null, [{ address: fallbackIp, family }]);
        } else {
          callback(null, fallbackIp, family);
        }
      };
    }

    const req = httpsRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
          status: res.statusCode ?? 0,
          text,
          body: parseBody(text)
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${options.timeout}ms`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildRoutes(hostname: string): Array<{ label: string; ip?: string }> {
  const systemRoute = { label: "system-dns" };
  const fallbackRoutes = fallbackIpsForHost(hostname).map((ip) => ({ label: `fallback-ip:${ip}`, ip }));
  if (preferFallbackFirst() && fallbackRoutes.length) return [...fallbackRoutes, systemRoute];
  return [systemRoute, ...fallbackRoutes];
}

function fallbackIpsForHost(hostname: string): string[] {
  if (hostname !== "graph.facebook.com") return [];
  const configured = parseIpList(process.env.META_GRAPH_FALLBACK_IPS);
  if (configured === "disabled") return [];
  if (configured.length) return configured;

  // These are only used after the normal system-DNS route fails.
  return ["57.144.104.141", "157.240.254.12", "57.144.204.141", "31.13.72.36"];
}

function parseIpList(value: string | undefined): string[] | "disabled" {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  if (["0", "false", "off", "none", "disabled"].includes(trimmed.toLowerCase())) return "disabled";
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeBody(body: JsonHttpRequestInit["body"]): string | Buffer | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  return body.toString();
}

function normalizeHeaders(headers: JsonHttpRequestInit["headers"]): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

function hasHeader(headers: Record<string, string>, target: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === target.toLowerCase());
}

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function metaHttpTimeoutMs(): number {
  const parsed = Number(process.env.META_GRAPH_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

function preferFallbackFirst(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.META_GRAPH_PREFER_FALLBACK ?? "").toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastAttemptError(attempts: JsonHttpAttempt[]): string {
  return [...attempts].reverse().find((attempt) => attempt.error)?.error ?? "unknown error";
}

function safeUrlLabel(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
