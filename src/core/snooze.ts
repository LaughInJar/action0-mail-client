/**
 * Snooze: the times offered, and when snoozed mail is due back. Providers
 * keep the time on each message (see `MailProvider.snooze`).
 */

/** A time Snooze offers. */
export interface SnoozePreset {
  readonly kind: "later-today" | "tomorrow-morning" | "weekend" | "next-week";
  readonly at: Date;
}

/** "Later today" is this much later, on the hour. */
const LATER_HOURS = 3;
/** After this hour there's no "Later today". */
const LAST_LATER_HOUR = 18;
const MORNING = 8;

const at = (day: Date, hour: number, offsetDays = 0) => {
  const result = new Date(day);
  result.setDate(result.getDate() + offsetDays);
  result.setHours(hour, 0, 0, 0);
  return result;
};

/**
 * The times Snooze offers on `now`'s day, in local time: later today (in
 * three hours, before 18:00), tomorrow morning, this weekend (Saturday
 * morning, on weekdays) and next week (Monday morning).
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const presets: SnoozePreset[] = [];
  if (now.getHours() < LAST_LATER_HOUR) {
    const later = new Date(now);
    later.setHours(now.getHours() + LATER_HOURS, 0, 0, 0);
    presets.push({ kind: "later-today", at: later });
  }
  presets.push({ kind: "tomorrow-morning", at: at(now, MORNING, 1) });
  const weekday = now.getDay();
  // Monday to Friday: Saturday morning.
  if (weekday >= 1 && weekday <= 5)
    presets.push({ kind: "weekend", at: at(now, MORNING, 6 - weekday) });
  // The coming Monday (a week from today on Mondays).
  presets.push({
    kind: "next-week",
    at: at(now, MORNING, (8 - weekday) % 7 || 7),
  });
  // One entry per time (on Sundays next week is tomorrow; on Fridays the weekend is).
  return presets.filter(
    (preset, index) =>
      presets.findIndex(
        (other) => other.at.getTime() === preset.at.getTime(),
      ) === index,
  );
}

/** Whether snoozed mail is due back at `now`. */
export function isDueBack(snoozedUntil: string, now: number): boolean {
  return Date.parse(snoozedUntil) <= now;
}
