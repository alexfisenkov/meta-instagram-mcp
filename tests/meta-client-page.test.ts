import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));

import { requestJsonHttp } from "../src/http-json.js";
import { MetaClient } from "../src/meta-client.js";
import { verifyOAuthAccountIdentity } from "../src/oauth-account-identity.js";
import { createAccountContextResolver } from "../src/account-context.js";
import { jsonHttpResponse, metaErrorResponse } from "./helpers/json-http.js";

const httpMock = vi.mocked(requestJsonHttp);
const USER_TOKEN = "FAKE_USER_TOKEN_4a19";
const PAGE_TOKEN = "FAKE_PAGE_TOKEN_c820";

function facebookClient(): MetaClient {
  return new MetaClient({ accessToken: USER_TOKEN, apiVersion: "v25.0", baseUrl: "https://graph.facebook.com" });
}

describe("MetaClient Facebook Page client derivation", () => {
  beforeEach(() => httpMock.mockReset());

  it("follows bounded after cursors, matches only the requested page, and keeps the Page token private", async () => {
    httpMock
      .mockResolvedValueOnce(jsonHttpResponse({
        data: [{ id: "other-page", access_token: "FAKE_OTHER_PAGE_TOKEN", tasks: ["ANALYZE"] }],
        paging: { cursors: { after: "SAFE_AFTER_CURSOR" } }
      }))
      .mockResolvedValueOnce(jsonHttpResponse({
        data: [{
          id: "target-page",
          access_token: PAGE_TOKEN,
          tasks: ["ANALYZE", "MESSAGING"],
          instagram_business_account: { id: "safe-ig-account" }
        }]
      }))
      .mockResolvedValueOnce(jsonHttpResponse({ id: "reply-ok", access_token: PAGE_TOKEN }));

    const resolved = await facebookClient().forFacebookPage("target-page");

    expect(httpMock).toHaveBeenCalledTimes(2);
    expect(httpMock.mock.calls[0][0].searchParams.get("fields")).toBe("id,access_token,tasks,instagram_business_account");
    expect(httpMock.mock.calls[0][0].searchParams.get("access_token")).toBe(USER_TOKEN);
    expect(httpMock.mock.calls[1][0].searchParams.get("after")).toBe("SAFE_AFTER_CURSOR");
    expect(resolved).toMatchObject({ pageId: "target-page", instagramUserId: "safe-ig-account", tasks: ["ANALYZE", "MESSAGING"] });
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain(USER_TOKEN);
    expect(serialized).not.toContain(PAGE_TOKEN);

    const reply = await resolved.client.get("/me/messages");
    expect(reply).toMatchObject({ id: "reply-ok", access_token: "[redacted-secret]" });
    expect(httpMock.mock.calls[2][0].searchParams.get("access_token")).toBe(PAGE_TOKEN);
  });

  it("fails clearly when the selected Page is absent and does not expose other Page tokens", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({
      data: [{ id: "different-page", access_token: "FAKE_OTHER_PAGE_TOKEN" }]
    }));

    await expect(facebookClient().forFacebookPage("target-page")).rejects.toThrow(/requested Facebook Page was not found/);
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("refuses Page lookup from the Instagram Graph host without a request", async () => {
    const instagramClient = new MetaClient({ accessToken: USER_TOKEN, apiVersion: "v25.0", baseUrl: "https://graph.instagram.com" });
    await expect(instagramClient.forFacebookPage("target-page")).rejects.toThrow(/requires graph.facebook.com/);
    expect(httpMock).not.toHaveBeenCalled();
  });
});

