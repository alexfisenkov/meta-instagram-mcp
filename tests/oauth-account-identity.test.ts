import { describe, expect, it, vi } from "vitest";
import { verifyOAuthAccountIdentity, type OAuthIdentityClientFactory } from "../src/oauth-account-identity.js";
import type { OAuthToken } from "../src/oauth.js";

function clientFactory(client: { get: ReturnType<typeof vi.fn>; forFacebookPage: ReturnType<typeof vi.fn> }): OAuthIdentityClientFactory {
  return () => client as never;
}

describe("OAuth account identity verification", () => {
  it("uses only the Instagram OAuth response user_id and binds it to the expected account", async () => {
    const client = {
      get: vi.fn(),
      forFacebookPage: vi.fn(),
    };
    const token: OAuthToken = { accessToken: "fresh-token", authMode: "instagram", userId: "ig-account-1" };

    await expect(verifyOAuthAccountIdentity({ authMode: "instagram", graphApiVersion: "v25.0" }, token,
      { expectedAccountId: "ig-account-1" }, clientFactory(client)))
      .resolves.toEqual({ userId: "ig-account-1" });
    expect(client.get).not.toHaveBeenCalled();
    await expect(verifyOAuthAccountIdentity({ authMode: "instagram", graphApiVersion: "v25.0" }, token,
      { expectedAccountId: "ig-account-2" }, clientFactory(client)))
      .rejects.toThrow("OAUTH_IDENTITY_MISMATCH");
    await expect(verifyOAuthAccountIdentity({ authMode: "instagram", graphApiVersion: "v25.0" },
      { accessToken: "fresh-token", authMode: "instagram" }, {}, clientFactory(client)))
      .rejects.toThrow("OAUTH_IDENTITY_UNVERIFIED");
  });

  it("accepts a Facebook Login token only when the selected Page resolves to the expected Instagram account", async () => {
    const client = {
      get: vi.fn(),
      forFacebookPage: vi.fn(async () => ({ client: {}, pageId: "page-1", instagramUserId: "ig-account-1", tasks: [] })),
    };
    const token: OAuthToken = { accessToken: "fresh-token", authMode: "facebook", userId: "provider-user-id" };

    await expect(verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" }, token,
      { expectedAccountId: "ig-account-1", expectedPageId: "page-1" }, clientFactory(client)))
      .resolves.toEqual({ userId: "ig-account-1", pageId: "page-1" });
    expect(client.forFacebookPage).toHaveBeenCalledWith("page-1");
    expect(client.get).not.toHaveBeenCalled();

    await expect(verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" }, token,
      { expectedAccountId: "ig-account-2", expectedPageId: "page-1" }, clientFactory(client)))
      .rejects.toThrow("OAUTH_IDENTITY_MISMATCH");
  });

  it("does not treat Facebook provider user_id as an Instagram account ID", async () => {
    const client = {
      get: vi.fn(async () => ({ id: "ig-account-1", username: "creator" })),
      forFacebookPage: vi.fn(),
    };
    const token: OAuthToken = { accessToken: "fresh-token", authMode: "facebook", userId: "provider-user-id" };

    await expect(verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" }, token,
      { expectedAccountId: "ig-account-1" }, clientFactory(client)))
      .resolves.toEqual({ userId: "ig-account-1" });
    expect(client.get).toHaveBeenCalledWith("/ig-account-1", { fields: ["id", "username"] });
  });

  it("fails closed when a first Facebook authorization does not identify one Page account uniquely", async () => {
    const client = {
      get: vi.fn(async () => ({ data: [
        { id: "page-1", instagram_business_account: { id: "ig-account-1" } },
        { id: "page-2", instagram_business_account: { id: "ig-account-2" } },
      ] })),
      forFacebookPage: vi.fn(),
    };
    const token: OAuthToken = { accessToken: "fresh-token", authMode: "facebook" };

    await expect(verifyOAuthAccountIdentity({ authMode: "facebook", graphApiVersion: "v25.0" }, token, {}, clientFactory(client)))
      .rejects.toThrow("OAUTH_IDENTITY_AMBIGUOUS");
  });
});
