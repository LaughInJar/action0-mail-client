// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localeFor, resolveLanguage } from "./locale";
import { plural } from "./plural";

describe("resolveLanguage", () => {
  it.each([
    [["de-AT", "en"], "de"],
    [["de-CH"], "de"],
    [["de"], "de"],
    [["en-GB", "de-AT"], "en"],
    [["fr-FR"], "en"],
    [[], "en"],
  ] as const)("follows the browser's first language %j", (tags, language) => {
    expect(resolveLanguage("auto", tags)).toBe(language);
  });

  it("keeps a chosen language", () => {
    expect(resolveLanguage("en", ["de-AT"])).toBe("en");
    expect(resolveLanguage("de", ["en-US"])).toBe("de");
  });
});

describe("localeFor", () => {
  it("uses the browser's variant of the language", () => {
    expect(localeFor("de", ["de-AT", "en"])).toBe("de-AT");
    expect(localeFor("en", ["de-AT", "en-GB"])).toBe("en-GB");
  });

  it("falls back to a default variant", () => {
    expect(localeFor("de", ["en-US"])).toBe("de-DE");
    expect(localeFor("en", ["de-AT"])).toBe("en-US");
  });
});

describe("plural", () => {
  it("picks the form by count", () => {
    expect(plural(1, "1 Nachricht", "Nachrichten")).toBe("1 Nachricht");
    expect(plural(0, "1 Nachricht", "Nachrichten")).toBe("Nachrichten");
    expect(plural(2, "1 Nachricht", "Nachrichten")).toBe("Nachrichten");
  });
});
