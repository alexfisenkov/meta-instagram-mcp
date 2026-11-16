import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolHandlers } from "../src/tools.js";
import { createMcpServer } from "../src/mcp-server.js";
import type { MetaInstagramConfig } from "../src/config.js";

const config: MetaInstagramConfig = { authMode: "instagram", graphApiVersion: "v27.0", tokenStorePath: "/sample/token.json", publishLogPath: "/sample/log.jsonl" };
function fixture(extra: Partial<MetaInstagramConfig> = {}, saved?: Record<string, unknown>) {
  const save = vi.fn();
  const handlers = createToolHandlers({ config: { ...config, ...extra }, tokenStore: { load: async () => saved, save }, clientFactory: () => { throw new Error("Planner must not access Meta"); } });
  return { handlers, save };
}

describe("student connection plan", () => {
  it("reuses existing AI-client browser control before asking for another extension setup", async () => {
    const { handlers } = fixture();
    expect((await handlers.connectionPlan({ preferredSource: "browser" })).nextStep).toBe("check_existing_browser");
    expect((await handlers.connectionPlan({ preferredSource: "browser", existingBrowserControl: "available" })).nextStep).toBe("use_existing_browser");
    expect((await handlers.connectionPlan({ preferredSource: "browser", existingBrowserControl: "unavailable" })).nextStep).toBe("configure_browser");
  });
  it("checks direct setup first and does not infer Dashboard availability from config", async () => {
    const { handlers, save } = fixture({ appId: "sample-app", appSecret: "sample-secret" });
    const plan = await handlers.connectionPlan();
    expect(plan).toMatchObject({ verification: "configuration_only", recommendedPath: "inspect_dashboard", nextStep: "check_instagram_login_setup", observationVerification: "caller_supplied" });
    expect(plan.routes.map((route) => route.id)).toEqual(["instagram_login", "browser", "unified_login", "facebook_login"]);
    expect(plan.routes[0]).toMatchObject({ dashboardAvailability: "unknown", requiresBusinessPortfolio: false });
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(plan)).not.toContain("sample-secret");
  });

  it("selects direct only after the caller reports the matching setup", async () => {
    expect(await fixture().handlers.connectionPlan({ directInstagramSetup: "available" })).toMatchObject({ recommendedPath: "instagram_login", nextStep: "configure_instagram_login" });
  });

  it("offers browser when direct is unavailable and Meta business access is blocked", async () => {
    const plan = await fixture({ authMode: "unified" }).handlers.connectionPlan({ directInstagramSetup: "unavailable", unifiedSetup: "available", businessPortfolio: "blocked" });
    expect(plan.recommendedPath).toBe("browser");
    expect(plan.routes[1]).toMatchObject({ requiresMetaApp: false, requiresBusinessPortfolio: false, setupGuide: "docs/browser-only.md" });
  });

  it("does not skip the direct check merely because a business request failed", async () => {
    expect((await fixture().handlers.connectionPlan({ businessPortfolio: "blocked" })).recommendedPath).toBe("inspect_dashboard");
  });

  it("keeps working connections and verifies existing credentials before replacing them", async () => {
    const { handlers } = fixture({ authMode: "unified", accessToken: "sample-existing-token" });
    expect((await handlers.connectionPlan()).recommendedPath).toBe("verify_existing");
    expect((await handlers.connectionPlan({ existingConnectionWorking: true })).recommendedPath).toBe("keep_existing");
    expect((await handlers.connectionPlan({ preferredSource: "browser" })).recommendedPath).toBe("browser");
    expect((await handlers.connectionPlan({ existingConnectionWorking: false, directInstagramSetup: "unavailable", businessPortfolio: "blocked" })).recommendedPath).toBe("browser");
  });

  it("does not mark a different saved login family as the selected connection", async () => {
    const plan = await fixture({}, { authMode: "unified", accessToken: "sample-stored-token" }).handlers.connectionPlan();
    expect(plan.recommendedPath).toBe("inspect_dashboard");
    expect(plan.issues).toContain("saved_credential_family_mismatch");
    expect(JSON.stringify(plan)).not.toContain("sample-stored-token");
  });

  it("names an occupied store before a new environment credential is imported", async () => {
    const plan = await fixture({ accessToken:"sample-new-token" }, { authMode:"instagram",accessToken:"sample-old-token" }).handlers.connectionPlan();
    expect(plan.recommendedPath).toBe("separate_token_store");
    expect(plan.issues).toContain("token_store_occupied_by_other_credential");
    expect(JSON.stringify(plan)).not.toMatch(/sample-new-token|sample-old-token/);
  });

  it("selects Unified only with its observed setup and available portfolio", async () => {
    const { handlers } = fixture();
    expect((await handlers.connectionPlan({ directInstagramSetup: "unavailable", unifiedSetup: "available", businessPortfolio: "unknown" })).recommendedPath).toBe("browser");
    expect((await handlers.connectionPlan({ directInstagramSetup: "unavailable", unifiedSetup: "available", businessPortfolio: "available" })).recommendedPath).toBe("unified_login");
  });

  it("exposes a read-only strict MCP tool and rejects unknown secret-bearing arguments", async () => {
    const server = createMcpServer(fixture().handlers);
    const client = new Client({ name: "sample-plan", version: "1" });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const tool = (await client.listTools()).tools.find((item) => item.name === "meta_connection_plan");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect((await client.listTools()).tools.find((item)=>item.name==="meta_resolve_instagram_account")?.annotations?.readOnlyHint).toBe(false);
      const result = await client.callTool({ name: "meta_connection_plan", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as Array<{text:string}>)[0].text)).toMatchObject({ recommendedPath: "inspect_dashboard" });
      const invalid = await client.callTool({ name: "meta_connection_plan", arguments: { accessToken: "sample-not-accepted" } });
      expect(invalid.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
