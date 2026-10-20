import {
  skipToken,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useAccounts, useAuthStatus } from "../accounts/context";
import type { AuthSession } from "../auth/types";
import type {
  Calendar,
  CalendarAccess,
  CalendarEvent,
  CalendarProvider,
  DateRange,
  IcsSubscription,
  Rsvp,
} from "../core/calendar";
import type { AccountId } from "../core/ids";
import { useUi } from "../state/context";
import { queryKeys } from "./keys";

/** Creates the provider of an iCal subscription (wired up in `src/app`). */
export type IcsFactory = (subscription: IcsSubscription) => CalendarProvider;

/** The {@link IcsFactory}; without one, iCal subscriptions don't load. */
export const IcsFactoryContext = createContext<IcsFactory | null>(null);

/** Where calendars come from: an account, or an iCal subscription. */
export interface CalendarSource {
  /** The account id, or `ics:<subscription id>`. */
  readonly key: string;
  readonly kind: "account" | "ics";
  /** The account's address, or the subscription's name. */
  readonly label: string;
  readonly provider: CalendarProvider;
  readonly accountId?: AccountId;
  /** The account's session (account sources). */
  readonly auth?: AuthSession;
  readonly subscription?: IcsSubscription;
}

/** An event with where it comes from. */
export interface PlacedEvent {
  readonly source: CalendarSource;
  readonly calendar: Calendar;
  readonly event: CalendarEvent;
}

/** One provider per subscription (address, name, colour), per factory. */
const icsProviders = new WeakMap<IcsFactory, Map<string, CalendarProvider>>();

/** Calendar sources: every account with calendars, then iCal subscriptions. */
export function useCalendarSources(): readonly CalendarSource[] {
  const accounts = useAccounts();
  const subscriptions = useUi((state) => state.settings.icsCalendars);
  const factory = useContext(IcsFactoryContext);
  return useMemo(() => {
    const icsSources = factory
      ? subscriptions.map((subscription): CalendarSource => {
          const cacheKey = `${subscription.id}\n${subscription.url}\n${subscription.name}\n${subscription.color}`;
          const cache =
            icsProviders.get(factory) ?? new Map<string, CalendarProvider>();
          icsProviders.set(factory, cache);
          let provider = cache.get(cacheKey);
          if (!provider) {
            provider = factory(subscription);
            cache.set(cacheKey, provider);
          }
          return {
            key: `ics:${subscription.id}`,
            kind: "ics",
            label: subscription.name,
            provider,
            subscription,
          };
        })
      : [];
    return [
      ...accounts.flatMap((handle): CalendarSource[] =>
        handle.calendar
          ? [
              {
                key: handle.account.id,
                kind: "account",
                label: handle.account.email,
                provider: handle.calendar,
                accountId: handle.account.id,
                auth: handle.auth,
              },
            ]
          : [],
      ),
      ...icsSources,
    ];
  }, [accounts, subscriptions, factory]);
}

const noSubscription = () => () => undefined;

/** Whether a source can load: signed in, and calendar access granted. */
export function useSourceState(source: CalendarSource | undefined): {
  readonly ready: boolean;
  readonly access: CalendarAccess;
} {
  const status = useAuthStatus(source?.auth);
  const access = useSyncExternalStore(
    source?.provider.subscribe ?? noSubscription,
    () => source?.provider.access() ?? "granted",
  );
  const signedIn = source?.auth === undefined || status === "signed-in";
  return {
    ready: source !== undefined && signedIn && access === "granted",
    access,
  };
}

/** The calendars of a source. */
export function useCalendarList(source: CalendarSource) {
  const { ready } = useSourceState(source);
  return useQuery({
    queryKey: queryKeys.calendars(source.key),
    queryFn: ready
      ? ({ signal }) => source.provider.listCalendars(signal)
      : skipToken,
    staleTime: 5 * 60_000,
    meta: { persist: true },
  });
}

