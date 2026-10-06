import { describe, expect, it } from "vitest";
import { appiumXmlFind, appiumXmlValues, parseAppiumXml } from "../src/providers/xml.js";

describe("Appium XML parser", () => {
  it("parses a bounded accessibility tree and decodes only predefined/numeric entities", () => {
    const root = parseAppiumXml('<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication name="Instagram"><XCUIElementTypeStaticText label="2.4K followers &amp; 10 posts"/><XCUIElementTypeButton label="Profile &#x1F4F7;"/></XCUIElementTypeApplication></AppiumAUT>');
    expect(root.tag).toBe("AppiumAUT");
    expect(appiumXmlFind(root, (node) => node.tag === "XCUIElementTypeButton")).toHaveLength(1);
    expect(appiumXmlValues(root)).toContain("2.4K followers & 10 posts");
    expect(appiumXmlValues(root)).toContain("Profile 📷");
  });

  it("rejects DTD/external entities and enforces depth and byte limits", () => {
    expect(() => parseAppiumXml('<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><x>&leak;</x>')).toThrow(/DTD and entity/);
    expect(() => parseAppiumXml("<a><b><c/></b></a>", { maxDepth: 2 })).toThrow(/depth limit/);
    expect(() => parseAppiumXml("<a>123</a>", { maxBytes: 5 })).toThrow(/size limit/);
  });
});
