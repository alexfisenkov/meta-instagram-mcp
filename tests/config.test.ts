import { describe, expect, it } from "vitest";
import { loadConfig, redactToken } from "../src/config.js";

describe("config", () => {
  it("loads defaults without exposing secrets", () => {
    const config = loadConfig({
      META_INSTAGRAM_APP_ID: "123",
      META_INSTAGRAM_APP_SECRET: "secret",
      META_INSTAGRAM_REDIRECT_URI: "http://localhost:8787/callback",
      META_INSTAGRAM_SCOPES: "instagram_business_basic, instagram_business_manage_insights",
      HOME: "/tmp/home",
    });

    expect(config.authMode).toBe("instagram");
    expect(config.appId).toBe("123");
    expect(config.appSecret).toBe("secret");
    expect(config.redirectUri).toBe("http://localhost:8787/callback");
    expect(config.defaultScopes).toEqual(["instagram_business_basic", "instagram_business_manage_insights"]);
    expect(config.graphApiVersion).toBe("v25.0");
    expect(config.tokenStorePath).toBe("/tmp/home/.config/meta-instagram-mcp/token.json");
  });

  it("supports the Facebook Login auth mode and connected page id", () => {
    const config = loadConfig({
      META_AUTH_MODE: "facebook",
      META_FACEBOOK_PAGE_ID: "page-123",
      HOME: "/tmp/home",
    });

    expect(config.authMode).toBe("facebook");
    expect(config.pageId).toBe("page-123");
  });

  it("redacts tokens instead of returning raw credentials", () => {
    expect(redactToken("sample-long-token-value")).toBe("samp...alue");
    expect(redactToken("short")).toBe("[redacted]");
    expect(redactToken(undefined)).toBe(undefined);
  });
});