/** Whether a calendar is ticked: the user's choice, else its default. */
export function isShown(
  choices: Readonly<Record<string, boolean>>,
  source: CalendarSource,
  calendar: Calendar,
): boolean {
  return choices[choiceKey(source, calendar)] ?? calendar.shownByDefault;
}

/** Key of a calendar in the settings' `calendarChoices`. */
export function choiceKey(source: CalendarSource, calendar: Calendar): string {
  return `${source.key}|${calendar.id}`;
}

/** Refresh interval of events: iCal files change rarely. */
const refreshMs = (source: CalendarSource) =>
  source.kind === "ics" ? 15 * 60_000 : 5 * 60_000;

/**
 * Events of the given calendars of a source in a range: one query per
 * calendar, so ticking another one only loads that one.
 */
export function useSourceEvents(
  source: CalendarSource,
  calendars: readonly Calendar[],
  range: DateRange,
) {
  const { ready } = useSourceState(source);
  return useQueries({
    queries: calendars.map((calendar) => ({
      queryKey: queryKeys.events(source.key, calendar.id, range),
      queryFn: ready
        ? ({ signal }: { signal: AbortSignal }) =>
            source.provider.listEvents([calendar.id], range, signal)
        : skipToken,
      staleTime: 60_000,
      refetchInterval: refreshMs(source),
      meta: { persist: true },
    })),
    combine: (results) => ({
      events: results.flatMap((result, index) => {
        const calendar = calendars[index];
        return calendar
          ? (result.data ?? []).map((event): PlacedEvent => ({
              source,
              calendar,
              event,
            }))
          : [];
      }),
      pending: results.some((result) => result.isPending && ready),
      error: results.find((result) => result.error)?.error ?? null,
    }),
  });
}

/** The event an invitation mail is about, from the account's calendar. */
export function useInvitation(
  source: CalendarSource | undefined,
  uid: string | undefined,
) {
  const { ready } = useSourceState(source);
  return useQuery({
    queryKey: queryKeys.invitation(
      (source?.accountId ?? "") as AccountId,
      uid ?? "",
    ),
    queryFn:
      source && uid && ready
        ? ({ signal }) =>
            source.provider
              .findInvitation(uid, signal)
              .then((event) => event ?? null)
        : skipToken,
    staleTime: 60_000,
  });
}

/** Variables of {@link useRespond}. */
export interface RespondVariables {
  readonly source: CalendarSource;
  readonly event: CalendarEvent;
  readonly response: Rsvp;
}

/** Sets an answer on every cached copy of the event (lists and invitation lookups). */
function patchEvent(
  queryClient: QueryClient,
  source: CalendarSource,
  event: CalendarEvent,
  change: (cached: CalendarEvent) => CalendarEvent,
) {
  const same = (cached: CalendarEvent) =>
    cached.id === event.id ||
    (event.uid !== undefined && !event.recurring && cached.uid === event.uid);
  queryClient.setQueriesData<readonly CalendarEvent[]>(
    { queryKey: queryKeys.calendarEvents(source.key) },
    (events) =>
      events?.map((cached) => (same(cached) ? change(cached) : cached)),
  );
  if (source.accountId && event.uid)
    queryClient.setQueryData<CalendarEvent | null>(
      queryKeys.invitation(source.accountId, event.uid),
      (cached) => (cached && same(cached) ? change(cached) : cached),
    );
}

/**
 * Answers an invitation, optimistically: every cached copy shows the new
 * answer at once and goes back if the provider refuses.
 */
export function useRespond() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, event, response }: RespondVariables) =>
      source.provider.respond(event, response),
    onMutate: async ({ source, event, response }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.calendarSource(source.key),
      });
      const before = event.myResponse;
      patchEvent(queryClient, source, event, (cached) =>
        withAnswer(cached, response),
      );
      return { before };
    },
    onError: (_error, { source, event }, context) => {
      const before = context?.before;
      patchEvent(queryClient, source, event, (cached) =>
        before === undefined ? cached : withAnswer(cached, before),
      );
    },
    onSuccess: (updated, { source, event }) => {
      patchEvent(queryClient, source, event, (cached) => ({
        ...cached,
        ...(updated.myResponse ? { myResponse: updated.myResponse } : {}),
        attendees: updated.attendees,
      }));
    },
  });
}

