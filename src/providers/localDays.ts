/**
 * Whole days in the browser's time zone ("YYYY-MM-DD") and the instants
 * providers store for them, for automatic replies' first and last day.
 */

/** Local midnight at the start of `day`, in ms. */
export function startOfDay(day: string): number {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

/** Local midnight after `day` (the first moment not in it), in ms. */
export function endOfDay(day: string): number {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date + 1).getTime();
}

/** The local day of an instant. */
export function dayOf(instant: number): string {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The last day of a period ending at `instant`: a local midnight ends the
 * day before it (an exclusive end), any other moment ends its own day.
 */
export function lastDayOf(instant: number): string {
  const date = new Date(instant);
  const midnight =
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0;
  return dayOf(midnight ? instant - 1 : instant);
}
