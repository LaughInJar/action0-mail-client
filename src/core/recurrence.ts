/**
 * Repeating events as iCalendar rules (RFC 5545 `RRULE`, as Google keeps
 * them): the {@link Repeat} kinds action0 shows, and how a series is split
 * for "this and following".
 */
import { instantAt, localZone, wallTime } from "./timeZones";
import { timeOf, type EventTime, type Repeat } from "./calendar";

/** RFC 5545 weekday codes, Sunday first (like `Date.getDay()`). */
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WORKDAYS = "MO,TU,WE,TH,FR";

/** The day an event time falls on where it's planned: "YYYY-MM-DD". */
export function dayOf(time: EventTime): string {
  if ("date" in time) return time.date;
  return wallTime(Date.parse(time.dateTime), time.timeZone ?? localZone()).date;
}

/** Weekday (0 = Sunday) of a "YYYY-MM-DD" day. */
function weekdayOf(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/** The parts of an `RRULE:` line, upper-cased keys. */
function partsOf(line: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const part of line.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = part.split("=");
    if (key && value !== undefined) parts.set(key.toUpperCase(), value);
  }
  return parts;
}

function lineOf(parts: ReadonlyMap<string, string>): string {
  return `RRULE:${[...parts].map(([key, value]) => `${key}=${value}`).join(";")}`;
}

const isRule = (line: string) => /^RRULE:/i.test(line);

/** "20261231" or "20261231T225959Z" as the day it ends on ("YYYY-MM-DD"). */
function untilDay(value: string, zone: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    value,
  );
  if (!match) return undefined;
  const [, y, m, d, hh, mm, ss, z] = match;
  const day = `${y ?? ""}-${m ?? ""}-${d ?? ""}`;
  if (hh === undefined || z === undefined) return day;
  const instant = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  return wallTime(instant, zone).date;
}

/**
 * The {@link Repeat} of an event's recurrence lines (`RRULE`, `EXDATE`, …):
 * `null` without a rule, `custom` for anything action0 doesn't create.
 */
export function repeatOf(
  lines: readonly string[] | undefined,
  start: EventTime,
): Repeat | null {
  const rules = (lines ?? []).filter(isRule);
  const rule = rules[0];
  if (rule === undefined)
    return (lines ?? []).some((line) => /^RDATE/i.test(line))
      ? { kind: "custom" }
      : null;
  if (rules.length > 1) return { kind: "custom" };
  const parts = partsOf(rule);
  const known = new Set(["FREQ", "INTERVAL", "UNTIL", "BYDAY", "WKST"]);
  const day = dayOf(start);
  const [, month, date] = day.split("-").map(Number);
  // BYMONTHDAY/BYMONTH that only repeat the start are fine.
  if (parts.get("BYMONTHDAY") === String(date)) known.add("BYMONTHDAY");
  if (parts.get("BYMONTH") === String(month)) known.add("BYMONTH");
  if ([...parts.keys()].some((key) => !known.has(key)))
    return { kind: "custom" };
  if ((parts.get("INTERVAL") ?? "1") !== "1") return { kind: "custom" };
  const zone = "timeZone" in start ? (start.timeZone ?? localZone()) : "";
  const until = parts.has("UNTIL")
    ? untilDay(parts.get("UNTIL") ?? "", zone || localZone())
    : undefined;
  if (parts.has("UNTIL") && until === undefined) return { kind: "custom" };
  const byDay = parts.get("BYDAY");
  const ends = until === undefined ? {} : { until };
  const ownDay = WEEKDAYS[weekdayOf(day)];
  switch (parts.get("FREQ") ?? "") {
    case "DAILY":
      if (byDay === undefined) return { kind: "daily", ...ends };
      return byDay === WORKDAYS
        ? { kind: "weekdays", ...ends }
        : { kind: "custom" };
    case "WEEKLY":
      if (byDay === WORKDAYS) return { kind: "weekdays", ...ends };
      return byDay === undefined || byDay === ownDay
        ? { kind: "weekly", ...ends }
        : { kind: "custom" };
    case "MONTHLY":
      return byDay === undefined
        ? { kind: "monthly", ...ends }
        : { kind: "custom" };
    case "YEARLY":
      return byDay === undefined
        ? { kind: "yearly", ...ends }
        : { kind: "custom" };
    default:
      return { kind: "custom" };
  }
}

/** "YYYY-MM-DD" → "YYYYMMDD". */
const basicDay = (day: string) => day.replace(/-/g, "");

