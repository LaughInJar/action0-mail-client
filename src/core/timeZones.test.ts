import { describe, expect, it } from "vitest";
import { instantAt, isKnownZone, wallTime } from "./timeZones";

describe("time zones", () => {
  it("reads an instant on another zone's clock", () => {
    const instant = Date.parse("2026-10-22T08:30:00Z");
    expect(wallTime(instant, "Europe/Vienna")).toEqual({
      date: "2026-10-22",
      time: "10:30:00",
    });
    expect(wallTime(instant, "America/New_York")).toEqual({
      date: "2026-10-22",
      time: "04:30:00",
    });
  });

  it("finds the instant of a clock time, across daylight saving changes", () => {
    expect(
      new Date(instantAt("2026-10-22", "10:00", "Europe/Vienna")).toISOString(),
    ).toBe("2026-10-22T08:00:00.000Z");
    // After the change back to winter time.
    expect(
      new Date(instantAt("2026-10-26", "10:00", "Europe/Vienna")).toISOString(),
    ).toBe("2026-10-26T09:00:00.000Z");
    // 02:30 doesn't exist on 29 March 2026 in Vienna: the later side.
    expect(
      new Date(instantAt("2026-03-29", "02:30", "Europe/Vienna")).toISOString(),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("knows which zones Intl knows", () => {
    expect(isKnownZone("Europe/Vienna")).toBe(true);
    expect(isKnownZone("W. Europe Standard Time")).toBe(false);
  });
});
