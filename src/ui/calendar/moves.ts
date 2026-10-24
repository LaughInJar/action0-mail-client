import type { CalendarEvent, EventTime } from "../../core/calendar";
import { addDays, dayKey, parseDay, spanOf } from "./dates";
import type { GridSlot } from "./useGridGestures";
import { snap } from "./useGridGestures";

/** New times for an event. */
export interface EventTimes {
  readonly start: EventTime;
  readonly end: EventTime;
}

/** The local time `minutes` after midnight of `day` (beyond 24 h is the next day). */
export function atMinutes(day: Date, minutes: number): Date {
  const time = new Date(day);
  time.setHours(0, minutes, 0, 0);
  return time;
}

/** A timed event time at `instant`, planned in `zone` (if any). */
function timed(instant: number, zone: string | undefined): EventTime {
  return {
    dateTime: new Date(instant).toISOString(),
    ...(zone ? { timeZone: zone } : {}),
  };
}

const zoneOf = (event: CalendarEvent) =>
  "timeZone" in event.start ? event.start.timeZone : undefined;

/** An event time `days` later, at the same local clock time. */
export function shiftDays(time: EventTime, days: number): EventTime {
  if ("date" in time)
    return { date: dayKey(addDays(parseDay(time.date), days)) };
  const local = new Date(time.dateTime);
  const moved = addDays(local, days);
  moved.setHours(local.getHours(), local.getMinutes(), local.getSeconds(), 0);
  return { ...time, dateTime: moved.toISOString() };
}

/** An event moved by whole days; undefined if it doesn't move. */
export function movedByDays(
  event: CalendarEvent,
  days: number,
): EventTimes | undefined {
  if (days === 0) return undefined;
  return {
    start: shiftDays(event.start, days),
    end: shiftDays(event.end, days),
  };
}

/**
 * A timed event dragged in the time grid from `grab` to `at`: it moves by
 * as many days and minutes, its start on a quarter hour; undefined if it
 * doesn't move.
 */
export function movedInGrid(
  event: CalendarEvent,
  grab: GridSlot,
  at: GridSlot,
): EventTimes | undefined {
  const { start, end } = spanOf(event);
  const from = new Date(start);
  const minutes = snap(
    from.getHours() * 60 + from.getMinutes() + at.minutes - grab.minutes,
  );
  const day = addDays(
    new Date(from.getFullYear(), from.getMonth(), from.getDate()),
    at.day - grab.day,
  );
  const next = atMinutes(day, minutes).getTime();
  if (next === start) return undefined;
  const zone = zoneOf(event);
  return { start: timed(next, zone), end: timed(next + end - start, zone) };
}

/**
 * A timed event whose end was dragged to `at` (a day of the grid starting
 * at `first`): it ends on a quarter hour, at least 15 minutes after it
 * starts; undefined if the end doesn't change.
 */
export function resizedInGrid(
  event: CalendarEvent,
  first: Date,
  at: GridSlot,
): EventTimes | undefined {
  const { start, end } = spanOf(event);
  const next = Math.max(
    start + 15 * 60_000,
    atMinutes(addDays(first, at.day), snap(at.minutes)).getTime(),
  );
  if (next === end) return undefined;
  return { start: event.start, end: timed(next, zoneOf(event)) };
}

/**
 * The range of a new event picked in the time grid of days starting at
 * `first`: a click suggests an hour from the half hour; a drag the quarter
 * hours it went across (on its first day).
 */
export function pickedRange(
  first: Date,
  from: GridSlot,
  to: GridSlot | null,
): { readonly start: Date; readonly end: Date } {
  const day = addDays(first, from.day);
  const across =
    to !== null &&
    (to.day !== from.day || Math.abs(to.minutes - from.minutes) >= 15);
  if (!to || !across) {
    const start = Math.min(Math.floor(from.minutes / 30) * 30, 23 * 60);
    return { start: atMinutes(day, start), end: atMinutes(day, start + 60) };
  }
  const low = Math.min(from.minutes, to.minutes);
  const high = Math.max(from.minutes, to.minutes);
  const start = Math.floor(low / 15) * 15;
  const end = Math.min(
    24 * 60,
    Math.max(start + 15, Math.ceil(high / 15) * 15),
  );
  return { start: atMinutes(day, start), end: atMinutes(day, end) };
}
