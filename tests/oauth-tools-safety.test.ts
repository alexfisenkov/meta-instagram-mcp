import { describe, expect, it, vi } from "vitest";
import { requestJsonHttp } from "../src/http-json.js";
import { createToolHandlers } from "../src/tools.js";
import { jsonHttpResponse } from "./helpers/json-http.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));

const httpMock = vi.mocked(requestJsonHttp);

function handlers(token: unknown, accessToken?: string) {
  const load = vi.fn(async () => token as never);
  const save = vi.fn(async () => undefined);
  return {
    handlers: createToolHandlers({
      config: {
        authMode: "instagram",
        accessToken,
        appId: "fixture-app",
        appSecret: "fixture-secret",
        redirectUri: "http://localhost:8787/callback",
        graphApiVersion: "v25.0",
        tokenStorePath: "/private/config/token.json",
        publishLogPath: "/private/config/publish-log.jsonl",
      },
      tokenStore: { load, save },
    }),
    load,
    save,
  };
}

describe("meta_exchange_code safety", () => {
  it("rejects a save to an occupied token store before exchanging the code", async () => {
    httpMock.mockReset();
    const current = { accessToken: "existing-private-token", authMode: "instagram", userId: "existing-account" };
    const subject = handlers(current);

    await expect(subject.handlers.exchangeCode({ code: "fixture-code" })).rejects.toThrow(/TOKEN_STORE_NOT_EMPTY/);

    expect(subject.load).toHaveBeenCalledTimes(1);
    expect(httpMock).not.toHaveBeenCalled();
    expect(subject.save).not.toHaveBeenCalled();
  });

  it("allows a non-saving code inspection without reading or changing an occupied store", async () => {
    httpMock.mockReset();
    httpMock
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "short-lived-token", user_id: "ig-account" }))
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "long-lived-private-token", expires_in: 3600 }));
    const subject = handlers({ accessToken: "existing-private-token", userId: "existing-account" });

    const result = await subject.handlers.exchangeCode({ code: "fixture-code", save: false });

    expect(subject.load).not.toHaveBeenCalled();
    expect(subject.save).not.toHaveBeenCalled();
    expect(result.accessToken).not.toBe("long-lived-private-token");
    expect(JSON.stringify(result)).not.toContain("long-lived-private-token");
  });

  it("retains first-install save behavior when the token store is empty", async () => {
    httpMock.mockReset();
    httpMock
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "short-lived-token", user_id: "ig-account" }))
      .mockResolvedValueOnce(jsonHttpResponse({ access_token: "long-lived-private-token", expires_in: 3600 }));
    const subject = handlers(undefined);

    await subject.handlers.exchangeCode({ code: "fixture-code" });

    expect(httpMock).toHaveBeenCalledTimes(2);
    expect(subject.save).toHaveBeenCalledWith(expect.objectContaining({ userId: "ig-account" }));
  });

  it("preserves resolved account IDs when refreshing the active token", async () => {
    httpMock.mockReset().mockResolvedValueOnce(jsonHttpResponse({ access_token: "refreshed-private-token", expires_in: 3600 }));
    const subject = handlers({ accessToken: "existing-private-token", authMode: "instagram", userId: "ig-account-1", pageId: "page-1" });

    await subject.handlers.refreshToken();

    expect(subject.save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "refreshed-private-token", userId: "ig-account-1", pageId: "page-1", authMode: "instagram"
    }));
  });

  it("refuses a caller-supplied refresh token from replacing an occupied store before Meta access", async () => {
    httpMock.mockReset();
    const subject = handlers({ accessToken: "active-private-token", authMode: "instagram", userId: "ig-account-1" });

    await expect(subject.handlers.refreshToken({ accessToken: "other-private-token" })).rejects.toThrow(/TOKEN_STORE_NOT_EMPTY/);

    expect(subject.load).toHaveBeenCalledTimes(1);
    expect(httpMock).not.toHaveBeenCalled();
    expect(subject.save).not.toHaveBeenCalled();
  });

  it("refuses a configured environment token from replacing an occupied store before Meta access", async () => {
    httpMock.mockReset();
    const subject = handlers({ accessToken: "active-private-token", authMode: "instagram", userId: "ig-account-1" }, "other-private-token");

    await expect(subject.handlers.refreshToken()).rejects.toThrow(/TOKEN_STORE_NOT_EMPTY/);

    expect(subject.load).toHaveBeenCalledTimes(1);
    expect(httpMock).not.toHaveBeenCalled();
    expect(subject.save).not.toHaveBeenCalled();
  });

  it("refuses to refresh a stored token whose auth mode differs from configured auth mode", async () => {
    httpMock.mockReset();
    const subject = handlers({
      accessToken: "active-private-token",
      authMode: "facebook",
      userId: "ig-account-1",
    });

    await expect(subject.handlers.refreshToken()).rejects.toThrow("TOKEN_STORE_AUTH_MODE_MISMATCH");

    expect(subject.load).toHaveBeenCalledTimes(1);
    expect(httpMock).not.toHaveBeenCalled();
    expect(subject.save).not.toHaveBeenCalled();
  });

  it("keeps stored metadata when an explicit refresh uses the active stored token", async () => {
    httpMock.mockReset().mockResolvedValueOnce(jsonHttpResponse({ access_token: "refreshed-private-token", expires_in: 3600 }));
    const subject = handlers({ accessToken: "active-private-token", authMode: "instagram", userId: "ig-account-1", pageId: "page-1" });

    await subject.handlers.refreshToken({ accessToken: "active-private-token" });

    expect(subject.save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "refreshed-private-token", userId: "ig-account-1", pageId: "page-1", authMode: "instagram"
    }));
  });

  it("keeps stored metadata when a configured environment token matches the active token", async () => {
    httpMock.mockReset().mockResolvedValueOnce(jsonHttpResponse({ access_token: "refreshed-private-token", expires_in: 3600 }));
    const subject = handlers({ accessToken: "active-private-token", authMode: "instagram", userId: "ig-account-1", pageId: "page-1" }, "active-private-token");

    await subject.handlers.refreshToken();

    expect(subject.save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "refreshed-private-token", userId: "ig-account-1", pageId: "page-1", authMode: "instagram"
    }));
  });
});
