import type { JsonHttpResponse } from "../../src/http-json.js";

/**
 * Builds a response shaped exactly like `requestJsonHttp` returns it, so tests
 * exercise the real parsing/error paths of the callers without touching the
 * network. Не тест-файл: vitest забирает только *.test.ts.
 */
export function jsonHttpResponse(body: unknown, status = 200): JsonHttpResponse {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    body,
    text: JSON.stringify(body),
    attempts: [{ route: "system-dns", ok, status }]
  };
}

/** Meta returns `{ error: { ... } }` both on 4xx and (occasionally) on 200. */
export function metaErrorResponse(
  message: string,
  options: { status?: number; type?: string; code?: number } = {}
): JsonHttpResponse {
  const { status = 400, type = "OAuthException", code = 190 } = options;
  return jsonHttpResponse({ error: { message, type, code } }, status);
}
