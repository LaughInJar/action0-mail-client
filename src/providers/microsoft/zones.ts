import { isKnownZone, localZone, wallTime } from "../../core/timeZones";

/** Windows name → IANA zones, once {@link loadZones} loaded them. */
let WINDOWS_ZONES: Readonly<Record<string, string>> = {};
/** IANA zone → Windows name. */
let windowsByIana = new Map<string, string>();
let loading: Promise<void> | undefined;

/**
 * Loads the table of Windows zone names (kept out of the main bundle).
 * The functions here need it; until then they only know IANA zones.
 */
export function loadZones(): Promise<void> {
  loading ??= import("./windowsZones").then((module) => {
    WINDOWS_ZONES = module.WINDOWS_ZONES;
    windowsByIana = new Map();
    for (const [windows, ianas] of Object.entries(WINDOWS_ZONES))
      for (const iana of ianas.split(" "))
        if (!windowsByIana.has(iana)) windowsByIana.set(iana, windows);
  });
  return loading;
}

/**
 * The IANA zone of a zone name Graph uses (a Windows name like "W. Europe
 * Standard Time", or an IANA name); undefined if it's neither.
 */
export function ianaZone(name: string): string | undefined {
  const windows = WINDOWS_ZONES[name];
  if (windows !== undefined) return windows.split(" ")[0];
  return isKnownZone(name) && name.includes("/") ? name : undefined;
}

/** UTC offsets of a zone at a few moments of the year, as a fingerprint. */
function offsets(zone: string, year: number): string {
  return [0, 3, 6, 9]
    .map((month) => {
      const instant = Date.UTC(year, month, 15, 12);
      const { date, time } = wallTime(instant, zone);
      return Date.parse(`${date}T${time}Z`) - instant;
    })
    .join();
}

/**
 * The Windows name for an IANA zone, which every Graph mailbox accepts.
 * Zones CLDR doesn't list (newer names such as "Asia/Kolkata") get the
 * Windows zone that keeps the same clock all year; "UTC" if none does.
 */
export function windowsZone(iana: string): string {
  const known = windowsByIana.get(iana);
  if (known !== undefined) return known;
  if (!isKnownZone(iana)) return "UTC";
  const year = new Date().getUTCFullYear();
  const wanted = offsets(iana, year);
  for (const [windows, ianas] of Object.entries(WINDOWS_ZONES)) {
    const representative = ianas.split(" ")[0] ?? "";
    if (isKnownZone(representative) && offsets(representative, year) === wanted)
      return windows;
  }
  return "UTC";
}

/** The browser's zone, if `zone` isn't one action0 can compute with. */
export function usableZone(zone: string | undefined): string {
  return (zone !== undefined && ianaZone(zone)) || localZone();
}
