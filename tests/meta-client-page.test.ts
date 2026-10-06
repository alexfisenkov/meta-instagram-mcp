import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));

import { requestJsonHttp } from "../src/http-json.js";
import { MetaClient } from "../src/meta-client.js";
import { jsonHttpResponse } from "./helpers/json-http.js";

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