/** An instant as "YYYYMMDDTHHMMSSZ". */
function basicUtc(instant: number): string {
  return new Date(instant)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** `UNTIL` for the last day of a series starting at `start`. */
function untilValue(day: string, start: EventTime): string {
  if ("date" in start) return basicDay(day);
  return basicUtc(instantAt(day, "23:59:59", start.timeZone ?? localZone()));
}

/**
 * The `RRULE` line of one of the kinds action0 creates, for a series
 * starting at `start` (weekly repeats on its weekday).
 */
export function ruleOf(
  repeat: Exclude<Repeat, { kind: "custom" }>,
  start: EventTime,
): string {
  const parts = new Map<string, string>();
  switch (repeat.kind) {
    case "daily":
      parts.set("FREQ", "DAILY");
      break;
    case "weekdays":
      parts.set("FREQ", "WEEKLY");
      parts.set("BYDAY", WORKDAYS);
      break;
    case "weekly":
      parts.set("FREQ", "WEEKLY");
      parts.set("BYDAY", WEEKDAYS[weekdayOf(dayOf(start))] ?? "MO");
      break;
    case "monthly":
      parts.set("FREQ", "MONTHLY");
      break;
    case "yearly":
      parts.set("FREQ", "YEARLY");
      break;
  }
  if (repeat.until !== undefined)
    parts.set("UNTIL", untilValue(repeat.until, start));
  return lineOf(parts);
}

/**
 * A series' recurrence lines after its start moved from `from` to `to`:
 * a weekly rule on the old weekday follows to the new one, and a
 * `BYMONTHDAY`/`BYMONTH` that named the old date names the new one.
 */
export function retimeRule(
  lines: readonly string[],
  from: EventTime,
  to: EventTime,
): string[] {
  const oldDay = dayOf(from);
  const newDay = dayOf(to);
  if (oldDay === newDay) return [...lines];
  const [, oldMonth, oldDate] = oldDay.split("-").map(Number);
  const [, newMonth, newDate] = newDay.split("-").map(Number);
  return lines.map((line) => {
    if (!isRule(line)) return line;
    const parts = partsOf(line);
    if (parts.get("BYDAY") === WEEKDAYS[weekdayOf(oldDay)])
      parts.set("BYDAY", WEEKDAYS[weekdayOf(newDay)] ?? "MO");
    if (parts.get("BYMONTHDAY") === String(oldDate))
      parts.set("BYMONTHDAY", String(newDate));
    if (parts.get("BYMONTH") === String(oldMonth))
      parts.set("BYMONTH", String(newMonth));
    return lineOf(parts);
  });
}

/**
 * Splits a series' recurrence lines at the occurrence that starts at `at`
 * (as originally planned): the old series ends just before it, and the new
 * one, starting there, has what's left of a `COUNT` (`before` occurrences
 * took place already).
 */
export function splitRule(
  lines: readonly string[],
  at: EventTime,
  before: number,
): { readonly old: string[]; readonly rest: string[] } {
  const end =
    "date" in at
      ? basicDay(previousDay(at.date))
      : basicUtc(Date.parse(at.dateTime) - 1000);
  const old = lines.map((line) => {
    if (!isRule(line)) return line;
    const parts = partsOf(line);
    parts.delete("COUNT");
    parts.set("UNTIL", end);
    return lineOf(parts);
  });
  const rest = lines.map((line) => {
    if (!isRule(line)) return line;
    const parts = partsOf(line);
    const count = parts.get("COUNT");
    if (count !== undefined)
      parts.set("COUNT", String(Math.max(1, Number(count) - before)));
    return lineOf(parts);
  });
  return { old, rest };
}

/** The day before a "YYYY-MM-DD" day. */
export function previousDay(day: string): string {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1))
    .toISOString()
    .slice(0, 10);
}

/** The rule's last day, if it ends by date ("YYYY-MM-DD"). */
export function ruleUntil(
  lines: readonly string[],
  start: EventTime,
): string | undefined {
  const rule = lines.find(isRule);
  const value = rule === undefined ? undefined : partsOf(rule).get("UNTIL");
  if (value === undefined) return undefined;
  const zone = "timeZone" in start ? (start.timeZone ?? localZone()) : "";
  return untilDay(value, zone || localZone());
}

/**
 * Where a series' `start` (or `end`) goes when one of its occurrences
 * moved from `from` to `to`: as much later, on the series' own first day.
 * Switching between all-day and timed takes the occurrence's new form.
 */
export function moveLike(
  series: EventTime,
  from: EventTime,
  to: EventTime,
): EventTime {
  const DAY = 24 * 60 * 60 * 1000;
  if ("date" in to) {
    const days = Math.round((timeOf(to) - timeOf(from)) / DAY);
    const day = new Date(`${dayOf(series)}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + days);
    return { date: day.toISOString().slice(0, 10) };
  }
  if ("date" in series) {
    // Timed now: the occurrence's new clock time on the series' first day.
    const shift =
      Date.parse(`${dayOf(series)}T00:00:00Z`) -
      Date.parse(`${dayOf(from)}T00:00:00Z`);
    return {
      ...to,
      dateTime: new Date(Date.parse(to.dateTime) + shift).toISOString(),
    };
  }
  return {
    dateTime: new Date(
      Date.parse(series.dateTime) + timeOf(to) - timeOf(from),
    ).toISOString(),
    timeZone: to.timeZone ?? series.timeZone ?? localZone(),
  };
}
