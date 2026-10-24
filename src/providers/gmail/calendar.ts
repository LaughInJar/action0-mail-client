import type { ScopedSession } from "../../auth/types";
import {
  asCalendarId,
  asEventId,
  timeOf,
  type Attendee,
  type Calendar,
  type CalendarAccess,
  type CalendarEvent,
  type CalendarId,
  type CalendarProvider,
  type DateRange,
  type EditableEvent,
  type EventChange,
  type EventChanges,
  type EventDraft,
  type EventTime,
  type ResponseStatus,
  type Rsvp,
  type SeriesScope,
  type WriteOptions,
} from "../../core/calendar";
import { isMailError, MailError } from "../../core/errors";
import type { EmailAddress } from "../../core/model";
import {
  moveLike,
  repeatOf,
  retimeRule,
  ruleOf,
  splitRule,
} from "../../core/recurrence";
import { localZone } from "../../core/timeZones";
import type { GmailHttp } from "./http";

/** Base URL of the Google Calendar API. */
export const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/";

/**
 * Calendar access: the list of calendars, and reading and changing events
 * (needed to answer invitations). Asked for on demand, never required.
 */
export const CALENDAR_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

interface GooglePerson {
  readonly email?: string;
  readonly displayName?: string;
  readonly self?: boolean;
}

interface GoogleAttendee extends GooglePerson {
  readonly responseStatus?: string;
  readonly optional?: boolean;
  readonly resource?: boolean;
  readonly organizer?: boolean;
}

interface GoogleTime {
  readonly date?: string;
  readonly dateTime?: string;
  readonly timeZone?: string;
}

interface GoogleConference {
  readonly entryPoints?: readonly {
    readonly entryPointType?: string;
    readonly uri?: string;
  }[];
  readonly createRequest?: unknown;
}

/** The fields of Google's event resource that action0 reads. */
export interface GoogleEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: GoogleTime;
  readonly end?: GoogleTime;
  readonly organizer?: GooglePerson;
  readonly attendees?: readonly GoogleAttendee[];
  readonly recurringEventId?: string;
  readonly originalStartTime?: GoogleTime;
  readonly recurrence?: readonly string[];
  readonly iCalUID?: string;
  readonly htmlLink?: string;
  readonly hangoutLink?: string;
  readonly conferenceData?: GoogleConference;
}

interface GoogleCalendarListEntry {
  readonly id: string;
  readonly summary?: string;
  readonly summaryOverride?: string;
  readonly backgroundColor?: string;
  readonly primary?: boolean;
  readonly selected?: boolean;
  readonly accessRole?: string;
  readonly conferenceProperties?: {
    readonly allowedConferenceSolutionTypes?: readonly string[];
  };
}

interface GooglePage<T> {
  readonly items?: readonly T[];
  readonly nextPageToken?: string;
}

const enc = encodeURIComponent;

/** Event ids are unique per calendar only: `<calendar>/<event>`. */
function eventIdOf(calendarId: string, eventId: string): string {
  return `${enc(calendarId)}/${eventId}`;
}

function splitEventId(id: string): { calendarId: string; eventId: string } {
  const slash = id.indexOf("/");
  return {
    calendarId: decodeURIComponent(id.slice(0, slash)),
    eventId: id.slice(slash + 1),
  };
}

function person(value: GooglePerson | undefined): EmailAddress | undefined {
  if (!value?.email) return undefined;
  const name = value.displayName?.trim();
  return name ? { name, address: value.email } : { address: value.email };
}

function response(value: string | undefined): ResponseStatus {
  return value === "accepted" || value === "tentative" || value === "declined"
    ? value
    : "needsAction";
}

function time(value: GoogleTime | undefined): EventTime {
  if (value?.date) return { date: value.date };
  return {
    dateTime: new Date(value?.dateTime ?? 0).toISOString(),
    ...(value?.timeZone ? { timeZone: value.timeZone } : {}),
  };
}

