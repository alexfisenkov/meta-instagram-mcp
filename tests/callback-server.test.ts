import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuthStateStore } from "../src/oauth-state.js";
import { createOAuthCallbackService, launchOAuthAuthorization, parseCallbackRequest, renderCallbackHtml } from "../src/callback-server.js";

describe("callback server helpers", () => {
  it("opens authorization without writing the URL or one-time state to stdout", async () => {
    const nonce = "synthetic-callback-nonce-7f3c";
    const loginUrl = `https://www.facebook.com/dialog/oauth?client_id=fake&state=${nonce}`;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const openBrowser = vi.fn(async (_url: string) => undefined);
    try {
      await launchOAuthAuthorization(loginUrl, openBrowser);
      expect(openBrowser).toHaveBeenCalledWith(loginUrl);
      const stdout = output.mock.calls.flat().join(" ");
      expect(stdout).not.toContain(nonce);
      expect(stdout).not.toContain(loginUrl);
    } finally { output.mockRestore(); }
  });

  it("keeps one-time state out of output and errors when browser launch fails", async () => {
    const nonce = "synthetic-callback-nonce-failure-91ac";
    const loginUrl = `https://www.facebook.com/dialog/oauth?client_id=fake&state=${nonce}`;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(launchOAuthAuthorization(loginUrl, async () => { throw new Error(`failed for ${loginUrl}`); }))
        .rejects.toThrow("desktop session with a browser available");
      const stdout = output.mock.calls.flat().join(" ");
      expect(stdout).not.toContain(nonce);
      expect(stdout).not.toContain(loginUrl);
    } finally { output.mockRestore(); }
  });

  it("extracts an authorization code from the configured callback path", () => {
    const result = parseCallbackRequest(
      "http://localhost:8787/callback?code=AQBx-code",
      "/callback",
    );

    expect(result).toEqual({ type: "code", code: "AQBx-code" });
  });

  it("preserves Meta authorization errors without treating them as tokens", () => {
    const result = parseCallbackRequest(
      "http://localhost:8787/callback?error=access_denied&error_reason=user_denied&error_description=The+user+denied+your+request",
      "/callback",
    );

    expect(result).toEqual({
      type: "error",
      error: "access_denied",
      reason: "user_denied",
      description: "The user denied your request",
    });
  });

  it("ignores unrelated paths", () => {
    const result = parseCallbackRequest("http://localhost:8787/health", "/callback");

    expect(result).toEqual({ type: "ignored" });
  });

  it("renders a success page with redacted token metadata", () => {
    const html = renderCallbackHtml({
      type: "success",
      title: "Instagram token saved",
      details: {
        accessToken: "sample-super-secret-token",
        code: "fake-code-value",
        state: "fake-state-value",
        appSecret: "fake-app-secret",
        userId: "ig-user",
      },
    });

    expect(html).toContain("Instagram token saved");
    expect(html).toContain("[redacted]");
    expect(html).not.toContain("sample-super-secret-token");
    expect(html).not.toContain("fake-code-value");
    expect(html).not.toContain("fake-state-value");
    expect(html).not.toContain("fake-app-secret");
  });

  it("consumes state before exchange and never returns code, token, or provider identifiers", async () => {
    const stateStore = createOAuthStateStore({ directory: await mkdtemp(join(tmpdir(), "oauth-callback-")) });
    const binding = { accountBinding: "operator-session", authMode: "instagram" as const, redirectUri: "https://mcp.example/oauth/callback" };
    const exchangeCode = vi.fn(async () => ({ accessToken: "secret-access-token", authMode: "instagram" as const, userId: "private-user-id", permissions: ["scope"] }));
    const saveToken = vi.fn(async () => undefined);
    const service = createOAuthCallbackService({ stateStore, binding, exchangeCode, saveToken });
    const state = await service.issueState();

    const result = await service.handleCallback({ url: `${binding.redirectUri}?code=secret-code&state=${state}` });

    expect(result).toEqual({ status: "success", message: "Authorization complete." });
    expect(exchangeCode).toHaveBeenCalledWith("secret-code");
    expect(saveToken).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "secret-access-token" }));
    expect(JSON.stringify(result)).not.toMatch(/secret-code|secret-access-token|private-user-id/);
    await service.handleCallback({ url: `${binding.redirectUri}?code=secret-code&state=${state}` });
    expect(exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect mismatch before code exchange", async () => {
    const stateStore = createOAuthStateStore({ directory: await mkdtemp(join(tmpdir(), "oauth-callback-")) });
    const binding = { accountBinding: "operator-session", authMode: "instagram" as const, redirectUri: "https://mcp.example/oauth/callback" };
    const exchangeCode = vi.fn(async () => ({ accessToken: "secret", authMode: "instagram" as const }));
    const service = createOAuthCallbackService({ stateStore, binding, exchangeCode, saveToken: async () => undefined });
    const state = await service.issueState();

    await service.handleCallback({ url: `https://evil.example/oauth/callback?code=secret-code&state=${state}` });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("backs up the existing token and refuses to replace a different linked account", async () => {
    const stateStore = createOAuthStateStore({ directory: await mkdtemp(join(tmpdir(), "oauth-callback-")) });
    const binding = { accountBinding: "operator-session", authMode: "instagram" as const, redirectUri: "https://mcp.example/oauth/callback", expectedAccountId: "owner-1" };
    const backupToken = vi.fn(async () => undefined);
    const saveToken = vi.fn(async () => undefined);
    const service = createOAuthCallbackService({
      stateStore, binding, readCurrentToken: async () => ({ accessToken: "old" }), backupToken, saveToken,
      exchangeCode: async () => ({ accessToken: "new", authMode: "instagram", userId: "owner-2" }),
    });
    const state = await service.issueState();

    await service.handleCallback({ url: `${binding.redirectUri}?code=fake-code&state=${state}` });
    expect(backupToken).not.toHaveBeenCalled();
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("completes a private token backup before replacing the linked account token", async () => {
    const stateStore = createOAuthStateStore({ directory: await mkdtemp(join(tmpdir(), "oauth-callback-")) });
    const binding = { accountBinding: "operator-session", authMode: "instagram" as const, redirectUri: "https://mcp.example/oauth/callback", expectedAccountId: "owner-1" };
    const order: string[] = [];
    const service = createOAuthCallbackService({
      stateStore, binding,
      readCurrentToken: async () => ({ accessToken: "old-private-token", authMode: "instagram", userId: "owner-1" }),
      backupToken: async () => { order.push("backup"); },
      exchangeCode: async () => ({ accessToken: "new-private-token", authMode: "instagram", userId: "owner-1" }),
      saveToken: async () => { order.push("save"); },
    });
    const state = await service.issueState();

    await expect(service.handleCallback({ url: `${binding.redirectUri}?code=fake-code&state=${state}` }))
      .resolves.toMatchObject({ status: "success" });
    expect(order).toEqual(["backup", "save"]);
  });
});
