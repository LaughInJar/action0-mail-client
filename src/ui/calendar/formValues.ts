import {
  timeOf,
  type EventChanges,
  type EventDraft,
  type EventTime,
  type Repeat,
} from "../../core/calendar";
import type { EmailAddress } from "../../core/model";
import type { PlacedEvent } from "../../data/calendar";
import { localZone } from "../../core/timeZones";
import type { EventFormValues } from "../../state/eventForm";
import { addDays, dayKey, parseDay } from "./dates";

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" of a local time. */
export function clockOf(time: Date): string {
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** A local "YYYY-MM-DDTHH:MM" (what new-event routes carry). */
export function localStamp(time: Date): string {
  return `${dayKey(time)}T${clockOf(time)}`;
}

/** The local time of "YYYY-MM-DD" and "HH:MM". */
export function localTime(day: string, clock: string): Date {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number);
  const time = parseDay(day);
  time.setHours(hours, minutes, 0, 0);
  return time;
}

/** Start and end in epoch ms of what the form says (all-day: whole local days). */
export function spanOfValues(values: EventFormValues): {
  readonly start: number;
  readonly end: number;
} {
  if (values.allDay)
    return {
      start: parseDay(values.startDate).getTime(),
      end: addDays(parseDay(values.endDate), 1).getTime(),
    };
  return {
    start: localTime(values.startDate, values.startTime).getTime(),
    end: localTime(values.endDate, values.endTime).getTime(),
  };
}

/** True if the form's event ends before (or when) it starts. */
export function endsBeforeStart(values: EventFormValues): boolean {
  const { start, end } = spanOfValues(values);
  return values.allDay ? end <= start : end < start;
}

/**
 * The form of a new event from a route's suggestion: local
 * "YYYY-MM-DDTHH:MM" times, or "YYYY-MM-DD" days (`to` exclusive).
 */
export function newValues(
  from: string,
  to: string,
  calendar: string,
): EventFormValues {
  const allDay = !from.includes("T");
  const [startDate = from, startTime = "09:00"] = from.split("T");
  const [toDate = to, endTime = "10:00"] = to.split("T");
  const endDate = allDay ? dayKey(addDays(parseDay(toDate), -1)) : toDate;
  return {
    calendar,
    title: "",
    allDay,
    startDate,
    startTime: allDay ? "09:00" : startTime,
    endDate: endDate < startDate ? startDate : endDate,
    endTime: allDay ? "10:00" : endTime,
    location: "",
    descriptionHtml: "",
    guests: [],
    videoCall: false,
    repeat: "none",
    until: "",
  };
}

/** The suggested time of a new event without one: the next half hour on `day` (today), else 9:00. */
export function suggestedTime(
  day: Date,
  now: Date,
): { readonly from: string; readonly to: string } {
  const start =
    dayKey(day) === dayKey(now)
      ? new Date(Math.ceil(now.getTime() / (30 * 60_000)) * 30 * 60_000)
      : localTime(dayKey(day), "09:00");
  return {
    from: localStamp(start),
    to: localStamp(new Date(start.getTime() + 60 * 60_000)),
  };
}

/** The form of an existing event (in the browser's time zone). */
export function valuesOf(draft: EventDraft, calendar: string): EventFormValues {
  const allDay = "date" in draft.start;
  const start = new Date(timeOf(draft.start));
  const end = new Date(timeOf(draft.end));
  const lastDay = allDay ? addDays(end, -1) : end;
  const repeat = draft.repeat;
  return {
    calendar,
    title: draft.title,
    allDay,
    startDate: dayKey(start),
    startTime: allDay ? "09:00" : clockOf(start),
    endDate: dayKey(lastDay < start ? start : lastDay),
    endTime: allDay ? "10:00" : clockOf(end),
    location: draft.location,
    descriptionHtml: draft.descriptionHtml,
    guests: draft.guests,
    videoCall: draft.videoCall,
    repeat: repeat?.kind ?? "none",
    until: repeat && repeat.kind !== "custom" ? (repeat.until ?? "") : "",
  };
}

/** The {@link Repeat} the form asks for. */
function repeatOf(values: EventFormValues): Repeat | null {
  if (values.repeat === "none") return null;
  if (values.repeat === "custom") return { kind: "custom" };
  return {
    kind: values.repeat,
    ...(values.until ? { until: values.until } : {}),
  };
}

/**
 * What the form describes. Timed events are planned in `zone` (an edited
 * event keeps its own; new ones get the browser's).
 */
export function draftOf(
  values: EventFormValues,
  calendarId: EventDraft["calendarId"],
  zone: string = localZone(),
): EventDraft {
  const { start, end } = spanOfValues(values);
  const time = (instant: number, day: string): EventTime =>
    values.allDay
      ? { date: day }
      : { dateTime: new Date(instant).toISOString(), timeZone: zone };
  return {
    calendarId,
    title: values.title.trim(),
    start: time(start, values.startDate),
    end: time(end, dayKey(addDays(parseDay(values.endDate), 1))),
    location: values.location.trim(),
    descriptionHtml: values.descriptionHtml,
    guests: values.guests,
    videoCall: values.videoCall,
    repeat: repeatOf(values),
  };
}

const sameTime = (a: EventTime, b: EventTime) =>
  "date" in a === "date" in b && timeOf(a) === timeOf(b);

const addressesOf = (guests: readonly EmailAddress[]) =>
  guests
    .map((guest) => guest.address.toLowerCase())
    .sort()
    .join("\n");

const sameRepeat = (a: Repeat | null, b: Repeat | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** What changed between an event as it was and as the editor has it. */
export function changesOf(before: EventDraft, after: EventDraft): EventChanges {
  return {
    ...(after.title !== before.title ? { title: after.title } : {}),
    ...(!sameTime(after.start, before.start) || !sameTime(after.end, before.end)
      ? { start: after.start, end: after.end }
      : {}),
    ...(after.location !== before.location ? { location: after.location } : {}),
    ...(after.descriptionHtml !== before.descriptionHtml
      ? { descriptionHtml: after.descriptionHtml }
      : {}),
    ...(addressesOf(after.guests) !== addressesOf(before.guests)
      ? { guests: after.guests }
      : {}),
    ...(after.videoCall !== before.videoCall
      ? { videoCall: after.videoCall }
      : {}),
    ...(!sameRepeat(after.repeat, before.repeat)
      ? { repeat: after.repeat }
      : {}),
  };
}

/**
 * The form after its start changed: the end moves along, so the event
 * keeps its length.
 */
export function withStart(
  values: EventFormValues,
  startDate: string,
  startTime: string,
): EventFormValues {
  const before = spanOfValues(values);
  const length = Math.max(0, before.end - before.start);
  if (values.allDay) {
    const days = Math.round(length / (24 * 60 * 60_000)) - 1;
    return {
      ...values,
      startDate,
      endDate: dayKey(addDays(parseDay(startDate), Math.max(0, days))),
    };
  }
  const start = localTime(startDate, startTime);
  const end = new Date(start.getTime() + length);
  return {
    ...values,
    startDate,
    startTime,
    endDate: dayKey(end),
    endTime: clockOf(end),
  };
}

/** What the editor is for: a new event (with a suggested time), or an existing one. */
export type EditorMode =
  | { readonly kind: "new"; readonly from: string; readonly to: string }
  | { readonly kind: "edit"; readonly placed: PlacedEvent };

/** Key of the editor's values in the UI store. */
export function formKeyOf(mode: EditorMode): string {
  return mode.kind === "new"
    ? "new"
    : JSON.stringify([mode.placed.source.key, mode.placed.event.id]);
}
