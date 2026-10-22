import type { GoogleAuthSession } from "../../auth/google/GoogleAuthSession";
import {
  asCalendarId,
  asEventId,
  type Attendee,
  type Calendar,
  type CalendarAccess,
  type CalendarEvent,
  type CalendarId,
  type CalendarProvider,
  type DateRange,
  type EventTime,
  type ResponseStatus,
  type Rsvp,
} from "../../core/calendar";
import { isMailError, MailError } from "../../core/errors";
import type { EmailAddress } from "../../core/model";
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
  readonly recurrence?: readonly string[];
  readonly iCalUID?: string;
  readonly htmlLink?: string;
  readonly hangoutLink?: string;
  readonly conferenceData?: {
    readonly entryPoints?: readonly {
      readonly entryPointType?: string;
      readonly uri?: string;
    }[];
  };
}

interface GoogleCalendarListEntry {
  readonly id: string;
  readonly summary?: string;
  readonly summaryOverride?: string;
  readonly backgroundColor?: string;
  readonly primary?: boolean;
  readonly selected?: boolean;
  readonly accessRole?: string;
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
    ...(event.iCalUID ? { uid: event.iCalUID } : {}),
    ...(event.htmlLink ? { webLink: event.htmlLink } : {}),
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

/**
 * {@link CalendarProvider} for a Google account (Calendar API v3). Access is
 * optional: it needs {@link CALENDAR_SCOPES}, which the account grants with
 * "Allow calendar" (or while connecting).
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly canRespond = true;
  readonly #http: GmailHttp;
  readonly #session: GoogleAuthSession;

  /**
   * @param http Client for {@link CALENDAR_API_BASE}.
   * @param session The account's session, for on-demand calendar scopes.
   */
  constructor(http: GmailHttp, session: GoogleAuthSession) {
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
