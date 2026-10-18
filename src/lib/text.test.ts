// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findFolded, foldText } from "./text";

describe("foldText / findFolded", () => {
  it("ignores case and accents", () => {
    expect(foldText("Ärger im Café")).toBe("arger im cafe");
    expect(findFolded("Ärger im Café", "CAFE")).toEqual([9, 13]);
    expect(findFolded("Ärger", "ar")).toEqual([0, 2]);
  });

  it("maps the match back to the original text", () => {
    // Decomposed input: "e" + combining acute accent is two code units.
    const text = "Résumé 2026";
    const range = findFolded(text, "sume 20");
    expect(range).toBeDefined();
    const [start, end] = range ?? [0, 0];
    expect(text.slice(start, end)).toBe("sumé 20");
  });

  it("finds nothing for blank queries or misses", () => {
    expect(findFolded("Inbox", "  ")).toBeUndefined();
    expect(findFolded("Inbox", "outbox")).toBeUndefined();
  });
});
