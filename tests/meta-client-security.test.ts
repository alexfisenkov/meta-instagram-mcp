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

  it.each(["//evil.example/steal", "file:///etc/passwd", "ftp://evil.example/steal"])(
    "keeps %s on the Graph host instead of following it",
    async (path) => {
      httpMock.mockResolvedValueOnce(jsonHttpResponse({ id: "1" }));

      await client().get(path);

      expect(httpMock.mock.calls[0][0].hostname).toBe("graph.instagram.com");
    }
  );

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
    const token = "EAA-super-secret-token-value";
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
});
