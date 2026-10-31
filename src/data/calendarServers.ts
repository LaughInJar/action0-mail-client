import { createContext, useContext, useSyncExternalStore } from "react";
import type {
  CalendarServerInfo,
  CalendarServers,
} from "../accounts/calendarServer";
import type { CalendarProvider } from "../core/calendar";

/** Calendar servers (CalDAV) as the calendar sees them: the apps only. */
export interface CalendarServerSources {
  readonly servers: CalendarServers;
  /** The connected servers right now. */
  readonly current: () => readonly CalendarServerInfo[];
  readonly subscribe: (listener: () => void) => () => void;
  /** The calendars of a calendar-only server (one provider per server). */
  readonly providerFor: (info: CalendarServerInfo) => CalendarProvider;
}

/** Provided in the apps (wired in `src/app`); `null` in the web app. */
export const CalendarServersContext =
  createContext<CalendarServerSources | null>(null);

/** The calendar servers, or `null` where there are none (the web app). */
export function useCalendarServers(): CalendarServerSources | null {
  return useContext(CalendarServersContext);
}

const none: readonly CalendarServerInfo[] = [];
const noSubscription = () => () => undefined;

/** The connected calendar servers, kept current. */
export function useCalendarServerList(): readonly CalendarServerInfo[] {
  const sources = useCalendarServers();
  return useSyncExternalStore(
    sources?.subscribe ?? noSubscription,
    () => sources?.current() ?? none,
  );
}
