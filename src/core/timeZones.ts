/**
 * Wall-clock times in IANA time zones, with nothing but `Intl`: what an
 * instant reads as on a clock somewhere, and which instant a clock time
 * somewhere is.
 */

/** The browser's time zone (IANA), e.g. "Europe/Vienna". */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A clock reading: "YYYY-MM-DD" and "HH:MM:SS". */
export interface WallTime {
  readonly date: string;
  readonly time: string;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(zone, format);
  }
  return format;
}

/** True if `Intl` knows the zone. */
export function isKnownZone(zone: string): boolean {
  try {
    formatIn(zone);
    return true;
  } catch {
    return false;
  }
}

/** What a clock in `zone` shows at `instant` (the browser's zone if `zone` is unknown). */
export function wallTime(instant: number, zone: string): WallTime {
  const format = isKnownZone(zone) ? formatIn(zone) : formatIn(localZone());
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(instant))
    parts[part.type] = part.value;
  const get = (type: string) => parts[type] ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

/** Milliseconds `zone` is ahead of UTC at `instant`. */
export function offsetAt(instant: number, zone: string): number {
  const { date, time } = wallTime(instant, zone);
  return asUtc(date, time) - Math.floor(instant / 1000) * 1000;
}

function asUtc(date: string, time: string): number {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hours, minutes, seconds);
}

/**
 * The instant a clock in `zone` shows `date` and `time` ("HH:MM" or
 * "HH:MM:SS"). Times skipped by a DST change resolve to the later side.
 */
export function instantAt(date: string, time: string, zone: string): number {
  const guess = asUtc(date, time);
  const first = guess - offsetAt(guess, zone);
  const second = guess - offsetAt(first, zone);
  return Math.max(first, second);
}
