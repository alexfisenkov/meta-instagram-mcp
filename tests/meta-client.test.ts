import { beforeEach, describe, expect, it, vi } from "vitest";

// Транспорт больше не инжектится через fetchImpl — MetaClient импортирует
// requestJsonHttp напрямую, поэтому подменяем модуль целиком.
vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));

import { requestJsonHttp } from "../src/http-json.js";
import { MetaApiError, MetaClient } from "../src/meta-client.js";
import { jsonHttpResponse, metaErrorResponse } from "./helpers/json-http.js";

const httpMock = vi.mocked(requestJsonHttp);

function makeClient(baseUrl = "https://graph.instagram.com"): MetaClient {
  return new MetaClient({ accessToken: "token", apiVersion: "v25.0", baseUrl });
}

function requestedUrl(call = 0): URL {
  return httpMock.mock.calls[call][0];
}

describe("MetaClient request assembly", () => {
  beforeEach(() => {
    httpMock.mockReset();
  });

  it("adds api version, fields, pagination and the access token", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [{ id: "1" }] }));

    const result = await makeClient().get("/me/media", { fields: ["id", "caption"], limit: 25 });

    expect(result).toEqual({ data: [{ id: "1" }] });
    expect(requestedUrl().href).toBe(
      "https://graph.instagram.com/v25.0/me/media?fields=id%2Ccaption&limit=25&access_token=token"
    );
    expect(httpMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("does not prefix the api version twice and trims the base url", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ id: "17841400000000000" }));

    await makeClient("https://graph.facebook.com/").get("/v25.0/me");

    expect(requestedUrl().href).toBe("https://graph.facebook.com/v25.0/me?access_token=token");
  });

  it("merges the nested query object and skips undefined values", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] }));

    await makeClient().get("/me/media", { limit: undefined, query: { since: "2026-01-01" } });

    expect(requestedUrl().searchParams.get("since")).toBe("2026-01-01");
    expect(requestedUrl().searchParams.has("limit")).toBe(false);
  });

  it("raises Meta errors returned with a non-2xx status", async () => {
    httpMock.mockResolvedValueOnce(metaErrorResponse("Unsupported get request."));

    const error = await makeClient().get("/me").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ status: 400, apiCode: 190 });
    expect((error as Error).message).toBe("Meta Graph API error 400: Unsupported get request. (OAuthException, code 190)");
  });

  it("raises Meta errors that arrive with a 200 status", async () => {
    httpMock.mockResolvedValueOnce(metaErrorResponse("Rate limited", { status: 200, type: "OAuthException", code: 4 }));

    await expect(makeClient().get("/me")).rejects.toThrow("Meta Graph API error 200: Rate limited");
  });

  it("sends nested JSON unchanged with Bearer authorization and does not retry writes", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ recipient_id: "person-7" }));

    const result = await makeClient("https://graph.facebook.com").postJson("/v25.0/me/messages", {
      recipient: { id: "person-7" },
      message: { text: "A nested reply" }
    });

    expect(result).toEqual({ recipient_id: "person-7" });
    const [url, init] = httpMock.mock.calls[0];
    expect(url.href).toBe("https://graph.facebook.com/v25.0/me/messages");
    expect(init?.method).toBe("POST");
    expect(init?.allowRouteRetry).toBe(false);
    expect(init?.headers?.authorization).toBe("Bearer token");
    expect(String(init?.body)).toBe(JSON.stringify({ recipient: { id: "person-7" }, message: { text: "A nested reply" } }));
  });

  it("sends DELETE once with its query and access token", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ success: true }));

    await makeClient("https://graph.facebook.com").delete("/v25.0/comment-9", { reason: "cleanup" });

    const [url, init] = httpMock.mock.calls[0];
    expect(url.searchParams.get("reason")).toBe("cleanup");
    expect(url.searchParams.get("access_token")).toBe("token");
    expect(init?.method).toBe("DELETE");
    expect(init?.allowRouteRetry).toBe(false);
  });
});