function withAnswer(
  event: CalendarEvent,
  response: NonNullable<CalendarEvent["myResponse"]>,
): CalendarEvent {
  return { ...event, myResponse: response };
}

/** What a source can do right now. */
export interface SourceStatus {
  readonly source: CalendarSource;
  /** Signed in (or no sign-in needed). */
  readonly signedIn: boolean;
  readonly access: CalendarAccess;
  /** Its calendars, once loaded. */
  readonly calendars: readonly Calendar[] | undefined;
  /** Why its calendars or events didn't load. */
  readonly error: unknown;
  readonly pending: boolean;
}

/** All sources' sign-in and access state, as one snapshot. */
function useSourceStates(
  sources: readonly CalendarSource[],
): readonly { signedIn: boolean; access: CalendarAccess }[] {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const unsubscribes = sources.flatMap((source) => [
        source.provider.subscribe(listener),
        ...(source.auth ? [source.auth.subscribe(listener)] : []),
      ]);
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [sources],
  );
  const signature = useSyncExternalStore(subscribe, () =>
    sources
      .map(
        (source) =>
          `${source.auth === undefined || source.auth.status === "signed-in" ? "1" : "0"}${source.provider.access()}`,
      )
      .join(","),
  );
  return useMemo(
    () =>
      signature
        .split(",")
        .filter(Boolean)
        .map((entry) => ({
          signedIn: entry.startsWith("1"),
          access: entry.slice(1) as CalendarAccess,
        })),
    [signature],
  );
}

/**
 * Everything the calendar shows for a range: each source's state and
 * calendars, and the events of the ticked calendars.
 */
export function useCalendarData(range: DateRange) {
  const sources = useCalendarSources();
  const states = useSourceStates(sources);
  const choices = useUi((state) => state.settings.calendarChoices);
  const ready = (index: number) =>
    states[index]?.signedIn === true && states[index].access === "granted";

  const lists = useQueries({
    queries: sources.map((source, index) => ({
      queryKey: queryKeys.calendars(source.key),
      queryFn: ready(index)
        ? ({ signal }: { signal: AbortSignal }) =>
            source.provider.listCalendars(signal)
        : skipToken,
      staleTime: 5 * 60_000,
      meta: { persist: true },
    })),
  });

  const shown = sources.flatMap((source, index) =>
    ready(index)
      ? (lists[index]?.data ?? [])
          .filter((calendar) => isShown(choices, source, calendar))
          .map((calendar) => ({ source, calendar }))
      : [],
  );
  const eventQueries = useQueries({
    queries: shown.map(({ source, calendar }) => ({
      queryKey: queryKeys.events(source.key, calendar.id, range),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        source.provider.listEvents([calendar.id], range, signal),
      staleTime: 60_000,
      refetchInterval: refreshMs(source),
      meta: { persist: true },
    })),
  });

  const events: PlacedEvent[] = shown.flatMap(({ source, calendar }, index) =>
    (eventQueries[index]?.data ?? []).map((event) => ({
      source,
      calendar,
      event,
    })),
  );
  const statuses: SourceStatus[] = sources.map((source, index) => {
    const own = shown
      .map((entry, at) => ({ entry, query: eventQueries[at] }))
      .filter(({ entry }) => entry.source === source);
    return {
      source,
      signedIn: states[index]?.signedIn ?? false,
      access: states[index]?.access ?? "granted",
      calendars: lists[index]?.data,
      error:
        lists[index]?.error ??
        own.find(({ query }) => query?.error)?.query?.error ??
        null,
      pending:
        (ready(index) && lists[index]?.isPending === true) ||
        own.some(({ query }) => query?.isPending === true),
    };
  });
  return {
    statuses,
    events,
    pending: statuses.some((status) => status.pending),
  };
}
