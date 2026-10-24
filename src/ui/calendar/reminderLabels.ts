import type { I18n } from "../../i18n/context";

/** Reminders offered for timed events (minutes before). */
export const TIMED_REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880];

/**
 * Reminders offered for all-day events (minutes before midnight): on the
 * day, the day before at 9:00 and at 17:00, a week before at 9:00.
 */
export const ALL_DAY_REMINDERS = [0, 900, 420, 9540];

/** "15 minutes before", or for all-day events "The day before at 9:00". */
export function reminderLabel(
  minutes: number,
  allDay: boolean,
  t: I18n,
): string {
  const r = t.calendar.reminders;
  if (allDay) {
    if (minutes <= 0) return r.onTheDay;
    const days = Math.ceil(minutes / 1440);
    const at = new Date(2000, 0, 1, 0, days * 1440 - minutes);
    const time = new Intl.DateTimeFormat(t.locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
    if (days === 1) return r.dayBeforeAt(time);
    if (days === 7) return r.weekBeforeAt(time);
    return r.daysBeforeAt(days, time);
  }
  if (minutes <= 0) return r.atStart;
  if (minutes % 1440 === 0) return r.daysBefore(minutes / 1440);
  if (minutes % 60 === 0) return r.hoursBefore(minutes / 60);
  return r.minutesBefore(minutes);
}

/** The choices for a reminder: the presets, and its own value if it's another. */
export function reminderChoices(current: number, allDay: boolean): number[] {
  const presets = allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
  return presets.includes(current)
    ? presets
    : [...presets, current].sort((a, b) => a - b);
}
