import { describe, expect, it } from "vitest";
import { buildAuthUrl, defaultScopesForAuthMode, getScopePresets } from "../src/oauth.js";

describe("buildAuthUrl", () => {
  it("builds the Instagram Login authorization URL", () => {
    const url = buildAuthUrl({
      authMode: "instagram",
      appId: "123",
      redirectUri: "http://localhost:8787/callback",
      scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      forceReauth: true
    });

    expect(url.origin).toBe("https://www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_insights");
    expect(url.searchParams.get("force_reauth")).toBe("true");
  });

  it("builds the Facebook Login URL on the configured Graph version", () => {
    const url = buildAuthUrl({
      authMode: "facebook",
      appId: "123",
      redirectUri: "http://localhost:8787/callback",
      scopes: ["instagram_basic", "pages_show_list"],
      forceReauth: true,
      graphApiVersion: "v25.0"
    });

    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v25.0/dialog/oauth");
    expect(url.searchParams.get("scope")).toBe("instagram_basic,pages_show_list");
    expect(url.searchParams.get("auth_type")).toBe("rerequest");
    expect(url.searchParams.has("force_reauth")).toBe(false);
  });

  it("adds enable_fb_login only for Instagram Login and only when configured", () => {
    const base = { appId: "123", redirectUri: "http://localhost:8787/callback", scopes: ["instagram_business_basic"] };

    expect(buildAuthUrl({ ...base, authMode: "instagram" }).searchParams.has("enable_fb_login")).toBe(false);
    expect(
      buildAuthUrl({ ...base, authMode: "instagram", enableFacebookLogin: false }).searchParams.get("enable_fb_login")
    ).toBe("0");
    expect(
      buildAuthUrl({ ...base, authMode: "facebook", enableFacebookLogin: true }).searchParams.has("enable_fb_login")
    ).toBe(false);
  });
});

describe("scope presets", () => {
  it("defaults to the analytics preset of the active auth mode", () => {
    expect(defaultScopesForAuthMode("instagram")).toEqual(getScopePresets("instagram").analytics);
    expect(defaultScopesForAuthMode("facebook")).toEqual(getScopePresets("facebook").analytics);
  });

  it("keeps the read-only preset free of publishing and messaging scopes", () => {
    for (const mode of ["instagram", "facebook"] as const) {
      const readOnly = getScopePresets(mode).readOnly.join(" ");
      expect(readOnly).not.toContain("content_publish");
      expect(readOnly).not.toContain("manage_messages");
    }
  });
});
