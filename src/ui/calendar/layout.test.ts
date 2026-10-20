// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  addDays,
  firstDayOfWeek,
  isoWeek,
  parseDay,
  startOfWeek,
  stepView,
  viewDays,
  dayKey,
} from "./dates";
import { layoutBars, layoutDay } from "./layout";

const day = parseDay("2026-10-20"); // a Tuesday
const at = (hhmm: string, base = day) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const time = new Date(base);
  time.setHours(h, m);
  return time.getTime();
};
const span = ([start, end]: readonly [string, string]) => ({
  start: at(start),
  end: at(end),
});

describe("layoutDay", () => {
  it("puts overlapping events side by side, others full width", () => {
    const events = [
      ["09:00", "10:00"],
      ["09:30", "11:00"],
      ["10:00", "10:30"],
      ["13:00", "14:00"],
    ] as const;
    const placed = layoutDay(day, events, span);
    const byStart = (start: string) => placed.find((p) => p.item[0] === start);
    expect(byStart("09:00")).toMatchObject({ lane: 0, lanes: 2 });
    expect(byStart("09:30")).toMatchObject({ lane: 1, lanes: 2 });
    // 10:00 starts when the first lane is free again.
    expect(byStart("10:00")).toMatchObject({ lane: 0, lanes: 2 });
    expect(byStart("13:00")).toMatchObject({ lane: 0, lanes: 1 });
    expect(byStart("09:00")?.top).toBeCloseTo(9 / 24);
    expect(byStart("09:00")?.height).toBeCloseTo(1 / 24);
  });

  it("clips events that run over midnight", () => {
    const [placed] = layoutDay(
      day,
      [{ start: at("22:00"), end: at("02:00", addDays(day, 1)) }],
      (item) => item,
    );
    expect(placed?.top).toBeCloseTo(22 / 24);
    expect(placed?.height).toBeCloseTo(2 / 24);
  });
});

describe("layoutBars", () => {
  it("stacks multi-day bars in rows and marks continuations", () => {
    const first = parseDay("2026-10-19");
    const bars = layoutBars(
      first,
      7,
      [
        {
          name: "conference",
          start: parseDay("2026-10-21").getTime(),
          end: parseDay("2026-10-24").getTime(),
        },
        {
          name: "holiday",
          start: parseDay("2026-10-22").getTime(),
          end: parseDay("2026-10-23").getTime(),
        },
        {
          name: "trip",
          start: parseDay("2026-10-15").getTime(),
          end: parseDay("2026-10-20").getTime(),
        },
        {
          name: "long",
          start: parseDay("2026-10-25").getTime(),
          end: parseDay("2026-10-30").getTime(),
        },
      ],
      (item) => item,
    );
    const of = (name: string) => bars.find((bar) => bar.item.name === name);
    expect(of("conference")).toMatchObject({ first: 2, last: 4, row: 0 });
    expect(of("holiday")).toMatchObject({ first: 3, last: 3, row: 1 });
    expect(of("trip")).toMatchObject({
      first: 0,
      last: 0,
      continuesBefore: true,
    });
    expect(of("long")).toMatchObject({
      first: 6,
      last: 6,
      continuesAfter: true,
    });
  });
});

describe("dates", () => {
  it("knows where weeks start", () => {
    expect(firstDayOfWeek("de-AT")).toBe(1);
    expect(firstDayOfWeek("en-US")).toBe(7);
    expect(dayKey(startOfWeek(day, 1))).toBe("2026-10-19");
    expect(dayKey(startOfWeek(day, 7))).toBe("2026-10-18");
  });

  it("computes the days of each view", () => {
    const week = viewDays("week", day, 1);
    expect([dayKey(week.first), dayKey(week.end)]).toEqual([
      "2026-10-19",
      "2026-10-26",
    ]);
    const month = viewDays("month", day, 1);
    expect([dayKey(month.first), dayKey(month.end)]).toEqual([
      "2026-09-28",
      "2026-11-09",
    ]);
    expect(dayKey(viewDays("agenda", day, 1).end)).toBe("2026-11-19");
  });

  it("steps views and keeps the day of month", () => {
    expect(dayKey(stepView("month", parseDay("2026-01-31"), 1))).toBe(
      "2026-02-28",
    );
    expect(dayKey(stepView("week", day, -1))).toBe("2026-10-13");
    expect(isoWeek(day)).toBe(43);
  });
});
