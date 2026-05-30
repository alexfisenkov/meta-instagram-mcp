export type FetchLike = typeof fetch;

export interface MetaClientOptions {
  accessToken: string;
  apiVersion: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export interface MetaGetParams {
  fields?: string[];
  metric?: string;
  period?: string;
  metricType?: string;
  breakdown?: string;
  timeframe?: string;
  since?: string | number;
  until?: string | number;
  limit?: number;
  after?: string;
  before?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export class MetaApiError extends Error {
  readonly status: number;
  readonly type?: string;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;

  constructor(message: string, options: {
    status: number;
    type?: string;
    code?: number;
    subcode?: number;
    fbtraceId?: string;
  }) {
    super(message);
    this.name = "MetaApiError";
    this.status = options.status;
    this.type = options.type;
    this.code = options.code;
    this.subcode = options.subcode;
    this.fbtraceId = options.fbtraceId;
  }
}

export class MetaClient {
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: MetaClientOptions) {
    this.accessToken = options.accessToken;
    this.apiVersion = normalizeVersion(options.apiVersion);
    this.baseUrl = (options.baseUrl ?? "https://graph.instagram.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(path: string, params: MetaGetParams = {}): Promise<unknown> {
    const url = this.buildUrl(path);
    appendParams(url, params);
    url.searchParams.set("access_token", this.accessToken);

    const response = await this.fetchImpl(url);
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw this.toMetaError(response.status, body as MetaErrorBody);
    }

    return body;
  }

  private buildUrl(path: string): URL {
    if (!path.startsWith("/") || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
      throw new Error("Meta path must be relative and start with /");
    }

    return new URL(`${this.baseUrl}/${this.apiVersion}${path}`);
  }

  private toMetaError(status: number, body: MetaErrorBody): MetaApiError {
    const meta = body.error;
    const message = sanitizeMessage(meta?.message ?? `Meta API request failed with HTTP ${status}`, this.accessToken);

    return new MetaApiError(message, {
      status,
      type: meta?.type,
      code: meta?.code,
      subcode: meta?.error_subcode,
      fbtraceId: meta?.fbtrace_id,
    });
  }
}

function appendParams(url: URL, params: MetaGetParams): void {
  if (params.fields?.length) url.searchParams.set("fields", params.fields.join(","));
  if (params.metric) url.searchParams.set("metric", params.metric);
  if (params.period) url.searchParams.set("period", params.period);
  if (params.metricType) url.searchParams.set("metric_type", params.metricType);
  if (params.breakdown) url.searchParams.set("breakdown", params.breakdown);
  if (params.timeframe) url.searchParams.set("timeframe", params.timeframe);
  if (params.since !== undefined) url.searchParams.set("since", String(params.since));
  if (params.until !== undefined) url.searchParams.set("until", String(params.until));
  if (params.limit !== undefined) url.searchParams.set("limit", String(params.limit));
  if (params.after) url.searchParams.set("after", params.after);
  if (params.before) url.searchParams.set("before", params.before);

  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
}

function normalizeVersion(version: string): string {
  return version.replace(/^\/+|\/+$/g, "");
}

function sanitizeMessage(message: string, token: string): string {
  return message.split(token).join("[redacted-token]");
}
