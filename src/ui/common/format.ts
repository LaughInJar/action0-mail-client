import type { EmailAddress } from "../../core/model";

/** Options for date formatting; tests pin locale and time zone. */
export interface DateFormatOptions {
  readonly now?: Date;
  readonly locale?: string;
  readonly timeZone?: string;
}

function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/**
 * Compact date for list rows: time for today, day and month for this year,
 * the full date for older messages.
 */
export function formatListDate(
  iso: string,
  options: DateFormatOptions = {},
): string {
  const { now = new Date(), locale, timeZone } = options;
  const date = new Date(iso);
  const zone = timeZone ? { timeZone } : {};
  const today = dayKey(now, timeZone);
  const day = dayKey(date, timeZone);

  if (day === today) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      ...zone,
    }).format(date);
  }
  if (day.slice(0, 4) === today.slice(0, 4)) {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      ...zone,
    }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...zone,
  }).format(date);
}

/** Full date and time for the reader. */
export function formatFullDate(
  iso: string,
  options: DateFormatOptions = {},
): string {
  const { locale, timeZone } = options;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** Human-readable file size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? "GB"}`;
}

/** Display name of an address, falling back to the address itself. */
export function displayName(address: EmailAddress | undefined): string {
  if (!address) return "(unknown sender)";
  return address.name?.trim() || address.address;
}

/** Comma-separated display names. */
export function displayNames(addresses: readonly EmailAddress[]): string {
  return addresses.map(displayName).join(", ");
}
