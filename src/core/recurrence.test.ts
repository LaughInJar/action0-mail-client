import { describe, expect, it } from "vitest";
import type { EventTime } from "./calendar";
import {
  moveLike,
  repeatOf,
  retimeRule,
  ruleOf,
  splitRule,
} from "./recurrence";

/** Thursday 22 October 2026, 10:00 in Vienna. */
const thursday: EventTime = {
  dateTime: "2026-10-22T08:00:00.000Z",
  timeZone: "Europe/Vienna",
};
const allDay: EventTime = { date: "2026-10-22" };

describe("repeat rules", () => {
  it("reads the kinds action0 creates, and calls everything else custom", () => {
    expect(repeatOf(undefined, thursday)).toBeNull();
    expect(repeatOf(["RRULE:FREQ=DAILY"], thursday)).toEqual({ kind: "daily" });
    expect(
      repeatOf(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"], thursday),
    ).toEqual({ kind: "weekdays" });
    expect(repeatOf(["RRULE:FREQ=WEEKLY;BYDAY=TH"], thursday)).toEqual({
      kind: "weekly",
    });
    expect(repeatOf(["RRULE:FREQ=WEEKLY"], thursday)).toEqual({
      kind: "weekly",
    });
    expect(repeatOf(["RRULE:FREQ=MONTHLY;BYMONTHDAY=22"], thursday)).toEqual({
      kind: "monthly",
    });
    expect(repeatOf(["RRULE:FREQ=YEARLY"], allDay)).toEqual({ kind: "yearly" });
    expect(
      repeatOf(["RRULE:FREQ=WEEKLY;UNTIL=20261231T225959Z;BYDAY=TH"], thursday),
    ).toEqual({ kind: "weekly", until: "2026-12-31" });
    expect(repeatOf(["RRULE:FREQ=DAILY;UNTIL=20261231"], allDay)).toEqual({
      kind: "daily",
      until: "2026-12-31",
    });
    for (const custom of [
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH",
      "RRULE:FREQ=WEEKLY;BYDAY=TU,TH",
      "RRULE:FREQ=MONTHLY;BYDAY=2TU",
      "RRULE:FREQ=DAILY;COUNT=5",
    ])
      expect(repeatOf([custom], thursday)).toEqual({ kind: "custom" });
    // Exceptions don't change the rule.
    expect(
      repeatOf(
        ["EXDATE;TZID=Europe/Vienna:20261029T100000", "RRULE:FREQ=DAILY"],
        thursday,
      ),
    ).toEqual({ kind: "daily" });
  });

  it("writes rules, ending at the end of the last day where the event is planned", () => {
    expect(ruleOf({ kind: "weekly" }, thursday)).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=TH",
    );
    expect(ruleOf({ kind: "weekdays", until: "2026-12-31" }, thursday)).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231T225959Z",
    );
    expect(ruleOf({ kind: "monthly", until: "2026-12-31" }, allDay)).toBe(
      "RRULE:FREQ=MONTHLY;UNTIL=20261231",
    );
    // Written rules read back as they were.
    expect(
      repeatOf(
        [ruleOf({ kind: "daily", until: "2027-01-15" }, thursday)],
        thursday,
      ),
    ).toEqual({ kind: "daily", until: "2027-01-15" });
  });

  it("splits a series before an occurrence, with what's left of a count", () => {
    const at: EventTime = {
      dateTime: "2026-11-05T09:00:00.000Z",
      timeZone: "Europe/Vienna",
    };
    const lines = [
      "RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=TH",
      "EXDATE:20261029T090000Z",
    ];
    expect(splitRule(lines, at, 2)).toEqual({
      old: ["RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261105T085959Z", lines[1]],
      rest: ["RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=TH", lines[1]],
    });
    expect(
      splitRule(["RRULE:FREQ=DAILY"], { date: "2026-11-01" }, 0).old,
    ).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261031"]);
  });

  it("follows a series' new day", () => {
    const friday: EventTime = {
      dateTime: "2026-10-23T08:00:00.000Z",
      timeZone: "Europe/Vienna",
    };
    expect(
      retimeRule(["RRULE:FREQ=WEEKLY;BYDAY=TH"], thursday, friday),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=FR"]);
    // Rules that don't name the day stay.
    expect(retimeRule(["RRULE:FREQ=DAILY"], thursday, friday)).toEqual([
      "RRULE:FREQ=DAILY",
    ]);
  });

  it("moves a series' start like one of its occurrences moved", () => {
    const occurrence: EventTime = {
      dateTime: "2026-11-05T09:00:00.000Z",
      timeZone: "Europe/Vienna",
    };
    const later: EventTime = {
      dateTime: "2026-11-05T10:30:00.000Z",
      timeZone: "Europe/Vienna",
    };
    expect(moveLike(thursday, occurrence, later)).toEqual({
      dateTime: "2026-10-22T09:30:00.000Z",
      timeZone: "Europe/Vienna",
    });
    // To all-day: the series' own first day.
    expect(moveLike(thursday, occurrence, { date: "2026-11-05" })).toEqual({
      date: "2026-10-22",
    });
  });
});