/** A Google event as a {@link CalendarEvent}. */
export function toCalendarEvent(
  calendarId: string,
  event: GoogleEvent,
): CalendarEvent {
  const attendees: Attendee[] = (event.attendees ?? []).flatMap((attendee) => {
    const address = person(attendee);
    return address
      ? [
          {
            address,
            response: response(attendee.responseStatus),
            ...(attendee.optional ? { optional: true } : {}),
            ...(attendee.resource ? { resource: true } : {}),
          },
        ]
      : [];
  });
  const me = (event.attendees ?? []).find((attendee) => attendee.self);
  const organizer = person(event.organizer);
  const video = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video",
  )?.uri;
  const meetingUrl = video ?? event.hangoutLink;
  const description = event.description?.trim();
  return {
    id: asEventId(eventIdOf(calendarId, event.id)),
    calendarId: asCalendarId(calendarId),
    title: event.summary ?? "",
    start: time(event.start),
    end: time(event.end),
    ...(event.location ? { location: event.location } : {}),
    // Google keeps descriptions as (simple) HTML.
    ...(description ? { description: { html: description } } : {}),
    ...(meetingUrl ? { meetingUrl } : {}),
    ...(organizer ? { organizer } : {}),
    attendees,
    ...(me && !me.organizer && event.organizer?.self !== true
      ? { myResponse: response(me.responseStatus) }
      : {}),
    status:
      event.status === "cancelled"
        ? "cancelled"
        : event.status === "tentative"
          ? "tentative"
          : "confirmed",
    recurring:
      event.recurringEventId !== undefined || event.recurrence !== undefined,
    ...(event.recurringEventId ? { seriesId: event.recurringEventId } : {}),
    organizedByMe: !event.organizer || event.organizer.self === true,
    ...(event.iCalUID ? { uid: event.iCalUID } : {}),
    ...(event.htmlLink ? { webLink: event.htmlLink } : {}),
  };
}

/** Query of changes: whether guests hear about it, and Meet requests. */
function writeParams(options: WriteOptions): string {
  return `conferenceDataVersion=1&sendUpdates=${options.notify ? "all" : "none"}`;
}

/** What a new event copied from `event` keeps. */
function copyOf(event: GoogleEvent): Record<string, unknown> {
  return {
    summary: event.summary ?? "",
    start: event.start,
    end: event.end,
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.attendees ? { attendees: event.attendees } : {}),
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
    ...(event.conferenceData ? { conferenceData: event.conferenceData } : {}),
  };
}

/** Google refuses calendar requests without the calendar scopes with a 403. */
function accessError(error: unknown): unknown {
  if (
    isMailError(error) &&
    error.status === 403 &&
    /insufficient|scope/i.test(error.message)
  )
    return new MailError("unavailable", "Calendar access isn't allowed yet.", {
      status: 403,
      cause: error,
      reason: "calendarAccessNeeded",
    });
  return error;
}

/** Google's form of an event time; timed ones carry their zone (repeats need it). */
function googleTime(value: EventTime): GoogleTime {
  if ("date" in value) return { date: value.date };
  return {
    dateTime: value.dateTime,
    timeZone: value.timeZone ?? localZone(),
  };
}

/** A new event id (Google allows choosing one: base32hex, 5–1024 characters). */
function newEventId(): string {
  const digits = "0123456789abcdefghijklmnopqrstuv";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return Array.from(bytes, (byte) => digits[byte % 32]).join("");
}

/** A request for a new Google Meet. */
function meetRequest(): GoogleConference {
  return {
    createRequest: {
      requestId: crypto.randomUUID(),
      conferenceSolutionKey: { type: "hangoutsMeet" },
    },
  };
}

