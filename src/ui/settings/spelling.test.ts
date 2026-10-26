// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  applySpelling,
  chosenSpellLanguages,
  defaultSpellLanguages,
} from "./spelling";

const INSTALLED = ["de-AT", "de-CH", "de-DE", "en-GB", "en-US", "eo", "fr-FR"];

describe("defaultSpellLanguages", () => {
  it("takes the same variant, else the language's main one", () => {
    expect(defaultSpellLanguages(INSTALLED, ["de-AT", "en-AU"])).toEqual([
      "de-AT",
      "en-US",
    ]);
    expect(defaultSpellLanguages(INSTALLED, ["de", "fr-CA"])).toEqual([
      "de-DE",
      "fr-FR",
    ]);
  });

  it("knows dictionaries for a whole language and odd main variants", () => {
    expect(defaultSpellLanguages(INSTALLED, ["eo"])).toEqual(["eo"]);
    expect(defaultSpellLanguages(["pt-BR", "pt-PT"], ["pt"])).toEqual([
      "pt-PT",
    ]);
    expect(defaultSpellLanguages(["en-GB"], ["en-US"])).toEqual(["en-GB"]);
  });

  it("takes each once, and skips languages without a dictionary", () => {
    expect(
      defaultSpellLanguages(INSTALLED, ["en-US", "it-IT", "en", "zh-Hant-TW"]),
    ).toEqual(["en-US"]);
    expect(defaultSpellLanguages([], ["de-AT"])).toEqual([]);
  });
});

describe("chosenSpellLanguages", () => {
  it("keeps the chosen ones that are installed", () => {
    expect(
      chosenSpellLanguages(["fr-FR", "it-IT"], INSTALLED, ["de-AT"]),
    ).toEqual(["fr-FR"]);
  });

  it("falls back to the preferred languages", () => {
    expect(chosenSpellLanguages([], INSTALLED, ["de-AT", "en"])).toEqual([
      "de-AT",
      "en-US",
    ]);
    expect(chosenSpellLanguages(["it-IT"], INSTALLED, ["en-GB"])).toEqual([
      "en-GB",
    ]);
  });
});

describe("applySpelling", () => {
  it("checks with the chosen languages and reports what loaded", async () => {
    const setLanguages = vi.fn(() => Promise.resolve(["de-AT"]));
    const status = await applySpelling(
      { dictionaries: () => Promise.resolve(INSTALLED), setLanguages },
      [],
      ["de-AT", "en-US"],
    );
    expect(setLanguages).toHaveBeenCalledWith(["de-AT", "en-US"]);
    expect(status).toEqual({
      dictionaries: INSTALLED,
      languages: ["de-AT", "en-US"],
      loaded: ["de-AT"],
    });
  });
});
