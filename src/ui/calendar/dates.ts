import {
  timeOf,
  type CalendarEvent,
  type DateRange,
} from "../../core/calendar";
import type { CalendarView } from "../../state/router";

/** A local day as "YYYY-MM-DD". */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a "YYYY-MM-DD" day. */
export function parseDay(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/** The day `n` days after `date` (local, so DST changes don't shift it). */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** The first day of the month `n` months after `date`'s. */
export function addMonths(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

/** True if both are the same local day. */
export function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

/** Regions whose weeks start on Sunday (when the browser can't tell). */
const SUNDAY_REGIONS = new Set([
  "US",
  "CA",
  "JP",
  "BR",
  "MX",
  "IL",
  "PH",
  "KR",
  "TW",
  "HK",
  "AU",
]);

/** First day of the week for a locale: 1 = Monday … 7 = Sunday. */
export function firstDayOfWeek(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (firstDay !== undefined) return firstDay;
    const region = info.maximize().region ?? "";
    return SUNDAY_REGIONS.has(region) ? 7 : 1;
  } catch {
    return 1;
  }
}

/** The first day of the week `date` is in. */
export function startOfWeek(date: Date, firstDay: number): Date {
  const weekday = date.getDay() === 0 ? 7 : date.getDay(); // 1 = Monday
  const back = (weekday - firstDay + 7) % 7;
  return addDays(date, -back);
}

/** The days a view shows: [first, end) as local midnights. */
export function viewDays(
  view: CalendarView,
  day: Date,
  firstDay: number,
): { readonly first: Date; readonly end: Date } {
  switch (view) {
    case "day":
      return { first: day, end: addDays(day, 1) };
    case "week": {
      const first = startOfWeek(day, firstDay);
      return { first, end: addDays(first, 7) };
    }
    case "month": {
      // Six whole weeks, starting with the week of the 1st.
      const first = startOfWeek(
        new Date(day.getFullYear(), day.getMonth(), 1),
        firstDay,
      );
      return { first, end: addDays(first, 42) };
    }
    case "agenda":
      return { first: day, end: addDays(day, 30) };
  }
}

/** A {@link DateRange} of local midnights. */
export function rangeOf(days: {
  readonly first: Date;
  readonly end: Date;
}): DateRange {
  return { from: days.first.toISOString(), to: days.end.toISOString() };
}

/** The day `step` views before or after `day` (‹ and ›). */
export function stepView(view: CalendarView, day: Date, step: number): Date {
  switch (view) {
    case "day":
      return addDays(day, step);
    case "week":
      return addDays(day, 7 * step);
    case "month": {
      const target = addMonths(day, step);
      // Keep the day of month where it exists (31st → 30th).
      const last = new Date(
        target.getFullYear(),
        target.getMonth() + 1,
        0,
      ).getDate();
      return new Date(
        target.getFullYear(),
        target.getMonth(),
        Math.min(day.getDate(), last),
      );
    }
    case "agenda":
      return addDays(day, 30 * step);
  }
}

/** ISO 8601 week number (for the week label). */
export function isoWeek(date: Date): number {
  const thursday = addDays(date, 4 - (date.getDay() === 0 ? 7 : date.getDay()));
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  // Whole days: a daylight saving change in between shifts the difference by an hour.
  const days = Math.round(
    (thursday.getTime() - yearStart.getTime()) / 86_400_000,
  );
  return Math.floor(days / 7) + 1;
}

/** Start and end of an event in epoch ms. */
export function spanOf(event: CalendarEvent): {
  readonly start: number;
  readonly end: number;
} {
  const start = timeOf(event.start);
  // Zero-length events still need a little room.
  return { start, end: Math.max(timeOf(event.end), start + 1) };
}

/** True if the event overlaps the local day. */
export function onDay(event: CalendarEvent, day: Date): boolean {
  const { start, end } = spanOf(event);
  return start < addDays(day, 1).getTime() && end > day.getTime();
}
