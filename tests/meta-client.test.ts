import { describe, expect, it, vi } from "vitest";
import { MetaClient, MetaApiError } from "../src/meta-client.js";

describe("MetaClient", () => {
  it("adds version, access token, fields and pagination params to Graph requests", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "1" }] }), { status: 200 }));
    const client = new MetaClient({
      accessToken: "token",
      apiVersion: "v25.0",
      fetchImpl: fetchMock,
    });

    const result = await client.get("/me/media", {
      fields: ["id", "caption"],
      limit: 25,
    });

    expect(result).toEqual({ data: [{ id: "1" }] });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.href).toBe("https://graph.instagram.com/v25.0/me/media?fields=id%2Ccaption&limit=25&access_token=token");
  });

  it("rejects absolute raw paths", async () => {
    const client = new MetaClient({ accessToken: "token", apiVersion: "v25.0", fetchImpl: vi.fn() });

    await expect(client.get("https://example.com/steal")).rejects.toThrow("Meta path must be relative");
  });

  it("normalizes Meta API errors without exposing access tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        message: "Bad token token-secret",
        type: "OAuthException",
        code: 190,
      },
    }), { status: 400 }));
    const client = new MetaClient({
      accessToken: "token-secret",
      apiVersion: "v25.0",
      fetchImpl: fetchMock,
    });

    await client.get("/me").catch((error: MetaApiError) => {
      expect(error.name).toBe("MetaApiError");
      expect(error.status).toBe(400);
      expect(error.code).toBe(190);
      expect(error.message).not.toContain("token-secret");
    });
  });
});
