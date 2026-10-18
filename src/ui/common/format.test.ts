// @vitest-environment node
import { describe, expect, it } from "vitest";
import { displayName, formatBytes, formatListDate } from "./format";

const options = {
  now: new Date("2026-10-18T15:00:00Z"),
  locale: "en-GB",
  timeZone: "Europe/Vienna",
};

describe("formatListDate", () => {
  it("shows the time for today, day and month for this year, the full date before", () => {
    expect(formatListDate("2026-10-18T07:05:00Z", options)).toBe("09:05");
    expect(formatListDate("2026-03-02T10:00:00Z", options)).toBe("2 Mar");
    expect(formatListDate("2025-12-24T10:00:00Z", options)).toBe("24/12/2025");
  });

  it("decides 'today' in the given time zone", () => {
    // 23:30 UTC on the 17th is already the 18th in Vienna.
    expect(formatListDate("2026-10-17T23:30:00Z", options)).toBe("01:30");
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [2048, "2.0 KB"],
    [84_213, "82 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
  ])("%d → %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("displayName", () => {
  it("falls back to the address", () => {
    expect(displayName({ name: "Anna", address: "a@x" })).toBe("Anna");
    expect(displayName({ name: "  ", address: "a@x" })).toBe("a@x");
    expect(displayName(undefined)).toBe("(unknown sender)");
  });
});
