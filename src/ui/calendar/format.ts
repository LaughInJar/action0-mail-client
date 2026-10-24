import { isAllDay, type CalendarEvent } from "../../core/calendar";
import type { PlacedEvent } from "../../data/calendar";
import type { I18n } from "../../i18n/context";
import type { CalendarView } from "../../state/router";
import { addDays, parseDay, spanOf } from "./dates";

/** The route's name for an event (opaque to everything else). */
export function eventKey(placed: PlacedEvent): string {
  return JSON.stringify([placed.source.key, placed.event.id]);
}

/** The event a route names, among the loaded ones. */
export function findEvent(
  events: readonly PlacedEvent[],
  key: string | undefined,
): PlacedEvent | undefined {
  if (key === undefined) return undefined;
  return events.find((placed) => eventKey(placed) === key);
}

/** An event's title, or "(No title)". */
export function titleOf(event: CalendarEvent, t: I18n): string {
  return event.title.trim() || t.calendar.noTitle;
}

/** "09:30" in the interface's locale. */
export function clock(time: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(time);
}

/** "09:30 – 10:00" in the interface's locale. */
export function clockRange(start: number, end: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).formatRange(start, end);
}

/** The last day an all-day event covers (its end is exclusive). */
function lastDay(event: CalendarEvent): Date {
  const end =
    "date" in event.end
      ? parseDay(event.end.date)
      : new Date(spanOf(event).end);
  return addDays(end, -1);
}

/** Short time of an event in a list: "09:30–10:00", "All day", or "Ends 11:00". */
export function shortTime(event: CalendarEvent, t: I18n, day?: Date): string {
  if (isAllDay(event)) return t.calendar.allDay;
  const { start, end } = spanOf(event);
  // Days in the middle of a multi-day event.
  if (day && start < day.getTime() && end > addDays(day, 1).getTime())
    return t.calendar.allDay;
  return clockRange(start, end, t.locale);
}

/** When an event takes place, in full: "Thursday, 22 October 2026, 11:00–12:00". */
export function whenText(event: CalendarEvent, t: I18n): string {
  if (isAllDay(event)) {
    const first =
      "date" in event.start
        ? parseDay(event.start.date)
        : new Date(spanOf(event).start);
    const last = lastDay(event);
    return new Intl.DateTimeFormat(t.locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).formatRange(first, last);
  }
  const { start, end } = spanOf(event);
  return new Intl.DateTimeFormat(t.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatRange(start, end);
}

/** The toolbar's title for what a view shows. */
export function viewTitle(
  view: CalendarView,
  days: { readonly first: Date; readonly end: Date },
  t: I18n,
): string {
  const last = addDays(days.end, -1);
  switch (view) {
    case "day":
      return new Intl.DateTimeFormat(t.locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(days.first);
    case "month": {
      // The month the grid is about (its middle).
      const middle = addDays(days.first, 15);
      return new Intl.DateTimeFormat(t.locale, {
        month: "long",
        year: "numeric",
      }).format(middle);
    }
    case "week":
    case "agenda":
      return new Intl.DateTimeFormat(t.locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).formatRange(days.first, last);
  }
}

/** Style variables of an event in its calendar's colour. */
export function eventColor(placed: PlacedEvent): Record<string, string> {
  return { "--event-color": placed.calendar.color };
}

/** All-day first, then by start time. */
export function dayOrder(a: PlacedEvent, b: PlacedEvent): number {
  return (
    Number(isAllDay(b.event)) - Number(isAllDay(a.event)) ||
    spanOf(a.event).start - spanOf(b.event).start
  );
}
