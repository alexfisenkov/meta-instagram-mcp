import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));

import { requestJsonHttp } from "../src/http-json.js";
import { MetaClient } from "../src/meta-client.js";
import { jsonHttpResponse, metaErrorResponse } from "./helpers/json-http.js";

const httpMock = vi.mocked(requestJsonHttp);

function client(): MetaClient {
  return new MetaClient({ accessToken: "real-token", apiVersion: "v25.0", baseUrl: "https://graph.instagram.com" });
}

/**
 * meta_raw_get прокидывает в `get` недоверенные `path` и `query` от MCP-клиента
 * (src/tools.ts: rawGet). Гарантия каждой проверки ниже — исключение бросается
 * ДО сетевого вызова, поэтому в сеть не уходит ни запрос, ни наш access_token.
 */
describe("MetaClient rejects reserved query keys", () => {
  beforeEach(() => {
    httpMock.mockReset();
  });

  it.each(["method", "_method", "access_token"])("rejects %s smuggled through the query object", async (key) => {
    await expect(client().get("/me", { query: { [key]: "delete" } })).rejects.toThrow(/Reserved query key/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("rejects a reserved key passed as a top-level param", async () => {
    await expect(client().get("/me", { method: "delete" })).rejects.toThrow(/Reserved query key/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it.each(["/me?method=delete", "/me?_method=post", "/me?access_token=attacker-token"])(
    "rejects a reserved key baked into the path %s",
    async (path) => {
      await expect(client().get(path)).rejects.toThrow(/Reserved query key/);
      expect(httpMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["tab", "method\t"],
    ["leading space", " access_token"],
    ["inner space", "met hod"],
    ["zero-width space", "​_method"],
    ["byte order mark", "﻿method"],
    ["fullwidth unicode twin", "ｍｅｔｈｏｄ"]
  ])("rejects a reserved key disguised with %s", async (_label, key) => {
    await expect(client().get("/me", { query: { [key]: "delete" } })).rejects.toThrow(/Reserved query key/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("keeps the client access token when a query tries to override it", async () => {
    await expect(client().get("/me", { query: { access_token: "attacker-token" } })).rejects.toThrow(
      /Reserved query key/
    );
    expect(httpMock).not.toHaveBeenCalled();
  });
});

describe("MetaClient host allow-list for absolute paths", () => {
  beforeEach(() => {
    httpMock.mockReset();
  });

  it.each(["https://example.com/steal", "http://attacker.example/collect", "https://graph.facebook.com.evil.test/me"])(
    "rejects the foreign host %s before any request is sent",
    async (path) => {
      await expect(client().get(path)).rejects.toThrow(/is not a Meta Graph host/);
      expect(httpMock).not.toHaveBeenCalled();
    }
  );

  it.each(["https://graph.facebook.com/v25.0/me", "https://graph.instagram.com/v25.0/me"])(
    "allows the Meta Graph host %s",
    async (path) => {
      httpMock.mockResolvedValueOnce(jsonHttpResponse({ id: "1" }));

      await client().get(path);

      expect(httpMock.mock.calls[0][0].href).toBe(`${path}?access_token=real-token`);
    }
  );

  it.each(["ftp://graph.instagram.com/me", "http://graph.instagram.com/me"])(
    "rejects non-HTTPS absolute URL %s before sending credentials",
    async (path) => {
      await expect(client().get(path)).rejects.toThrow(/HTTPS/);
      expect(httpMock).not.toHaveBeenCalled();
    }
  );

  it("rejects file URLs before any request is sent", async () => {
    await expect(client().get("file:///etc/passwd")).rejects.toThrow();
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("rejects scheme-relative hosts instead of treating them as Graph-relative paths", async () => {
    await expect(client().get("//evil.example/steal")).rejects.toThrow(/not a Meta Graph host/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("matches the host allow-list case-insensitively", async () => {
    await expect(client().get("HTTPS://Evil.Example/steal")).rejects.toThrow(/is not a Meta Graph host/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("passes a legitimate read-only GET through untouched", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ data: [{ id: "1", caption: "hi" }] }));

    const result = await client().get("/me/media", { fields: ["id", "caption"], limit: 10 });

    expect(result).toEqual({ data: [{ id: "1", caption: "hi" }] });
    expect(httpMock.mock.calls[0][0].href).toBe(
      "https://graph.instagram.com/v25.0/me/media?fields=id%2Ccaption&limit=10&access_token=real-token"
    );
  });
});

/**
 * Meta периодически возвращает присланный access_token эхом внутри error.message.
 * Первая публичная версия его вычищала, рефакторинг транспорта очистку потерял —
 * этот тест не даёт регрессии вернуться: секрет не должен доехать до текста
 * исключения, а оттуда в ответ MCP-инструмента и в логи вызывающей стороны.
 */
describe("MetaClient redacts the access token in error messages", () => {
  beforeEach(() => {
    httpMock.mockReset();
  });

  it("replaces an echoed token with a placeholder", async () => {
    const token = "FAKE_OAUTH_TOKEN_6f31";
    httpMock.mockResolvedValue(
      metaErrorResponse(`Invalid OAuth access token ${token} for this app`)
    );
    const leaky = new MetaClient({
      accessToken: token,
      apiVersion: "v25.0",
      baseUrl: "https://graph.facebook.com"
    });

    let message = "";
    try {
      await leaky.get("/me", {});
      throw new Error("expected the Meta error to be rethrown");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(token);
    expect(message).toContain("[redacted-token]");
  });

  it("removes secret assignments and secret query values from an API error", async () => {
    httpMock.mockResolvedValueOnce(metaErrorResponse(
      "failed client_secret=FAKE_ERROR_SECRET; Authorization: Bearer FAKE_BEARER_SECRET; see https://graph.facebook.com/v25.0/me?access_token=FAKE_QUERY_SECRET"
    ));
    const error = await client().get("/me").catch((value: unknown) => value);
    const message = (error as Error).message;
    expect(message).not.toContain("FAKE_ERROR_SECRET");
    expect(message).not.toContain("FAKE_BEARER_SECRET");
    expect(message).not.toContain("FAKE_QUERY_SECRET");
    expect(message).toContain("[redacted-secret]");
  });
});

/**
 * POST — единственный записывающий путь клиента (публикация, история 29а).
 * Защиты у него те же, что у GET, и это не самоочевидно: guard'ы писались
 * под read-only и легко было оставить их только там, где они уже стояли.
 */
describe("MetaClient POST keeps the read-path guards", () => {
  beforeEach(() => {
    httpMock.mockReset();
  });

  it.each(["method", "_method", "access_token"])("rejects %s smuggled through the body", async (key) => {
    await expect(client().post("/ig/media", { [key]: "delete" })).rejects.toThrow(/Reserved query key/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("rejects a reserved key baked into the path", async () => {
    await expect(client().post("/ig/media?access_token=attacker-token")).rejects.toThrow(/Reserved query key/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("refuses to POST to a foreign host", async () => {
    await expect(client().post("https://attacker.example/collect", { image_url: "https://e/x.jpg" }))
      .rejects.toThrow(/is not a Meta Graph host/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("sends parameters in the body and keeps the token out of the URL", async () => {
    httpMock.mockResolvedValueOnce(jsonHttpResponse({ id: "container-1" }));

    const result = await client().post("/ig/media", { image_url: "https://example.com/a.jpg", caption: "hi" });

    expect(result).toEqual({ id: "container-1" });
    const [url, init] = httpMock.mock.calls[0];
    expect(url.href).toBe("https://graph.instagram.com/v25.0/ig/media");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toBe(
      "image_url=https%3A%2F%2Fexample.com%2Fa.jpg&caption=hi&access_token=real-token"
    );
  });

  it("redacts the token echoed back in a POST error", async () => {
    httpMock.mockResolvedValueOnce(metaErrorResponse("Invalid OAuth access token real-token for this app"));

    await expect(client().post("/ig/media_publish", { creation_id: "c-1" }))
      .rejects.toThrow(/\[redacted-token\]/);
  });
});

describe("MetaClient validates its configured base URL before attaching a token", () => {
  beforeEach(() => httpMock.mockReset());

  it.each([
    "http://graph.facebook.com",
    "https://graph.facebook.com:8443",
    "https://user:pass@graph.facebook.com",
    "https://graph.facebook.com/?access_token=other",
    "https://graph.facebook.com/v25.0"
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => new MetaClient({ accessToken: "FAKE_BASE_TOKEN", apiVersion: "v25.0", baseUrl })).toThrow();
    expect(httpMock).not.toHaveBeenCalled();
  });
});

describe("MetaClient sanitizes successful Graph responses recursively", () => {
  beforeEach(() => httpMock.mockReset());

  it("redacts secret fields and token echoes in nested arrays and paging URLs while preserving useful data", async () => {
    const token = "FAKE_nested_token_6d2b";
    httpMock.mockResolvedValueOnce(jsonHttpResponse({
      id: "safe-id",
      caption: "ordinary text including tokenization",
      access_token: token,
      profile: { accessToken: token, app_secret: "FAKE_APP_SECRET", client_secret: "FAKE_CLIENT_SECRET", Authorization: "Bearer hidden" },
      data: [{ message: "keep this ordinary user text", count: 3 }, { note: `echo ${encodeURIComponent(token)}` }],
      paging: {
        next: `https://graph.facebook.com/v25.0/me?access_token=${encodeURIComponent(token)}&limit=4`,
        previous: "https://graph.facebook.com/v25.0/me?%61ccess_token=FAKE_FOREIGN_TOKEN&app_secret=FAKE_URL_SECRET",
        cursors: { after: "SAFE_CURSOR" }
      }
    }));

    const result = await new MetaClient({ accessToken: token, apiVersion: "v25.0", baseUrl: "https://graph.facebook.com" }).get("/me");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(encodeURIComponent(token));
    expect(result).toMatchObject({
      id: "safe-id",
      caption: "ordinary text including tokenization",
      access_token: "[redacted-secret]",
      profile: {
        accessToken: "[redacted-secret]",
        app_secret: "[redacted-secret]",
        client_secret: "[redacted-secret]",
        Authorization: "[redacted-secret]"
      },
      data: [{ message: "keep this ordinary user text", count: 3 }, { note: "echo [redacted-token]" }],
      paging: {
        next: expect.stringContaining("access_token=%5Bredacted-secret%5D"),
        previous: expect.not.stringContaining("FAKE_FOREIGN_TOKEN"),
        cursors: { after: "SAFE_CURSOR" }
      }
    });
  });

  it("sanitizes a rejected transport error before throwing", async () => {
    const token = "FAKE_transport_token_91ab";
    httpMock.mockRejectedValueOnce(new Error(`network failed for ${token} and ${encodeURIComponent(token)}`));
    const instance = new MetaClient({ accessToken: token, apiVersion: "v25.0", baseUrl: "https://graph.instagram.com" });
    const error = await instance.get("/me").catch((value: unknown) => value);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain("[redacted-token]");
  });
});

describe("MetaClient rejects reserved keys in form and JSON bodies", () => {
  beforeEach(() => httpMock.mockReset());

  it.each(["method", "_method", "access_token", "ＭＥＴＨＯＤ", "​access_token"])("rejects normalized JSON key %s", async (key) => {
    await expect(client().postJson("/me/messages", { message: { [key]: "value" } })).rejects.toThrow(/Reserved JSON key/);
    expect(httpMock).not.toHaveBeenCalled();
  });

  it("rejects a reserved legacy form key before calling the transport", async () => {
    await expect(client().post("/me/media", { "ｍｅｔｈｏｄ": "delete" })).rejects.toThrow(/Reserved query key/);
    expect(httpMock).not.toHaveBeenCalled();
  });
});
