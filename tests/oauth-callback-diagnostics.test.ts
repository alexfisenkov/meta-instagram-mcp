import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createOAuthStateStore } from "../src/oauth-state.js";
import { createOAuthCallbackHandler, createOAuthCallbackService, renderCallbackHtml } from "../src/callback-server.js";
import { MetaApiError, MetaTransportError } from "../src/meta-client.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function stateStore() {
  const directory = await mkdtemp(join(tmpdir(), "oauth-diagnostics-"));
  directories.push(directory);
  return createOAuthStateStore({ directory });
}

describe("safe OAuth callback failure diagnostics", () => {
  it.each(["state", "exchange", "identity", "commit"] as const)("reports only controlled values for a %s failure, with identical public HTML", async (phase) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const canaries = ["example-canary-token", "canary-code", "canary-state", "canary-binding", "canary-user", "canary-page", "canary-error-name", "canary-private-path"];
    const error = new Error(canaries.join(" "));
    error.name = "canary-error-name";
    const binding = { accountBinding: "canary-binding", authMode: "facebook" as const,
      redirectUri: "https://mcp.example/oauth/callback", expectedAccountId: "canary-user", expectedPageId: "canary-page", requiredScopes: ["fixture_scope"] };
    let saved = false;
    const service = createOAuthCallbackService({
      stateStore: await stateStore(), binding,
      exchangeCode: async () => { if (phase === "exchange") throw error; return { accessToken: "example-canary-token", authMode: "facebook" }; },
      verifyAccount: async () => { if (phase === "identity") throw error; return { userId: "canary-user", pageId: "canary-page" }; },
      readGrantedPermissions: async () => ["fixture_scope"],
      commitToken: async () => { if (phase === "commit") throw error; saved = true; },
    });
    const state = await service.issueState();
    const url = `${binding.redirectUri}?code=canary-code&state=${phase === "state" ? "canary-state" : state}`;
    let html = "";
    let status = 0;
    const response = { writeHead: (value: number) => { status = value; }, end: (value: string) => { html = value; } } as unknown as ServerResponse;
    await createOAuthCallbackHandler(service, binding.redirectUri)({ method: "GET", url } as IncomingMessage, response);

    expect(status).toBe(400);
    expect(saved).toBe(false);
    expect(stderr.mock.calls).toHaveLength(1);
    const logged = stderr.mock.calls[0]![0] as string;
    expect(JSON.parse(logged)).toEqual({ event: "oauth_callback_failed", phase,
      reason: phase === "state" ? "state_rejected" : "operation_failed", ...(phase === "state" ? {} : { errorClass: "Error" }) });
    expect(html).toBe(renderCallbackHtml({ type: "error", title: "Authorization failed. Close this page and restart the authorization flow.", details: {} }));
    for (const value of [...canaries, state, url]) {
      expect(logged).not.toContain(value);
      expect(html).not.toContain(value);
    }
  });

  it.each([
    [new MetaApiError("canary-api-secret", 400, "canary-provider-code"), "MetaApiError"],
    [new MetaTransportError("canary-transport-secret"), "MetaTransportError"],
    [new TypeError("canary-type-secret"), "TypeError"],
    [{ name: "canary-name", message: "canary-object-secret", code: "canary-code" }, "Unknown"],
  ])("keeps exception metadata opaque for controlled class %s", async (error, errorClass) => {
    const onFailure = vi.fn();
    const binding = { accountBinding: "fixture", authMode: "instagram" as const, redirectUri: "https://mcp.example/oauth/callback" };
    const service = createOAuthCallbackService({
      stateStore: await stateStore(), binding, onFailure,
      exchangeCode: async () => { throw error; }, verifyAccount: async () => ({ userId: "fixture-user" }),
    });
    const state = await service.issueState();
    await service.handleCallback({ url: `${binding.redirectUri}?code=fixture-code&state=${state}` });
    expect(onFailure.mock.calls).toEqual([[{ event: "oauth_callback_failed", phase: "exchange", reason: "operation_failed", errorClass }]]);
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("canary");
  });

  it("reports current-token identity preflight failure before exchanging the code", async () => {
    const onFailure = vi.fn();
    let exchanged = false;
    const binding = { accountBinding: "fixture", authMode: "facebook" as const, redirectUri: "https://mcp.example/oauth/callback" };
    const service = createOAuthCallbackService({
      stateStore: await stateStore(), binding, onFailure,
      readCurrentToken: async () => ({ accessToken: "example-canary-old-token" }),
      exchangeCode: async () => { exchanged = true; return { accessToken: "example-canary-next-token", authMode: "facebook" }; },
      verifyAccount: async () => { throw new Error("OAUTH_IDENTITY_UNVERIFIED"); },
    });
    const state = await service.issueState();
    await service.handleCallback({ url: `${binding.redirectUri}?code=fixture-code&state=${state}` });
    expect(onFailure.mock.calls).toEqual([[{ event: "oauth_callback_failed", phase: "identity", reason: "identity_unverified", errorClass: "Error" }]]);
    expect(exchanged).toBe(false);
  });

  it("reports a current-token read rejection as identity after consuming valid state", async () => {
    const onFailure = vi.fn();
    let exchanged = false;
    const store = await stateStore();
    const binding = { accountBinding: "fixture", authMode: "facebook" as const, redirectUri: "https://mcp.example/oauth/callback" };
    const service = createOAuthCallbackService({
      stateStore: store, binding, onFailure,
      readCurrentToken: async () => { throw new Error("canary-read-secret"); },
      exchangeCode: async () => { exchanged = true; return { accessToken: "example-fixture-token", authMode: "facebook" }; },
      verifyAccount: async () => ({ userId: "fixture-user" }),
    });
    const state = await store.issue(binding);
    const result = await service.handleCallback({ url: `${binding.redirectUri}?code=fixture-code&state=${state}` });
    expect(result).toEqual({ status: "failed", message: "Authorization failed. Close this page and restart the authorization flow." });
    expect(onFailure.mock.calls).toEqual([[{ event: "oauth_callback_failed", phase: "identity", reason: "operation_failed", errorClass: "Error" }]]);
    expect(exchanged).toBe(false);
  });

  it("classifies the unavailable expected Page without exposing the exception", async () => {
    const onFailure = vi.fn();
    let saved = false;
    const binding = { accountBinding: "fixture", authMode: "facebook" as const, redirectUri: "https://mcp.example/oauth/callback", expectedPageId: "fixture-page" };
    const service = createOAuthCallbackService({
      stateStore: await stateStore(), binding, onFailure,
      exchangeCode: async () => ({ accessToken: "example-fixture-token", authMode: "facebook" }),
      verifyAccount: async () => { throw new Error("The requested Facebook Page was not found in the available Pages."); },
      commitToken: async () => { saved = true; },
    });
    const state = await service.issueState();
    await expect(service.handleCallback({ url: `${binding.redirectUri}?code=fixture-code&state=${state}` })).resolves.toMatchObject({ status: "failed" });
    expect(onFailure.mock.calls).toEqual([[{ event: "oauth_callback_failed", phase: "identity", reason: "page_unavailable", errorClass: "Error" }]]);
    expect(saved).toBe(false);
  });

  it("keeps a logging-hook exception from changing the public failure", async () => {
    const binding = { accountBinding: "fixture", authMode: "instagram" as const, redirectUri: "https://mcp.example/oauth/callback" };
    const service = createOAuthCallbackService({
      stateStore: await stateStore(), binding,
      onFailure: () => { throw new Error("canary-hook-secret"); },
      exchangeCode: async () => { throw new Error("canary-exchange-secret"); },
      verifyAccount: async () => ({ userId: "fixture-user" }),
    });
    const state = await service.issueState();
    await expect(service.handleCallback({ url: `${binding.redirectUri}?code=fixture-code&state=${state}` })).resolves.toEqual({
      status: "failed", message: "Authorization failed. Close this page and restart the authorization flow.",
    });
  });

  it.each(["promise", "thenable"])("contains an async %s hook rejection without global unhandled rejection or secret output", async (mode) => {
    // Use a separate Node process so an unhandled-rejection regression cannot escape into Vitest.
    const directory = await mkdtemp(join(tmpdir(), "oauth-hook-child-"));
    directories.push(directory);
    const script = `
      import { createOAuthCallbackService } from ${JSON.stringify(new URL("../src/callback-server.ts", import.meta.url).href)};
      import { createOAuthStateStore } from ${JSON.stringify(new URL("../src/oauth-state.ts", import.meta.url).href)};
      let unhandled = 0;
      process.on("unhandledRejection", () => { unhandled += 1; });
      const binding = { accountBinding: "fixture", authMode: "instagram", redirectUri: "https://mcp.example/oauth/callback" };
      const service = createOAuthCallbackService({
        stateStore: createOAuthStateStore({ directory: ${JSON.stringify(directory)} }), binding,
        onFailure: () => ${JSON.stringify(mode)} === "promise"
          ? Promise.reject(new Error("canary-async-hook-secret"))
          : { then: (_resolve, reject) => reject(new Error("canary-async-hook-secret")) },
        exchangeCode: async () => { throw new Error("canary-exchange-secret"); },
        verifyAccount: async () => ({ userId: "fixture-user" }),
      });
      const state = await service.issueState();
      const result = await service.handleCallback({ url: binding.redirectUri + "?code=fixture-code&state=" + state });
      await new Promise((resolve) => setTimeout(resolve, 30));
      process.stdout.write(JSON.stringify({ result, unhandled }));
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { timeout: 5000 });
    expect(JSON.parse(stdout)).toEqual({ result: { status: "failed", message: "Authorization failed. Close this page and restart the authorization flow." }, unhandled: 0 });
    expect(stderr).toBe("");
    expect(stdout).not.toContain("canary");
  });
});