/** The guests of a draft as Google attendees, keeping what Google knows about those already invited. */
function attendeesFor(
  guests: readonly EmailAddress[],
  current: readonly GoogleAttendee[] = [],
): GoogleAttendee[] {
  const known = new Map(
    current.map((attendee) => [attendee.email?.toLowerCase(), attendee]),
  );
  const keep = current.filter(
    (attendee) => attendee.self === true || attendee.resource === true,
  );
  const taken = new Set(keep.map((attendee) => attendee.email?.toLowerCase()));
  return [
    ...keep,
    ...guests
      .filter((guest) => !taken.has(guest.address.toLowerCase()))
      .map(
        (guest): GoogleAttendee =>
          known.get(guest.address.toLowerCase()) ?? {
            email: guest.address,
            ...(guest.name ? { displayName: guest.name } : {}),
          },
      ),
  ];
}

/** The fields of an event that action0 changes, as Google has them now (for undo). */
function snapshotOf(event: GoogleEvent): Record<string, unknown> {
  return {
    summary: event.summary ?? "",
    start: event.start,
    end: event.end,
    location: event.location ?? "",
    description: event.description ?? "",
    attendees: event.attendees ?? [],
    recurrence: event.recurrence ?? null,
    conferenceData: event.conferenceData ?? null,
  };
}

/** True if a Google event has a video call it created (Meet). */
function hasConference(event: GoogleEvent): boolean {
  return (
    event.conferenceData?.entryPoints !== undefined ||
    event.conferenceData?.createRequest !== undefined
  );
}

/** Both are the same moment (or day). */
function sameTime(
  a: GoogleTime | undefined,
  b: GoogleTime | undefined,
): boolean {
  return timeOf(time(a)) === timeOf(time(b));
}

