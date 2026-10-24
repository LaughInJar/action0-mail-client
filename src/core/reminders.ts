/**
 * When event reminders are due: from each event's own reminders (minutes
 * before it starts), or from the provider's list where it keeps them
 * (Outlook), minus what was dismissed or is snoozed.
 */
import { timeOf, type CalendarEvent, type DateRange } from "./calendar";

const MINUTE = 60_000;

/** One reminder of one event (occurrence). */
export interface ReminderTime {
  /** Identifies it for snooze and dismiss marks. */
  readonly key: string;
  /** When it's due (epoch ms). */
  readonly fireAt: number;
  /** Minutes before the start; undefined for the provider's own reminder. */
  readonly minutes?: number;
}

/** What the user did to a reminder. */
export interface ReminderMark {
  readonly dismissed?: true;
  /** Snoozed until then (epoch ms). */
  readonly snoozedUntil?: number;
  /** When the event ends (epoch ms): the mark is forgotten after that. */
  readonly ends: number;
}

/** A reminder that's due, with its event. */
export interface DueReminder<T> {
  readonly key: string;
  readonly fireAt: number;
  readonly item: T;
}

/** The key of a reminder (`minutes` absent: the provider's own one). */
export function reminderKey(
  source: string,
  event: CalendarEvent,
  minutes?: number,
): string {
  return minutes === undefined
    ? `${source}|${event.id}`
    : `${source}|${event.id}|${String(minutes)}`;
}

/** The events' reminders worth showing: not declined, not cancelled, not over. */
function remindable(event: CalendarEvent, now: number): boolean {
  return (
    event.status !== "cancelled" &&
    event.myResponse !== "declined" &&
    timeOf(event.end) > now
  );
}

/** When an event's own reminders are due. */
export function reminderTimes(
  source: string,
  event: CalendarEvent,
): ReminderTime[] {
  const start = timeOf(event.start);
  return [...new Set(event.reminders ?? [])].map((minutes) => ({
    key: reminderKey(source, event, minutes),
    fireAt: start - minutes * MINUTE,
    minutes,
  }));
}

/**
 * The reminders due at `now`, oldest first. Sources whose provider keeps
 * reminders (`synced`: due times by event id, by source) use its list
 * instead of the events'.
 */
export function dueReminders<T extends { readonly event: CalendarEvent }>(
  items: readonly T[],
  sourceOf: (item: T) => string,
  synced: ReadonlyMap<string, ReadonlyMap<string, number>>,
  marks: Readonly<Record<string, ReminderMark>>,
  now: number,
): DueReminder<T>[] {
  const due: DueReminder<T>[] = [];
  for (const item of items) {
    const { event } = item;
    const source = sourceOf(item);
    if (!remindable(event, now)) continue;
    const own = synced.get(source);
    const times: ReminderTime[] = own
      ? [own.get(event.id)]
          .filter((fireAt) => fireAt !== undefined)
          .map((fireAt) => ({ key: reminderKey(source, event), fireAt }))
      : reminderTimes(source, event);
    for (const { key, fireAt } of times) {
      const mark = marks[key];
      if (fireAt > now || mark?.dismissed) continue;
      if (mark?.snoozedUntil !== undefined && mark.snoozedUntil > now) continue;
      due.push({
        key,
        fireAt: Math.max(fireAt, mark?.snoozedUntil ?? 0),
        item,
      });
    }
  }
  return due.sort((a, b) => a.fireAt - b.fireAt);
}

/** Marks of events that are still on. */
export function liveMarks(
  marks: Readonly<Record<string, ReminderMark>>,
  now: number,
): Record<string, ReminderMark> {
  return Object.fromEntries(
    Object.entries(marks).filter(([, mark]) => mark.ends > now),
  );
}

/**
 * Events to look at for reminders: from yesterday (events still on) to
 * nine days ahead (reminders up to a week before), in whole local days so
 * the range only changes once a day.
 */
export function upcomingRange(now: number): DateRange {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setDate(today.getDate() - 1);
  const to = new Date(today);
  to.setDate(today.getDate() + 9);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Rounded minutes until (positive) or since (negative) a moment. */
export function minutesUntil(time: number, now: number): number {
  return Math.round((time - now) / MINUTE);
}
