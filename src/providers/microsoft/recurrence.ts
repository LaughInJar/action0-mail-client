import type { Repeat } from "../../core/calendar";
import { previousDay } from "../../core/recurrence";

/** Graph's `patternedRecurrence` (the parts action0 reads and writes). */
export interface GraphRecurrence {
  readonly pattern?: {
    readonly type?: string;
    readonly interval?: number;
    readonly daysOfWeek?: readonly string[];
    readonly dayOfMonth?: number;
    readonly month?: number;
    readonly index?: string;
    readonly firstDayOfWeek?: string;
  };
  readonly range?: {
    readonly type?: string;
    readonly startDate?: string;
    readonly endDate?: string;
    readonly numberOfOccurrences?: number;
    readonly recurrenceTimeZone?: string;
  };
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const WORKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];

/** Weekday name and day/month numbers of a "YYYY-MM-DD" day. */
function partsOf(day: string) {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return { weekday: DAY_NAMES[weekday] ?? "monday", month, date };
}

/** The {@link Repeat} of a Graph recurrence (`custom` for what action0 doesn't create). */
export function repeatOfGraph(
  recurrence: GraphRecurrence | null | undefined,
  startDay: string,
): Repeat | null {
  const pattern = recurrence?.pattern;
  if (!pattern) return null;
  const range = recurrence.range;
  if ((pattern.interval ?? 1) !== 1 || range?.type === "numbered")
    return { kind: "custom" };
  const ends =
    range?.type === "endDate" && range.endDate ? { until: range.endDate } : {};
  const own = partsOf(range?.startDate ?? startDay);
  const days = [...(pattern.daysOfWeek ?? [])].map((d) => d.toLowerCase());
  switch (pattern.type ?? "") {
    case "daily":
      return { kind: "daily", ...ends };
    case "weekly":
      if (days.length === 5 && WORKDAYS.every((d) => days.includes(d)))
        return { kind: "weekdays", ...ends };
      return days.length === 1 && days[0] === own.weekday
        ? { kind: "weekly", ...ends }
        : { kind: "custom" };
    case "absoluteMonthly":
      return pattern.dayOfMonth === own.date
        ? { kind: "monthly", ...ends }
        : { kind: "custom" };
    case "absoluteYearly":
      return pattern.dayOfMonth === own.date && pattern.month === own.month
        ? { kind: "yearly", ...ends }
        : { kind: "custom" };
    default:
      return { kind: "custom" };
  }
}

/** A Graph recurrence of one of the kinds action0 creates, from `startDay` on. */
export function graphRecurrence(
  repeat: Exclude<Repeat, { kind: "custom" }>,
  startDay: string,
  zone: string,
): GraphRecurrence {
  const own = partsOf(startDay);
  const pattern = (() => {
    switch (repeat.kind) {
      case "daily":
        return { type: "daily", interval: 1 };
      case "weekdays":
        return { type: "weekly", interval: 1, daysOfWeek: WORKDAYS };
      case "weekly":
        return { type: "weekly", interval: 1, daysOfWeek: [own.weekday] };
      case "monthly":
        return { type: "absoluteMonthly", interval: 1, dayOfMonth: own.date };
      case "yearly":
        return {
          type: "absoluteYearly",
          interval: 1,
          dayOfMonth: own.date,
          month: own.month,
        };
    }
  })();
  return {
    pattern,
    range: {
      type: repeat.until === undefined ? "noEnd" : "endDate",
      startDate: startDay,
      ...(repeat.until === undefined ? {} : { endDate: repeat.until }),
      recurrenceTimeZone: zone,
    },
  };
}

/**
 * A series' recurrence after its first day moved from `fromDay` to `toDay`:
 * the range starts there, and a weekly day, monthly date or yearly date
 * that named the old day names the new one.
 */
export function retimeGraph(
  recurrence: GraphRecurrence,
  fromDay: string,
  toDay: string,
): GraphRecurrence {
  const from = partsOf(fromDay);
  const to = partsOf(toDay);
  const pattern = recurrence.pattern ?? {};
  const days = pattern.daysOfWeek;
  return {
    pattern: {
      ...pattern,
      ...(days?.length === 1 && days[0]?.toLowerCase() === from.weekday
        ? { daysOfWeek: [to.weekday] }
        : {}),
      ...(pattern.dayOfMonth === from.date ? { dayOfMonth: to.date } : {}),
      ...(pattern.month === from.month ? { month: to.month } : {}),
    },
    range: { ...recurrence.range, startDate: toDay },
  };
}

/**
 * Splits a series at the occurrence on `day`: the old one ends the day
 * before, the new one starts on it with what's left of a numbered range
 * (`before` occurrences took place already).
 */
export function splitGraph(
  recurrence: GraphRecurrence,
  day: string,
  before: number,
): { readonly old: GraphRecurrence; readonly rest: GraphRecurrence } {
  const range = recurrence.range ?? {};
  const { numberOfOccurrences: _count, ...dated } = range;
  return {
    old: {
      ...recurrence,
      range: { ...dated, type: "endDate", endDate: previousDay(day) },
    },
    rest: {
      ...recurrence,
      range: {
        ...range,
        startDate: day,
        ...(range.type === "numbered"
          ? {
              numberOfOccurrences: Math.max(
                1,
                (range.numberOfOccurrences ?? 1) - before,
              ),
            }
          : {}),
      },
    },
  };
}
