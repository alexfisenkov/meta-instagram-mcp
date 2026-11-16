import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolHandlers } from "../src/tools.js";
import { createAccountContextResolver } from "../src/account-context.js";
import { requestJsonHttp } from "../src/http-json.js";
import { jsonHttpResponse } from "./helpers/json-http.js";
import type { MetaInstagramConfig } from "../src/config.js";
import type { StoredInstagramToken } from "../src/token-store.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const cfg: MetaInstagramConfig = { authMode: "instagram", accessToken: "sample-dashboard-token", graphApiVersion: "v27.0", tokenStorePath: "/sample/token.json", publishLogPath: "/sample/log.jsonl" };

describe("direct Dashboard token path", () => {
  it("verifies a professional identity without app credentials and reuses only token-bound metadata for media", async () => {
    let saved: StoredInstagramToken | undefined;
    const config = { ...cfg };
    const save = vi.fn(async (value: StoredInstagramToken) => { saved = value; });
    vi.mocked(requestJsonHttp).mockImplementation(async (url) => url.pathname.endsWith("/me")
      ? jsonHttpResponse({ data: [{ user_id: "1784001", username: "sample_owner" }] }) : jsonHttpResponse({ data: [] }));
    const handlers = createToolHandlers({ config, tokenStore: { load: async () => saved, save } });
    expect(await handlers.resolveInstagramAccount()).toMatchObject({ authMode: "instagram", saved: true, permissionsVerification: "unknown", instagramBusinessAccount: { user_id: "1784001", username: "sample_owner" } });
    expect(saved).toMatchObject({ authMode: "instagram", userId: "1784001", username: "sample_owner" });
    expect(saved?.permissions).toBeUndefined();
    await handlers.getAccountInfo(); await handlers.listMedia({ limit: 2 });
    expect(vi.mocked(requestJsonHttp).mock.calls.some(([url]) => url.pathname === "/v27.0/1784001/media")).toBe(true);
    expect(vi.mocked(requestJsonHttp).mock.calls.every(([url]) => url.hostname === "graph.instagram.com")).toBe(true);
    const context = await createAccountContextResolver({ config, tokenStore: { load: async () => saved } })();
    expect(context.instagramUserId).toBe("1784001"); expect(context.scopeStatus).toBe("unknown");
    config.accessToken = "sample-replacement-token";
    expect(await handlers.listMedia()).toMatchObject({ data: [] });
    expect(vi.mocked(requestJsonHttp).mock.calls.at(-1)?.[0].pathname).toBe("/v27.0/me/media");
  });

  it("preserves an occupied token store before a new credential can replace it", async () => {
    const save = vi.fn();
    const handlers = createToolHandlers({ config: cfg, tokenStore: { load: async () => ({ authMode: "instagram", accessToken: "sample-old-token", userId: "1784001" }), save } });
    await expect(handlers.resolveInstagramAccount()).rejects.toThrow("TOKEN_STORE_NOT_EMPTY");
    expect(requestJsonHttp).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it("refuses a different professional ID or unproven app-scoped-only profile before saving", async () => {
    for (const body of [{ user_id: "1784002", username: "other" }, { id: "app-scoped", username: "sample_owner" }]) {
      vi.mocked(requestJsonHttp).mockResolvedValue(jsonHttpResponse(body));
      const save = vi.fn();
      const handlers = createToolHandlers({ config: { ...cfg, userId: "1784001" }, tokenStore: { load: async () => undefined, save } });
      await expect(handlers.resolveInstagramAccount()).rejects.toThrow(/OAUTH_IDENTITY_/);
      expect(save).not.toHaveBeenCalled();
    }
  });
});
