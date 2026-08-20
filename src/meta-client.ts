import { requestJsonHttp } from "./http-json.js";

export type GraphQueryValue = string | number | boolean | string[] | number[] | boolean[] | undefined;

export type GraphQuery = Record<string, GraphQueryValue>;

/**
 * Параметры одного GET: плоские ключи плюс опциональный вложенный `query` —
 * именно так их присылает meta_raw_get. Отдельный тип нужен потому, что
 * индексная сигнатура GraphQuery не уживается с полем `query` объектного типа:
 * `GraphQuery & { query?: GraphQuery }` невозможно передать никаким значением.
 * Раньше это не всплывало только из-за `ToolArgs = Record<string, any>`.
 */
export type GraphGetParams = { [key: string]: GraphQueryValue | GraphQuery } & { query?: GraphQuery };

export class MetaClient {
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;

  constructor(options: { accessToken: string; apiVersion: string; baseUrl: string }) {
    this.accessToken = options.accessToken;
    this.apiVersion = options.apiVersion;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async get(path: string, query: GraphGetParams = {}): Promise<unknown> {
    const url = this.buildUrl(path);
    const nestedQuery = query.query;
    for (const [key, value] of Object.entries(query)) {
      if (key === "query") continue;
      appendParam(url, key, value as GraphQueryValue);
    }
    if (nestedQuery) {
      for (const [key, value] of Object.entries(nestedQuery)) {
        appendParam(url, key, value);
      }
    }
    // Guard on the ASSEMBLED url, not on the input object: reserved params can
    // arrive through the `query` object OR baked into `path` ("/me?method=delete").
    // Graph API reinterprets `method`/`_method` as an HTTP-verb override (a "GET"
    // becomes POST/DELETE on Meta's side) and `access_token` could swap identity —
    // raw_get is documented strictly read-only, so any source is rejected loudly.
    // Checked before we set our own access_token below (found by code review
    // 2026-08-19/20; path-vector caught on re-review 2026-08-20).
    assertNoReservedParams(url.searchParams);
    url.searchParams.set("access_token", this.accessToken);

    const response = await requestJsonHttp(url, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    const body = response.body;
    if (!response.ok || isMetaError(body)) {
      throw new Error(formatMetaError(response.status, body, this.accessToken));
    }
    return body;
  }

  private buildUrl(path: string): URL {
    // Absolute URLs are allowed only to Meta Graph hosts. Without this an absolute
    // `path` (e.g. "https://attacker.example/collect") would receive our real
    // access_token below — SSRF + token exfiltration. The host allow-list restores
    // the "path must be relative"-class guard dropped in an intermediate refactor
    // (found on re-review 2026-08-20).
    if (/^https?:\/\//i.test(path)) {
      const abs = new URL(path);
      if (!ALLOWED_GRAPH_HOSTS.has(abs.hostname.toLowerCase())) {
        throw new Error(
          `Absolute path host "${abs.hostname}" is not a Meta Graph host. ` +
          `Only ${[...ALLOWED_GRAPH_HOSTS].join(", ")} are allowed.`
        );
      }
      return abs;
    }
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    if (cleanPath.startsWith(`/${this.apiVersion}/`)) {
      return new URL(cleanPath, this.baseUrl);
    }
    return new URL(`/${this.apiVersion}${cleanPath}`, this.baseUrl);
  }
}


const RESERVED_QUERY_KEYS = new Set(["method", "_method", "access_token"]);
const ALLOWED_GRAPH_HOSTS = new Set(["graph.facebook.com", "graph.instagram.com"]);

function assertNoReservedParams(params: URLSearchParams): void {
  for (const key of params.keys()) {
    // Нормализуем перед сравнением: NFKC схлопывает unicode-двойники, затем
    // убираем ВСЕ пробельные и невидимые символы (включая zero-width U+200B и
    // прочие \p{Cf}) — иначе "\u200Bmethod" или "method\t" проскользнули бы
    // мимо точечного сравнения (теоретический зазор, критика 20.08.2026).
    const norm = key.normalize("NFKC").replace(/[\s\p{Cf}]/gu, "").toLowerCase();
    if (RESERVED_QUERY_KEYS.has(norm)) {
      throw new Error(
        `Reserved query key "${key}" is not allowed: Graph API may reinterpret it ` +
        `(HTTP method override / token injection). This client is strictly read-only GET.`
      );
    }
  }
}

function appendParam(url: URL, key: string, value: GraphQueryValue): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    url.searchParams.set(key, value.join(","));
    return;
  }
  url.searchParams.set(key, String(value));
}

function isMetaError(value: unknown): boolean {
  return isRecord(value) && isRecord(value.error);
}

function formatMetaError(status: number, body: unknown, accessToken?: string): string {
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    const raw = typeof error.message === "string" ? error.message : "Meta Graph API error";
    const message = redactToken(raw, accessToken);
    const type = typeof error.type === "string" ? error.type : "unknown";
    const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : "unknown";
    return `Meta Graph API error ${status}: ${message} (${type}, code ${code})`;
  }
  return `Meta Graph API error ${status}`;
}

// Meta периодически возвращает присланный access_token эхом внутри error.message.
// Без очистки он уходит в текст исключения, а оттуда — в ответ MCP-инструмента и
// в любые логи вызывающей стороны. В первой публичной версии очистка была
// (sanitizeMessage), рефакторинг транспорта её потерял — восстановлено 20.08.2026.
function redactToken(message: string, accessToken?: string): string {
  if (!accessToken) return message;
  return message.split(accessToken).join("[redacted-token]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
