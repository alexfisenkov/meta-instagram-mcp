import { requestJsonHttp, type JsonHttpResponse } from "./http-json.js";

export type GraphQueryValue = string | number | boolean | string[] | number[] | boolean[] | undefined;
export type GraphQuery = Record<string, GraphQueryValue>;
export type GraphGetParams = { [key: string]: GraphQueryValue | GraphQuery } & { query?: GraphQuery };
export type GraphJsonValue = string | number | boolean | null | GraphJsonValue[] | { [key: string]: GraphJsonValue };
export type GraphJsonRecord = Readonly<Record<string, GraphJsonValue>>;

const RESERVED_QUERY_KEYS = new Set(["method", "_method", "access_token"]);
const ALLOWED_GRAPH_HOSTS = new Set(["graph.facebook.com", "graph.instagram.com"]);
const SECRET_FIELD_NAMES = new Set([
  "accesstoken", "appsecret", "clientsecret", "authorization", "proxyauthorization",
  "refreshtoken", "clienttoken"
]);
const MAX_PAGE_LOOKUP_PAGES = 5;

export class MetaApiError extends Error {
  readonly status: number;
  readonly apiCode?: number | string;

  constructor(message: string, status: number, apiCode?: number | string) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.apiCode = apiCode;
  }
}

/** Safe transport classification survives message redaction without retaining a cause. */
export class MetaTransportError extends Error {
  readonly outcome: "unknown" = "unknown";
  readonly transportName?: "JsonHttpNetworkError" | "TimeoutError" | "AbortError" | "TypeError";
  readonly transportCode?: string;

  constructor(message: string, metadata: { name?: MetaTransportError["transportName"]; code?: string } = {}) {
    super(message);
    this.name = "MetaTransportError";
    this.transportName = metadata.name;
    this.transportCode = metadata.code;
  }
}

export interface FacebookPageClient {
  client: MetaClient;
  pageId: string;
  instagramUserId?: string;
  tasks: string[];
}

export class MetaClient {
  readonly #accessToken: string;
  readonly #apiVersion: string;
  readonly #baseUrl: string;

  constructor(options: { accessToken: string; apiVersion: string; baseUrl: string }) {
    this.#baseUrl = validateBaseUrl(options.baseUrl).origin;
    this.#accessToken = options.accessToken;
    this.#apiVersion = options.apiVersion;
  }

