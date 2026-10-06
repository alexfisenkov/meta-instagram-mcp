import { describe, expect, it } from "vitest";
import { getScopePresets } from "../src/oauth.js";

describe("API scope presets", () => {
  it("separates messaging and comments permissions for both login modes", () => {
    const facebook = getScopePresets("facebook");
    expect(facebook.inbox).toEqual(["instagram_basic", "pages_show_list", "pages_manage_metadata", "instagram_manage_messages"]);
    expect(facebook.comments).toEqual(["instagram_basic", "instagram_manage_comments"]);
    const instagram = getScopePresets("instagram");
    expect(instagram.inbox).toEqual(["instagram_business_basic", "instagram_business_manage_messages"]);
    expect(instagram.comments).toEqual(["instagram_business_basic", "instagram_business_manage_comments"]);
  });

  it("keeps existing analytics and fullStandard publish scopes while unioning comments and messaging", () => {
    for (const mode of ["facebook", "instagram"] as const) {
      const presets = getScopePresets(mode);
      expect(presets.fullStandard).toEqual(expect.arrayContaining([...presets.analytics, ...presets.inbox, ...presets.comments]));
      expect(presets.fullStandard.some((scope) => scope.includes("content_publish"))).toBe(true);
      expect(presets.readOnly).not.toContainEqual(expect.stringContaining("manage_messages"));
    }
  });
});
