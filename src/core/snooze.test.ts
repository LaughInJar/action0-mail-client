import { describe, expect, it } from "vitest";
import { isDueBack, snoozePresets } from "./snooze";

const kinds = (now: Date) => snoozePresets(now).map((preset) => preset.kind);

describe("Snooze's times", () => {
  it("offers later today, tomorrow, the weekend and next week on a weekday morning", () => {
    // Tuesday 09:20.
    const tuesday = new Date(2026, 10, 3, 9, 20);
    const presets = snoozePresets(tuesday);
    expect(presets.map((preset) => preset.kind)).toEqual([
      "later-today",
      "tomorrow-morning",
      "weekend",
      "next-week",
    ]);
    expect(presets.map((preset) => preset.at)).toEqual([
      new Date(2026, 10, 3, 12, 0),
      new Date(2026, 10, 4, 8, 0),
      new Date(2026, 10, 7, 8, 0),
      new Date(2026, 10, 9, 8, 0),
    ]);
  });

  it("leaves out what doesn't fit the day, and times offered twice", () => {
    // Tuesday evening: no "later today".
    expect(kinds(new Date(2026, 10, 3, 19, 0))).not.toContain("later-today");
    // Friday: the weekend is tomorrow morning.
    expect(kinds(new Date(2026, 10, 6, 19, 0))).toEqual([
      "tomorrow-morning",
      "next-week",
    ]);
    // Saturday: no weekend; Sunday: next week is tomorrow morning.
    expect(kinds(new Date(2026, 10, 7, 19, 0))).toEqual([
      "tomorrow-morning",
      "next-week",
    ]);
    expect(kinds(new Date(2026, 10, 8, 19, 0))).toEqual(["tomorrow-morning"]);
  });

  it("is due back at its time", () => {
    const until = "2026-11-03T07:00:00.000Z";
    expect(isDueBack(until, Date.parse(until) - 1)).toBe(false);
    expect(isDueBack(until, Date.parse(until))).toBe(true);
  });
});