  async get(path: string, query: GraphGetParams = {}): Promise<unknown> {
    const url = this.buildUrl(path);
    const nestedQuery = query.query;
    for (const [key, value] of Object.entries(query)) {
      if (key === "query") continue;
      appendParam(url, key, value as GraphQueryValue);
    }
    if (nestedQuery) {
      for (const [key, value] of Object.entries(nestedQuery)) appendParam(url, key, value);
    }
    assertNoReservedParams(url.searchParams);
    url.searchParams.set("access_token", this.#accessToken);
    const body = await this.request(url, { method: "GET", headers: { accept: "application/json" } });
    return sanitizeGraphValue(body, this.#accessToken);
  }

  /** Legacy Graph form POST. Kept for current media publishing callers. */
  async post(path: string, params: GraphQuery = {}): Promise<unknown> {
    const url = this.buildUrl(path);
    assertNoReservedParams(url.searchParams);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) setParam(body, key, value);
    assertNoReservedParams(body);
    body.set("access_token", this.#accessToken);
    const responseBody = await this.request(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
      allowRouteRetry: false
    });
    return sanitizeGraphValue(responseBody, this.#accessToken);
  }

  /** JSON POST for nested Graph payloads such as messaging recipients and messages. */
  async postJson(path: string, body: GraphJsonRecord): Promise<unknown> {
    const url = this.buildUrl(path);
    assertNoReservedParams(url.searchParams);
    assertNoReservedJsonKeys(body);
    const responseBody = await this.request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${this.#accessToken}`
      },
      body: JSON.stringify(body),
      allowRouteRetry: false
    });
    return sanitizeGraphValue(responseBody, this.#accessToken);
  }

  async delete(path: string, query: GraphGetParams = {}): Promise<unknown> {
    const url = this.buildUrl(path);
    const nestedQuery = query.query;
    for (const [key, value] of Object.entries(query)) {
      if (key === "query") continue;
      appendParam(url, key, value as GraphQueryValue);
    }
    if (nestedQuery) {
      for (const [key, value] of Object.entries(nestedQuery)) appendParam(url, key, value);
    }
    assertNoReservedParams(url.searchParams);
    url.searchParams.set("access_token", this.#accessToken);
    const body = await this.request(url, {
      method: "DELETE",
      headers: { accept: "application/json" },
      allowRouteRetry: false
    });
    return sanitizeGraphValue(body, this.#accessToken);
  }

  /** Resolve one Facebook Page and create a client bound to its Page token. */
  async forFacebookPage(pageId: string): Promise<FacebookPageClient> {
    if (new URL(this.#baseUrl).hostname !== "graph.facebook.com") {
      throw new Error("Facebook Page lookup requires graph.facebook.com.");
    }
    if (!pageId || /[/?#]/.test(pageId)) throw new Error("A valid Facebook Page id is required.");

    let after: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_PAGE_LOOKUP_PAGES; page += 1) {
      const url = this.buildUrl("/me/accounts");
      url.searchParams.set("fields", "id,access_token,tasks,instagram_business_account");
      if (after) url.searchParams.set("after", after);
      assertNoReservedParams(url.searchParams);
      url.searchParams.set("access_token", this.#accessToken);

      const body = await this.request(url, { method: "GET", headers: { accept: "application/json" } });
      if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("Meta returned an invalid Facebook Pages response.");
      for (const candidate of body.data) {
        if (!isRecord(candidate) || candidate.id !== pageId) continue;
        const pageToken = typeof candidate.access_token === "string" ? candidate.access_token : "";
        if (!pageToken) throw new Error("The requested Facebook Page has no usable Page access token.");
        const ig = isRecord(candidate.instagram_business_account) && typeof candidate.instagram_business_account.id === "string"
          ? candidate.instagram_business_account.id
          : undefined;
        const tasks = Array.isArray(candidate.tasks)
          ? candidate.tasks.filter((task): task is string => typeof task === "string")
          : [];
        return {
          client: new MetaClient({ accessToken: pageToken, apiVersion: this.#apiVersion, baseUrl: this.#baseUrl }),
          pageId,
          ...(ig ? { instagramUserId: ig } : {}),
          tasks
        };
      }
      const paging = isRecord(body.paging) ? body.paging : undefined;
      const cursors = paging && isRecord(paging.cursors) ? paging.cursors : undefined;
      const cursor = cursors && typeof cursors.after === "string" ? cursors.after : undefined;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      after = cursor;
    }
    throw new Error("The requested Facebook Page was not found in the available Pages.");
  }

  private async request(url: URL, init: Parameters<typeof requestJsonHttp>[1]): Promise<unknown> {
    let response: JsonHttpResponse;
    try {
      response = await requestJsonHttp(url, init);
    } catch (error) {
      const metadata = safeTransportMetadata(error);
      throw new MetaTransportError(
        sanitizeText(error instanceof Error ? error.message : String(error), this.#accessToken), metadata
      );
    }
    if (!response.ok || isMetaError(response.body)) {
      const { message, apiCode } = formatMetaError(response.status, response.body, this.#accessToken);
      throw new MetaApiError(message, response.status, apiCode);
    }
    return response.body;
  }

  private buildUrl(path: string): URL {
    if (path.startsWith("//")) {
      const absolute = new URL(`https:${path}`);
      assertAllowedGraphUrl(absolute, "Absolute Graph path");
      return absolute;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
      let absolute: URL;
      try { absolute = new URL(path); } catch { throw new Error("Graph path must be a valid HTTPS URL or relative path."); }
      assertAllowedGraphUrl(absolute, "Absolute Graph path");
      return absolute;
    }
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const fullPath = cleanPath.startsWith(`/${this.#apiVersion}/`) || cleanPath === `/${this.#apiVersion}`
      ? cleanPath
      : `/${this.#apiVersion}${cleanPath}`;
    const url = new URL(fullPath, this.#baseUrl);
    assertAllowedGraphUrl(url, "Graph path");
    return url;
  }
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Graph base URL must be a valid HTTPS Meta Graph URL."); }
  assertAllowedGraphUrl(url, "Graph base URL");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Graph base URL must be an origin without path, query, or fragment.");
  return url;
}

function assertAllowedGraphUrl(url: URL, label: string): void {
  if (!ALLOWED_GRAPH_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`${label} host "${url.hostname}" is not a Meta Graph host. Only ${[...ALLOWED_GRAPH_HOSTS].join(", ")} are allowed.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain URL credentials.`);
  if (url.port && url.port !== "443") throw new Error(`${label} must use the standard HTTPS port.`);
}

function assertNoReservedParams(params: URLSearchParams): void {
  for (const key of params.keys()) {
    const norm = normalizeKey(key);
    if (RESERVED_QUERY_KEYS.has(norm)) {
      throw new Error(`Reserved query key "${key}" is not allowed (HTTP method override / token injection).`);
    }
  }
}

function assertNoReservedJsonKeys(value: GraphJsonValue): void {
  if (Array.isArray(value)) {
    for (const child of value) assertNoReservedJsonKeys(child);
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (RESERVED_QUERY_KEYS.has(normalizeKey(key))) throw new Error(`Reserved JSON key "${key}" is not allowed.`);
      assertNoReservedJsonKeys(child as GraphJsonValue);
    }
  }
}

function normalizeKey(key: string): string {
  return key.normalize("NFKC").replace(/[\s\p{Cf}]/gu, "").toLowerCase();
}

function normalizeSecretKey(key: string): string {
  return normalizeKey(key).replace(/[_-]/g, "");
}

function isSecretField(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  return SECRET_FIELD_NAMES.has(normalized) || normalized.endsWith("authorization");
}

function appendParam(url: URL, key: string, value: GraphQueryValue | GraphQuery): void {
  setParam(url.searchParams, key, value as GraphQueryValue);
}

function setParam(params: URLSearchParams, key: string, value: GraphQueryValue): void {
  if (value === undefined) return;
  if (Array.isArray(value)) params.set(key, value.join(","));
  else params.set(key, String(value));
}

function isMetaError(value: unknown): boolean { return isRecord(value) && isRecord(value.error); }

function formatMetaError(status: number, body: unknown, accessToken: string): { message: string; apiCode?: number | string } {
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    const raw = typeof error.message === "string" ? error.message : "Meta Graph API error";
    const message = sanitizeText(raw, accessToken);
    const type = sanitizeText(typeof error.type === "string" ? error.type : "unknown", accessToken);
    const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined;
    const safeCode = code === undefined ? "unknown" : sanitizeText(String(code), accessToken);
    const safeApiCode = typeof code === "string" ? sanitizeText(code, accessToken) : code;
    return {
      message: `Meta Graph API error ${status}: ${message} (${type}, code ${safeCode})`,
      ...(safeApiCode === undefined ? {} : { apiCode: safeApiCode })
    };
  }
  return { message: `Meta Graph API error ${status}` };
}

function sanitizeGraphValue(value: unknown, accessToken: string): unknown {
  if (typeof value === "string") return sanitizeText(value, accessToken);
  if (Array.isArray(value)) return value.map((item) => sanitizeGraphValue(item, accessToken));
  if (!isRecord(value)) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretField(key)) safe[key] = "[redacted-secret]";
    else safe[key] = sanitizeGraphValue(child, accessToken);
  }
  return safe;
}

function sanitizeText(text: string, accessToken: string): string {
  let safe = text;
  const encodedToken = new URLSearchParams({ token: accessToken }).toString().slice("token=".length);
  for (const variant of new Set([accessToken, encodeURIComponent(accessToken), encodedToken])) {
    if (variant) safe = safe.split(variant).join("[redacted-token]");
  }
  safe = safe.replace(/\b((?:access[_\s-]?token|app[_\s-]?secret|client[_\s-]?secret|refresh[_\s-]?token|authorization)\s*[:=]\s*)(?:Bearer\s+)?([^\s&,;]+)/gi,
    "$1[redacted-secret]");
  return safe.replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
    const trailing = rawUrl.match(/[),.;!?]+$/)?.[0] ?? "";
    const candidate = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
    try {
      const url = new URL(candidate);
      for (const key of [...url.searchParams.keys()]) {
        if (isSecretField(key) || normalizeKey(key) === "access_token") {
          url.searchParams.set(key, "[redacted-secret]");
        }
      }
      return `${url.href}${trailing}`;
    } catch {
      return rawUrl;
    }
  });
}

function safeTransportMetadata(error: unknown): {
  name?: MetaTransportError["transportName"];
  code?: string;
} {
  const safeNames = new Set(["JsonHttpNetworkError", "TimeoutError", "AbortError", "TypeError"]);
  const safeCodes = new Set([
    "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EPIPE",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"
  ]);
  let current = error;
  let name: MetaTransportError["transportName"] = undefined;
  let code: string | undefined;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const item = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (!name && typeof item.name === "string" && safeNames.has(item.name)) {
      name = item.name as MetaTransportError["transportName"];
    }
    if (!code && typeof item.code === "string" && safeCodes.has(item.code)) code = item.code;
    current = item.cause;
  }
  return { ...(name ? { name } : {}), ...(code ? { code } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