describe("OAuth opt-in lookup of an explicitly known Facebook Page", () => {
  const PAGE_ID = "123456789";
  const IG_ID = "178400001";
  const directPage = { id: PAGE_ID, name: "Fixture Page", access_token: PAGE_TOKEN,
    instagram_business_account: { id: IG_ID, username: "fixture" } };
  const fallbackOptions = { allowKnownPageFallback: true };
  beforeEach(() => httpMock.mockReset());

  function prepareProof(page: unknown = directPage, owner: unknown = { id: PAGE_ID }, instagram: unknown = { id: IG_ID, username: "fixture" }) {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] }))
      .mockResolvedValueOnce(jsonHttpResponse(page))
      .mockResolvedValueOnce(jsonHttpResponse(owner))
      .mockResolvedValueOnce(jsonHttpResponse(instagram));
  }

  it("requires exact Page token ownership and its linked Instagram read while keeping tokens private and tasks unknown", async () => {
    prepareProof({ ...directPage, tasks: ["MESSAGING"] });
    const resolved = await facebookClient().forFacebookPage(PAGE_ID, fallbackOptions);

    expect(resolved).toMatchObject({ pageId: PAGE_ID, instagramUserId: IG_ID, tasks: [] });
    expect(httpMock.mock.calls.map(([url]) => [url.pathname, url.searchParams.get("access_token")])).toEqual([
      ["/v25.0/me/accounts", USER_TOKEN], [`/v25.0/${PAGE_ID}`, USER_TOKEN],
      ["/v25.0/me", PAGE_TOKEN], [`/v25.0/${IG_ID}`, PAGE_TOKEN],
    ]);
    expect(httpMock.mock.calls[1][0].searchParams.get("fields")).toBe("id,name,access_token,instagram_business_account{id,username}");
    expect(httpMock.mock.calls[2][0].searchParams.get("fields")).toBe("id");
    expect(httpMock.mock.calls[3][0].searchParams.get("fields")).toBe("id,username");
    expect(httpMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(JSON.stringify(resolved)).not.toMatch(new RegExp(`${USER_TOKEN}|${PAGE_TOKEN}`));

    httpMock.mockResolvedValueOnce(jsonHttpResponse({ id: IG_ID, access_token: PAGE_TOKEN }));
    expect(await resolved.client.get(`/${IG_ID}`)).toEqual({ id: IG_ID, access_token: "[redacted-secret]" });
  });

  it.each([
    ["wrong Page ID", { ...directPage, id: "999" }, { id: PAGE_ID }, { id: IG_ID, username: "fixture" }, 2],
    ["missing Page token", { id: PAGE_ID, instagram_business_account: { id: IG_ID } }, { id: PAGE_ID }, { id: IG_ID, username: "fixture" }, 2],
    ["blank Page token", { ...directPage, access_token: "   " }, { id: PAGE_ID }, { id: IG_ID, username: "fixture" }, 2],
    ["invalid Page response", null, { id: PAGE_ID }, { id: IG_ID, username: "fixture" }, 2],
    ["missing Instagram mapping", { id: PAGE_ID, access_token: PAGE_TOKEN }, { id: PAGE_ID }, { id: IG_ID, username: "fixture" }, 2],
    ["nonnumeric Instagram mapping", { ...directPage, instagram_business_account: { id: "../me" } }, { id: PAGE_ID }, { id: IG_ID, username: "fixture" }, 2],
    ["wrong token owner", directPage, { id: "999" }, { id: IG_ID, username: "fixture" }, 3],
    ["invalid token owner response", directPage, { data: [] }, { id: IG_ID, username: "fixture" }, 3],
    ["wrong Instagram ID", directPage, { id: PAGE_ID }, { id: "178499999", username: "fixture" }, 4],
    ["missing Instagram username", directPage, { id: PAGE_ID }, { id: IG_ID }, 4],
    ["invalid Instagram response", directPage, { id: PAGE_ID }, [], 4],
  ])("rejects %s without exposing credentials", async (_label, page, owner, instagram, calls) => {
    prepareProof(page, owner, instagram);
    const error = await facebookClient().forFacebookPage(PAGE_ID, fallbackOptions).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(httpMock).toHaveBeenCalledTimes(calls as number);
    expect(String(error)).not.toContain(PAGE_TOKEN);
    expect(String(error)).not.toContain(USER_TOKEN);
  });

  it.each(["api", "transport", "invalid-list"])("never falls back after a %s list failure", async (failure) => {
    if (failure === "transport") httpMock.mockRejectedValueOnce(new Error(`offline ${USER_TOKEN}`));
    else httpMock.mockResolvedValueOnce(failure === "api" ? metaErrorResponse(`denied ${USER_TOKEN}`) : jsonHttpResponse({ data: null }));
    await expect(facebookClient().forFacebookPage(PAGE_ID, fallbackOptions)).rejects.toBeInstanceOf(Error);
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it.each(["", "not-a-page-id", "../me", "123?fields=access_token"])("does not probe an unbound or nonnumeric Page ID %s", async (pageId) => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] }));
    await expect(facebookClient().forFacebookPage(pageId, fallbackOptions)).rejects.toBeInstanceOf(Error);
    expect(httpMock.mock.calls.every(([url]) => url.pathname === "/v25.0/me/accounts")).toBe(true);
  });

  it("keeps the existing listed-Page path unchanged even with the OAuth opt-in", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [{ ...directPage, tasks: ["ANALYZE"] }] }));
    await expect(facebookClient().forFacebookPage(PAGE_ID, fallbackOptions)).resolves.toMatchObject({ pageId: PAGE_ID, instagramUserId: IG_ID, tasks: ["ANALYZE"] });
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when discovery found the exact Page but its token is missing", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [{ id: PAGE_ID }] }));
    await expect(facebookClient().forFacebookPage(PAGE_ID, fallbackOptions)).rejects.toThrow("no usable Page access token");
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("redacts the private Page token from an ownership proof API failure", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] }))
      .mockResolvedValueOnce(jsonHttpResponse(directPage))
      .mockResolvedValueOnce(metaErrorResponse(`denied ${PAGE_TOKEN}`));
    const error = await facebookClient().forFacebookPage(PAGE_ID, fallbackOptions).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(error)).not.toContain(PAGE_TOKEN);
    expect(httpMock).toHaveBeenCalledTimes(3);
  });

  it("passes the read signal to each proof request and stops when aborted", async () => {
    const controller = new AbortController();
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] })).mockImplementationOnce(async () => {
      controller.abort(new Error("fixture-stop"));
      return jsonHttpResponse(directPage);
    });
    await expect(facebookClient().forFacebookPage(PAGE_ID, { ...fallbackOptions, signal: controller.signal })).rejects.toThrow("fixture-stop");
    expect(httpMock).toHaveBeenCalledTimes(2);
    expect(httpMock.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
  });

  it("retains the final OAuth expected Instagram check after all known-Page proofs succeed", async () => {
    prepareProof();
    await expect(verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" },
      { accessToken: USER_TOKEN, authMode: "facebook" }, { expectedPageId: PAGE_ID, expectedAccountId: "178499999" }, undefined, { allowKnownPageFallback: true }))
      .rejects.toThrow("OAUTH_IDENTITY_MISMATCH");
    expect(httpMock).toHaveBeenCalledTimes(4);
  });

  it("accepts the known Page for OAuth only after complete private proof and the expected Instagram match", async () => {
    prepareProof();
    await expect(verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" },
      { accessToken: USER_TOKEN, authMode: "facebook" }, { expectedPageId: PAGE_ID, expectedAccountId: IG_ID }, undefined, { allowKnownPageFallback: true }))
      .resolves.toEqual({ pageId: PAGE_ID, userId: IG_ID });
    expect(httpMock).toHaveBeenCalledTimes(4);
  });

  it("does not use a direct Page probe for OAuth without an expected Page binding", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] }));
    await expect(verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" }, { accessToken: USER_TOKEN, authMode: "facebook" }))
      .rejects.toThrow("OAUTH_IDENTITY_AMBIGUOUS");
    expect(httpMock).toHaveBeenCalledTimes(1);
    expect(httpMock.mock.calls[0][0].pathname).toBe("/v25.0/me/accounts");
  });

  it("leaves an unavailable Page optional for ordinary AccountContext reads with no new direct probe", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [] }));
    const resolve = createAccountContextResolver({
      config: { authMode: "facebook", graphApiVersion: "v25.0", tokenStorePath: "/tmp/unused-token.json", publishLogPath: "/tmp/unused-publish.jsonl" },
      tokenStore: { load: async () => ({ accessToken: USER_TOKEN, authMode: "facebook", pageId: PAGE_ID, userId: IG_ID, permissions: ["instagram_basic"] }) },
    });
    const context = await resolve();
    expect(context).toMatchObject({ instagramUserId: IG_ID, pageResolutionStatus: "unavailable", confirmedScopes: ["instagram_basic"] });
    expect(context.pageClient).toBeUndefined();
    expect(httpMock).toHaveBeenCalledTimes(1);
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ id: IG_ID, username: "fixture" }));
    expect(await context.userClient.get(`/${IG_ID}`, { fields: ["id", "username"] })).toEqual({ id: IG_ID, username: "fixture" });
  });
});
