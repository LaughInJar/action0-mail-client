import {
  skipToken,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useMemo } from "react";
import {
  asEventId,
  timeOf,
  type Calendar,
  type CalendarEvent,
  type EventChanges,
  type EventDraft,
  type EventTime,
  type SeriesScope,
  type WriteOptions,
} from "../core/calendar";
import { useUi } from "../state/context";
import type { CalendarSource, PlacedEvent, SourceStatus } from "./calendar";
import { queryKeys } from "./keys";

/** True if the event is yours to change, in a calendar that can be changed. */
export function canChange(placed: PlacedEvent): boolean {
  return (
    placed.source.provider.canEdit &&
    !placed.calendar.readOnly &&
    placed.event.organizedByMe
  );
}

/** True if the event has guests besides you (they'd hear about changes). */
export function hasGuests(event: {
  readonly attendees: CalendarEvent["attendees"];
  readonly organizer?: CalendarEvent["organizer"];
}): boolean {
  const organizer = event.organizer?.address.toLowerCase();
  return event.attendees.some(
    (attendee) =>
      !attendee.resource &&
      attendee.address.address.toLowerCase() !== organizer,
  );
}

/** An event, read fresh for the editor. */
export function useEventForEdit(placed: PlacedEvent | undefined) {
  return useQuery({
    queryKey: queryKeys.eventForEdit(
      placed?.source.key ?? "",
      placed?.event.id ?? "",
    ),
    queryFn: placed
      ? ({ signal }) => placed.source.provider.loadForEdit(placed.event, signal)
      : skipToken,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** A calendar new events can go into. */
export interface WritableCalendar {
  readonly source: CalendarSource;
  readonly calendar: Calendar;
}

/** Every calendar you can create events in, account by account. */
export function writableCalendars(
  statuses: readonly SourceStatus[],
): readonly WritableCalendar[] {
  return statuses.flatMap(({ source, signedIn, access, calendars }) =>
    source.provider.canEdit && signedIn && access === "granted"
      ? (calendars ?? [])
          .filter((calendar) => !calendar.readOnly)
          .map((calendar) => ({ source, calendar }))
      : [],
  );
}

/** The calendar new events go into: the one used last, else the first primary one. */
export function useDefaultCalendar(
  calendars: readonly WritableCalendar[],
): WritableCalendar | undefined {
  const last = useUi((state) => state.settings.lastEventCalendar);
  return (
    calendars.find(
      ({ source, calendar }) => `${source.key}|${calendar.id}` === last,
    ) ??
    calendars.find(({ calendar }) => calendar.primary) ??
    calendars[0]
  );
}

type Lists = [QueryKey, readonly CalendarEvent[] | undefined][];

/** The cached event lists of a source. */
function listsOf(queryClient: QueryClient, source: CalendarSource): Lists {
  return queryClient.getQueriesData<readonly CalendarEvent[]>({
    queryKey: queryKeys.calendarEvents(source.key),
  });
}

/** Calendar id and range of an event list's key. */
function listOf(
  key: QueryKey,
  source: CalendarSource,
): { calendarId: unknown; from: number; to: number } {
  const at = queryKeys.calendarEvents(source.key).length;
  return {
    calendarId: key[at],
    from: Date.parse(String(key[at + 1])),
    to: Date.parse(String(key[at + 2])),
  };
}

/** Moves an event time by `ms` (all-day ones by whole days). */
function shiftTime(time: EventTime, ms: number): EventTime {
  if ("date" in time) {
    const days = Math.round(ms / (24 * 60 * 60 * 1000));
    const [y = 1970, m = 1, d = 1] = time.date.split("-").map(Number);
    const day = new Date(y, m - 1, d + days);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      date: `${String(day.getFullYear())}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
    };
  }
  return {
    ...time,
    dateTime: new Date(Date.parse(time.dateTime) + ms).toISOString(),
  };
}

/** Whether a cached occurrence is touched by a change of `event` with `scope`. */
function affects(
  cached: CalendarEvent,
  event: CalendarEvent,
  scope: SeriesScope,
): boolean {
  if (cached.id === event.id) return true;
  if (scope === "this" || event.seriesId === undefined) return false;
  if (cached.seriesId !== event.seriesId) return false;
  return scope === "all" || timeOf(cached.start) >= timeOf(event.start);
}

/** An occurrence with the changes made to `event` (others of its series move as much). */
function changed(
  cached: CalendarEvent,
  event: CalendarEvent,
  changes: EventChanges,
): CalendarEvent {
  const same = cached.id === event.id;
  const startShift = changes.start
    ? timeOf(changes.start) - timeOf(event.start)
    : 0;
  const endShift = changes.end ? timeOf(changes.end) - timeOf(event.end) : 0;
  const kindChanged =
    changes.start !== undefined &&
    "date" in changes.start !== "date" in cached.start;
  const { location, description, ...rest } = cached;
  const place =
    changes.location === undefined ? location : changes.location || undefined;
  const text =
    changes.descriptionHtml === undefined
      ? description
      : changes.descriptionHtml
        ? { html: changes.descriptionHtml }
        : undefined;
  return {
    ...rest,
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    start:
      same || kindChanged
        ? (changes.start ?? cached.start)
        : shiftTime(cached.start, startShift),
    end:
      same || kindChanged
        ? (changes.end ?? cached.end)
        : shiftTime(cached.end, endShift),
    ...(place ? { location: place } : {}),
    ...(text ? { description: text } : {}),
    ...(changes.reminders !== undefined
      ? { reminders: changes.reminders }
      : {}),
    ...(changes.guests !== undefined
      ? {
          attendees: changes.guests.map((address) => ({
            address,
            response:
              cached.attendees.find(
                (attendee) =>
                  attendee.address.address.toLowerCase() ===
                  address.address.toLowerCase(),
              )?.response ?? "needsAction",
          })),
        }
      : {}),
  };
}

/** A provisional event for a draft (until the provider has the real one). */
function provisional(draft: EventDraft): CalendarEvent {
  return {
    id: asEventId(`pending:${crypto.randomUUID()}`),
    calendarId: draft.calendarId,
    title: draft.title,
    start: draft.start,
    end: draft.end,
    ...(draft.location ? { location: draft.location } : {}),
    ...(draft.descriptionHtml
      ? { description: { html: draft.descriptionHtml } }
      : {}),
    attendees: draft.guests.map((address) => ({
      address,
      response: "needsAction",
    })),
    status: "confirmed",
    recurring: draft.repeat !== null,
    organizedByMe: true,
    ...(draft.reminders.length > 0 ? { reminders: draft.reminders } : {}),
  };
}

/** Puts an event into the cached lists of its calendar whose range it overlaps. */
function insert(
  queryClient: QueryClient,
  source: CalendarSource,
  event: CalendarEvent,
) {
  for (const [key, events] of listsOf(queryClient, source)) {
    const { calendarId, from, to } = listOf(key, source);
    if (calendarId !== event.calendarId || !events) continue;
    if (timeOf(event.start) >= to || timeOf(event.end) <= from) continue;
    queryClient.setQueryData(key, [...events, event]);
  }
}

/** Changes the cached lists of a source. */
function edit(
  queryClient: QueryClient,
  source: CalendarSource,
  change: (events: readonly CalendarEvent[]) => readonly CalendarEvent[],
) {
  for (const [key, events] of listsOf(queryClient, source))
    if (events) queryClient.setQueryData(key, change(events));
}

/** The values a change replaced, as changes that put them back. */
function inverse(event: CalendarEvent, changes: EventChanges): EventChanges {
  return {
    ...(changes.title !== undefined ? { title: event.title } : {}),
    ...(changes.start !== undefined ? { start: event.start } : {}),
    ...(changes.end !== undefined ? { end: event.end } : {}),
    ...(changes.location !== undefined
      ? { location: event.location ?? "" }
      : {}),
    ...(changes.descriptionHtml !== undefined
      ? { descriptionHtml: event.description?.html ?? "" }
      : {}),
    ...(changes.reminders !== undefined
      ? { reminders: event.reminders ?? [] }
      : {}),
    ...(changes.guests !== undefined
      ? {
          guests: event.attendees
            .filter((attendee) => !attendee.resource)
            .map((attendee) => attendee.address),
        }
      : {}),
  };
}

/** A change made through {@link useEventWrites}, with its undo. */
export interface EventEdit {
  /** Takes the change back: at once in the calendar, then at the provider. */
  readonly undo: (options: WriteOptions) => Promise<void>;
}

/**
 * Creates, changes and deletes events, optimistically: the calendar shows
 * the change at once, goes back if the provider refuses it, and reloads
 * the source's events afterwards. Undo works the same way.
 */
export function useEventWrites() {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const begin = async (source: CalendarSource) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.calendarEvents(source.key),
      });
      return listsOf(queryClient, source);
    };
    const rollback = (lists: Lists) => {
      for (const [key, events] of lists) queryClient.setQueryData(key, events);
    };
    const reload = (source: CalendarSource) =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.calendarSource(source.key),
      });
    /** Runs a provider call after an optimistic change; rolls back on failure. */
    const run = async <T>(
      source: CalendarSource,
      lists: Lists,
      call: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        rollback(lists);
        throw error;
      } finally {
        void reload(source);
      }
    };

    return {
      create: async (
        source: CalendarSource,
        draft: EventDraft,
        options: WriteOptions,
      ): Promise<EventEdit & { readonly event: CalendarEvent }> => {
        const lists = await begin(source);
        const pending = provisional(draft);
        insert(queryClient, source, pending);
        const result = await run(source, lists, () =>
          source.provider.createEvent(draft, options),
        );
        edit(queryClient, source, (events) =>
          events.map((event) =>
            event.id === pending.id ? result.event : event,
          ),
        );
        return {
          event: result.event,
          undo: async (undoOptions) => {
            const before = await begin(source);
            edit(queryClient, source, (events) =>
              events.filter(
                (event) =>
                  event.id !== result.event.id &&
                  (result.event.seriesId === undefined ||
                    event.seriesId !== result.event.seriesId),
              ),
            );
            await run(source, before, () => result.undo(undoOptions));
          },
        };
      },

      update: async (
        placed: PlacedEvent,
        changes: EventChanges,
        scope: SeriesScope,
        options: WriteOptions,
      ): Promise<EventEdit> => {
        const { source, event } = placed;
        const lists = await begin(source);
        edit(queryClient, source, (events) =>
          events.map((cached) =>
            affects(cached, event, scope)
              ? changed(cached, event, changes)
              : cached,
          ),
        );
        const result = await run(source, lists, () =>
          source.provider.updateEvent(event, changes, scope, options),
        );
        const now = changed(event, event, changes);
        const back = inverse(event, changes);
        return {
          undo: async (undoOptions) => {
            const before = await begin(source);
            edit(queryClient, source, (events) =>
              events.map((cached) =>
                affects(cached, now, scope)
                  ? changed(cached, now, back)
                  : cached,
              ),
            );
            await run(source, before, () => result.undo(undoOptions));
          },
        };
      },

      remove: async (
        placed: PlacedEvent,
        scope: SeriesScope,
        options: WriteOptions,
      ): Promise<EventEdit> => {
        const { source, event } = placed;
        const lists = await begin(source);
        edit(queryClient, source, (events) =>
          events.filter((cached) => !affects(cached, event, scope)),
        );
        const result = await run(source, lists, () =>
          source.provider.deleteEvent(event, scope, options),
        );
        return {
          undo: async (undoOptions) => {
            const before = await begin(source);
            // The deleted occurrences come back where they were.
            const gone = new Map(
              lists.map(([key, events]) => [
                JSON.stringify(key),
                (events ?? []).filter((cached) =>
                  affects(cached, event, scope),
                ),
              ]),
            );
            for (const [key, events] of before)
              if (events)
                queryClient.setQueryData(key, [
                  ...events,
                  ...(gone.get(JSON.stringify(key)) ?? []),
                ]);
            await run(source, before, () => result.undo(undoOptions));
          },
        };
      },
    };
  }, [queryClient]);
}
