import { describe, expect, it } from "vitest";
import { parseCallbackRequest, renderCallbackHtml } from "../src/callback-server.js";

describe("callback server helpers", () => {
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
        userId: "ig-user",
      },
    });

    expect(html).toContain("Instagram token saved");
    expect(html).toContain("samp...oken");
    expect(html).not.toContain("sample-super-secret-token");
  });
});