/**
 * {@link CalendarProvider} for a Google account (Calendar API v3). Access is
 * optional: it needs {@link CALENDAR_SCOPES}, which the account grants with
 * "Allow calendar" (or while connecting).
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly canRespond = true;
  readonly canEdit = true;
  readonly guestNotices = "ask";
  readonly #http: GmailHttp;
  readonly #session: ScopedSession;

  /**
   * @param http Client for {@link CALENDAR_API_BASE}.
   * @param session The account's session, for on-demand calendar scopes.
   */
  constructor(http: GmailHttp, session: ScopedSession) {
    this.#http = http;
    this.#session = session;
  }

  readonly access = (): CalendarAccess =>
    this.#session.hasScopes(CALENDAR_SCOPES) ? "granted" : "missing";

  readonly requestAccess = (): Promise<void> =>
    this.#session.requestScopes(CALENDAR_SCOPES);

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#session.subscribe(listener);

  async listCalendars(signal?: AbortSignal): Promise<readonly Calendar[]> {
    this.#checkAccess();
    const entries = await this.#all<GoogleCalendarListEntry>(
      "users/me/calendarList",
      { minAccessRole: "reader" },
      signal,
    );
    return entries
      .map((entry): Calendar => ({
        id: asCalendarId(entry.id),
        name: entry.summaryOverride ?? entry.summary ?? entry.id,
        color: entry.backgroundColor ?? "#039be5",
        primary: entry.primary === true,
        shownByDefault: entry.primary === true || entry.selected === true,
        readOnly: entry.accessRole === "reader",
        ...(entry.conferenceProperties?.allowedConferenceSolutionTypes?.includes(
          "hangoutsMeet",
        )
          ? { videoCall: "googleMeet" as const }
          : {}),
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  async listEvents(
    calendarIds: readonly CalendarId[],
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    this.#checkAccess();
    const lists = await Promise.all(
      calendarIds.map(async (calendarId) => {
        const events = await this.#all<GoogleEvent>(
          `calendars/${enc(calendarId)}/events`,
          {
            timeMin: range.from,
            timeMax: range.to,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 2500,
          },
          signal,
        );
        return events
          .filter((event) => event.status !== "cancelled")
          .map((event) => toCalendarEvent(calendarId, event));
      }),
    );
    return lists.flat();
  }

  /** Sets your attendee answer (Google sends the organizer an update). */
  async respond(
    event: CalendarEvent,
    answer: Rsvp,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    const { calendarId, eventId } = splitEventId(event.id);
    const path = `calendars/${enc(calendarId)}/events/${enc(eventId)}`;
    try {
      const current = await this.#http.get<GoogleEvent>(
        path,
        undefined,
        signal,
      );
      const attendees = (current.attendees ?? []).map((attendee) =>
        attendee.self ? { ...attendee, responseStatus: answer } : attendee,
      );
      const updated = await this.#http.patch<GoogleEvent>(
        `${path}?sendUpdates=all`,
        { attendees },
        signal,
      );
      return toCalendarEvent(calendarId, updated);
    } catch (error) {
      throw accessError(error);
    }
  }

  async findInvitation(
    uid: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent | undefined> {
    if (this.access() === "missing") return undefined;
    try {
      const page = await this.#http.get<GooglePage<GoogleEvent>>(
        "calendars/primary/events",
        { iCalUID: uid, maxResults: 5 },
        signal,
      );
      const found = page.items?.find((event) => event.status !== "cancelled");
      return found ? toCalendarEvent("primary", found) : undefined;
    } catch (error) {
      throw accessError(error);
    }
  }

  async loadForEdit(
    event: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<EditableEvent> {
    const { calendarId, eventId } = splitEventId(event.id);
    try {
      const current = await this.#event(calendarId, eventId, signal);
      const master = current.recurringEventId
        ? await this.#event(calendarId, current.recurringEventId, signal)
        : current;
      const description = current.description?.trim() ?? "";
      return {
        draft: {
          calendarId: asCalendarId(calendarId),
          title: current.summary ?? "",
          start: time(current.start),
          end: time(current.end),
          location: current.location ?? "",
          descriptionHtml: description,
          guests: (current.attendees ?? [])
            .filter((attendee) => !attendee.self && !attendee.resource)
            .flatMap((attendee) => person(attendee) ?? []),
          videoCall: hasConference(current),
          repeat: repeatOf(master.recurrence, time(master.start)),
        },
        videoCallFixed: false,
        firstOccurrence:
          current.recurringEventId === undefined ||
          sameTime(current.originalStartTime, master.start),
      };
    } catch (error) {
      throw accessError(error);
    }
  }

  async createEvent(
    draft: EventDraft,
    options: WriteOptions,
  ): Promise<EventChange & { readonly event: CalendarEvent }> {
    const calendarId = draft.calendarId;
    const body = {
      id: newEventId(),
      summary: draft.title,
      start: googleTime(draft.start),
      end: googleTime(draft.end),
      ...(draft.location ? { location: draft.location } : {}),
      ...(draft.descriptionHtml ? { description: draft.descriptionHtml } : {}),
      ...(draft.guests.length > 0
        ? { attendees: attendeesFor(draft.guests) }
        : {}),
      ...(draft.repeat && draft.repeat.kind !== "custom"
        ? { recurrence: [ruleOf(draft.repeat, draft.start)] }
        : {}),
      ...(draft.videoCall ? { conferenceData: meetRequest() } : {}),
    };
    try {
      const created = await this.#insert(calendarId, body, options);
      const event = toCalendarEvent(calendarId, created);
      return {
        event,
        undo: (undo) => this.#remove(calendarId, created.id, undo),
      };
    } catch (error) {
      throw accessError(error);
    }
  }

  async updateEvent(
    event: CalendarEvent,
    changes: EventChanges,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    const { calendarId, eventId } = splitEventId(event.id);
    const { signal } = options;
    try {
      const current = await this.#event(calendarId, eventId, signal);
      const masterId = current.recurringEventId;
      if (masterId === undefined)
        return await this.#change(calendarId, current, changes, options);
      if (scope === "this") {
        // An occurrence can't repeat on its own.
        const { repeat: _repeat, ...own } = changes;
        return await this.#change(calendarId, current, own, options);
      }
      const master = await this.#event(calendarId, masterId, signal);
      if (
        scope === "all" ||
        sameTime(current.originalStartTime, master.start)
      ) {
        const start = changes.start
          ? moveLike(time(master.start), event.start, changes.start)
          : undefined;
        const end = changes.end
          ? moveLike(time(master.end), event.end, changes.end)
          : undefined;
        return await this.#change(
          calendarId,
          master,
          {
            ...changes,
            ...(start ? { start } : {}),
            ...(end ? { end } : {}),
          },
          options,
        );
      }
      return await this.#split(calendarId, master, current, changes, options);
    } catch (error) {
      throw accessError(error);
    }
  }

  async deleteEvent(
    event: CalendarEvent,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    const { calendarId, eventId } = splitEventId(event.id);
    const { signal } = options;
    try {
      const current = await this.#event(calendarId, eventId, signal);
      const masterId = current.recurringEventId;
      let target = current;
      if (masterId !== undefined && scope !== "this") {
        const master = await this.#event(calendarId, masterId, signal);
        if (
          scope === "following" &&
          !sameTime(current.originalStartTime, master.start)
        ) {
          // The series ends before this occurrence.
          const before = master.recurrence ?? [];
          const { old } = splitRule(before, time(current.originalStartTime), 0);
          await this.#patch(
            calendarId,
            master.id,
            { recurrence: old },
            options,
          );
          return {
            undo: async (undo) => {
              await this.#patch(
                calendarId,
                master.id,
                { recurrence: before },
                undo,
              );
            },
          };
        }
        target = master;
      }
      await this.#remove(calendarId, target.id, options);
      return {
        undo: async (undo) => {
          // Google keeps deleted events (as cancelled) for a while.
          try {
            await this.#patch(
              calendarId,
              target.id,
              { status: "confirmed" },
              undo,
            );
          } catch (error) {
            if (!isMailError(error, "not-found")) throw error;
            await this.#insert(
              calendarId,
              { ...copyOf(target), id: newEventId() },
              undo,
            );
          }
        },
      };
    } catch (error) {
      throw accessError(error);
    }
  }

  /** Applies changes to one event (an occurrence, a series' master, or a single event). */
  async #change(
    calendarId: string,
    current: GoogleEvent,
    changes: EventChanges,
    options: WriteOptions,
  ): Promise<EventChange> {
    const body: Record<string, unknown> = {};
    if (changes.title !== undefined) body.summary = changes.title;
    if (changes.start !== undefined) body.start = googleTime(changes.start);
    if (changes.end !== undefined) body.end = googleTime(changes.end);
    if (changes.location !== undefined) body.location = changes.location;
    if (changes.descriptionHtml !== undefined)
      body.description = changes.descriptionHtml;
    if (changes.guests !== undefined)
      body.attendees = attendeesFor(changes.guests, current.attendees);
    if (
      changes.videoCall !== undefined &&
      changes.videoCall !== hasConference(current)
    )
      body.conferenceData = changes.videoCall ? meetRequest() : null;
    const isSeries = current.recurrence !== undefined;
    if (changes.repeat !== undefined && changes.repeat?.kind !== "custom") {
      const start = changes.start ?? time(current.start);
      const extra = (current.recurrence ?? []).filter(
        (line) => !/^RRULE:/i.test(line),
      );
      body.recurrence = changes.repeat
        ? [ruleOf(changes.repeat, start), ...extra]
        : [];
    } else if (isSeries && changes.start !== undefined)
      body.recurrence = retimeRule(
        current.recurrence ?? [],
        time(current.start),
        changes.start,
      );
    const before = snapshotOf(current);
    const undoBody = Object.fromEntries(
      Object.keys(body).map((key) => [key, before[key]]),
    );
    await this.#patch(calendarId, current.id, body, options);
    return {
      undo: async (undo) => {
        await this.#patch(calendarId, current.id, undoBody, undo);
      },
    };
  }

  /** "This and following": the series ends before the occurrence, a new one starts with the changes. */
  async #split(
    calendarId: string,
    master: GoogleEvent,
    occurrence: GoogleEvent,
    changes: EventChanges,
    options: WriteOptions,
  ): Promise<EventChange> {
    const rules = master.recurrence ?? [];
    const at = time(occurrence.originalStartTime);
    const counted = rules.some((line) => /^RRULE:.*COUNT=/i.test(line));
    const before = counted
      ? (
          await this.#all<GoogleEvent>(
            `calendars/${enc(calendarId)}/events/${enc(master.id)}/instances`,
            {
              timeMax: new Date(timeOf(at)).toISOString(),
              showDeleted: true,
              maxResults: 2500,
            },
            options.signal,
          )
        ).length
      : 0;
    const { old, rest } = splitRule(rules, at, before);
    const start = changes.start ?? time(occurrence.start);
    const end = changes.end ?? time(occurrence.end);
    const extra = rest.filter((line) => !/^RRULE:/i.test(line));
    const recurrence =
      changes.repeat === undefined || changes.repeat?.kind === "custom"
        ? retimeRule(rest, time(occurrence.start), start)
        : changes.repeat
          ? [ruleOf(changes.repeat, start), ...extra]
          : undefined;
    const body = {
      id: newEventId(),
      summary: changes.title ?? master.summary ?? "",
      start: googleTime(start),
      end: googleTime(end),
      location: changes.location ?? master.location ?? "",
      description: changes.descriptionHtml ?? master.description ?? "",
      attendees:
        changes.guests === undefined
          ? (master.attendees ?? [])
          : attendeesFor(changes.guests, master.attendees),
      ...(recurrence ? { recurrence } : {}),
      ...((changes.videoCall ?? hasConference(master))
        ? { conferenceData: master.conferenceData ?? meetRequest() }
        : {}),
    };
    await this.#patch(calendarId, master.id, { recurrence: old }, options);
    const created = await this.#insert(calendarId, body, options);
    return {
      undo: async (undo) => {
        await this.#remove(calendarId, created.id, undo);
        await this.#patch(calendarId, master.id, { recurrence: rules }, undo);
      },
    };
  }

  #event(
    calendarId: string,
    eventId: string,
    signal: AbortSignal | undefined,
  ): Promise<GoogleEvent> {
    return this.#http.get<GoogleEvent>(
      `calendars/${enc(calendarId)}/events/${enc(eventId)}`,
      undefined,
      signal,
    );
  }

  /** Creates an event with its own id, so a repeated request can't create two. */
  async #insert(
    calendarId: string,
    body: Record<string, unknown> & { readonly id: string },
    options: WriteOptions,
  ): Promise<GoogleEvent> {
    try {
      return await this.#http.post<GoogleEvent>(
        `calendars/${enc(calendarId)}/events?${writeParams(options)}`,
        body,
        options.signal,
      );
    } catch (error) {
      // An earlier attempt created it after all.
      if (isMailError(error) && error.status === 409)
        return this.#event(calendarId, body.id, options.signal);
      throw error;
    }
  }

  #patch(
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    options: WriteOptions,
  ): Promise<GoogleEvent> {
    return this.#http.patch<GoogleEvent>(
      `calendars/${enc(calendarId)}/events/${enc(eventId)}?${writeParams(options)}`,
      body,
      options.signal,
    );
  }

  async #remove(
    calendarId: string,
    eventId: string,
    options: WriteOptions,
  ): Promise<void> {
    await this.#http.delete(
      `calendars/${enc(calendarId)}/events/${enc(eventId)}?${writeParams(options)}`,
      options.signal,
    );
  }

  #checkAccess() {
    if (this.access() === "missing")
      throw new MailError("unavailable", "Calendar access isn't allowed yet.", {
        reason: "calendarAccessNeeded",
      });
  }

  async #all<T>(
    path: string,
    params: Readonly<Record<string, string | number | boolean>>,
    signal: AbortSignal | undefined,
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const page = await this.#http.get<GooglePage<T>>(
          path,
          { ...params, ...(pageToken ? { pageToken } : {}) },
          signal,
        );
        items.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
    } catch (error) {
      throw accessError(error);
    }
    return items;
  }
}
