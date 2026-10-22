import type { MicrosoftAuthSession } from "../../auth/microsoft/MicrosoftAuthSession";
import { CALENDAR_SCOPES } from "../../auth/microsoft/msal";
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
  type ResponseStatus,
  type Rsvp,
} from "../../core/calendar";
import type { EmailAddress } from "../../core/model";
import type { GraphHttp } from "./http";
import type { GraphPage, GraphRecipient } from "./types";

/** The fields of Graph's event resource that action0 reads. */
export interface GraphEvent {
  readonly id: string;
  readonly subject?: string | null;
  readonly start?: { readonly dateTime?: string; readonly timeZone?: string };
  readonly end?: { readonly dateTime?: string; readonly timeZone?: string };
  readonly originalStartTimeZone?: string;
  readonly isAllDay?: boolean;
  readonly isCancelled?: boolean;
  readonly isOrganizer?: boolean;
  readonly showAs?: string;
  readonly type?: string;
  readonly location?: { readonly displayName?: string };
  readonly body?: {
    readonly contentType?: "html" | "text";
    readonly content?: string;
  };
  readonly onlineMeeting?: { readonly joinUrl?: string } | null;
  readonly onlineMeetingUrl?: string | null;
  readonly organizer?: GraphRecipient;
  readonly attendees?: readonly (GraphRecipient & {
    readonly type?: string;
    readonly status?: { readonly response?: string };
  })[];
  readonly responseStatus?: { readonly response?: string };
  readonly iCalUId?: string;
  readonly webLink?: string;
  readonly calendar?: { readonly id?: string };
}

interface GraphCalendar {
  readonly id: string;
  readonly name?: string;
  readonly hexColor?: string;
  readonly color?: string;
  readonly isDefaultCalendar?: boolean;
  readonly canEdit?: boolean;
}

/** `$select` of events. */
export const EVENT_SELECT =
  "id,subject,start,end,originalStartTimeZone,isAllDay,isCancelled,isOrganizer,type,location,body,onlineMeeting,onlineMeetingUrl,organizer,attendees,responseStatus,iCalUId,webLink";

/** Outlook's named calendar colours, for calendars without a hex colour. */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  lightBlue: "#4f8ad9",
  lightGreen: "#5fb25f",
  lightOrange: "#f2994a",
  lightGray: "#8d8d8d",
  lightYellow: "#d4b106",
  lightTeal: "#2bb3a8",
  lightPink: "#e36fa4",
  lightBrown: "#a07850",
  lightRed: "#e05a5a",
};

const enc = encodeURIComponent;

function person(
  recipient: GraphRecipient | undefined,
): EmailAddress | undefined {
  const address = recipient?.emailAddress?.address;
  if (!address) return undefined;
  const name = recipient.emailAddress.name?.trim();
  return name && name !== address ? { name, address } : { address };
}

const RESPONSES: Readonly<Record<string, ResponseStatus>> = {
  accepted: "accepted",
  organizer: "accepted",
  tentativelyAccepted: "tentative",
  declined: "declined",
};

function response(value: string | undefined): ResponseStatus {
  return RESPONSES[value ?? ""] ?? "needsAction";
}

/** Graph's UTC times ("2026-10-20T09:30:00.0000000") as ISO instants. */
function utc(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  return new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`,
  ).toISOString();
}

/** A Graph event as a {@link CalendarEvent}. */
export function toCalendarEvent(
  calendarId: string,
  event: GraphEvent,
): CalendarEvent {
  const allDay = event.isAllDay === true;
  const attendees: Attendee[] = (event.attendees ?? []).flatMap((attendee) => {
    const address = person(attendee);
    return address
      ? [
          {
            address,
            response: response(attendee.status?.response),
            ...(attendee.type === "optional" ? { optional: true } : {}),
            ...(attendee.type === "resource" ? { resource: true } : {}),
          },
        ]
      : [];
  });
  const organizer = person(event.organizer);
  const meetingUrl =
    event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? undefined;
  const content = event.body?.content?.trim();
  return {
    id: asEventId(event.id),
    calendarId: asCalendarId(calendarId),
    title: event.subject ?? "",
    // All-day events are dates; in UTC their midnight keeps the date.
    start: allDay
      ? { date: (event.start?.dateTime ?? "").slice(0, 10) }
      : {
          dateTime: utc(event.start?.dateTime),
          ...(event.originalStartTimeZone
            ? { timeZone: event.originalStartTimeZone }
            : {}),
        },
    end: allDay
      ? { date: (event.end?.dateTime ?? "").slice(0, 10) }
      : { dateTime: utc(event.end?.dateTime) },
    ...(event.location?.displayName
      ? { location: event.location.displayName }
      : {}),
    ...(content
      ? {
          description:
            event.body?.contentType === "text"
              ? { text: content }
              : { html: content },
        }
      : {}),
    ...(meetingUrl ? { meetingUrl } : {}),
    ...(organizer ? { organizer } : {}),
    attendees,
    ...(event.isOrganizer === false
      ? { myResponse: response(event.responseStatus?.response) }
      : {}),
    status: event.isCancelled
      ? "cancelled"
      : event.showAs === "tentative"
        ? "tentative"
        : "confirmed",
    recurring:
      event.type === "occurrence" ||
      event.type === "exception" ||
      event.type === "seriesMaster",
    ...(event.iCalUId ? { uid: event.iCalUId } : {}),
    ...(event.webLink ? { webLink: event.webLink } : {}),
  };
}

const ANSWER_ACTIONS: Readonly<Record<Rsvp, string>> = {
  accepted: "accept",
  tentative: "tentativelyAccept",
  declined: "decline",
};

/**
 * {@link CalendarProvider} for a Microsoft account (Graph). Calendar access
 * (`Calendars.ReadWrite`) has its own consent: without it, requests reject
 * as `unavailable` and {@link access} turns `missing`, while mail works on.
 */
export class GraphCalendarProvider implements CalendarProvider {
  readonly canRespond = true;
  readonly #http: GraphHttp;
  readonly #session: MicrosoftAuthSession;

  /**
   * @param http Client whose token carries {@link CALENDAR_SCOPES}.
   * @param session The account's session, for consent to calendar access.
   */
  constructor(http: GraphHttp, session: MicrosoftAuthSession) {
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
    const page = await this.#http.get<GraphPage<GraphCalendar>>(
      "me/calendars",
      {
        $select: "id,name,hexColor,color,isDefaultCalendar,canEdit",
        $top: 100,
      },
      signal,
    );
    return (page.value ?? [])
      .map((calendar): Calendar => ({
        id: asCalendarId(calendar.id),
        name: calendar.name ?? "",
        color:
          calendar.hexColor || NAMED_COLORS[calendar.color ?? ""] || "#4f8ad9",
        primary: calendar.isDefaultCalendar === true,
        shownByDefault: true,
        readOnly: calendar.canEdit === false,
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  async listEvents(
    calendarIds: readonly CalendarId[],
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    const lists = await Promise.all(
      calendarIds.map(async (calendarId) => {
        const events: CalendarEvent[] = [];
        let next: URL | undefined = this.#http.url(
          `me/calendars/${enc(calendarId)}/calendarView`,
          {
            startDateTime: range.from,
            endDateTime: range.to,
            $select: EVENT_SELECT,
            $top: 250,
          },
        );
        while (next) {
          const page: GraphPage<GraphEvent> = await this.#http.get<
            GraphPage<GraphEvent>
          >(next, undefined, signal, 'outlook.timezone="UTC"');
          for (const event of page.value ?? [])
            if (!event.isCancelled)
              events.push(toCalendarEvent(calendarId, event));
          const link = page["@odata.nextLink"];
          next = link ? new URL(link) : undefined;
        }
        return events;
      }),
    );
    return lists.flat();
  }

  /** Accepts, tentatively accepts or declines; the organizer gets your answer. */
  async respond(
    event: CalendarEvent,
    answer: Rsvp,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    await this.#http.post(
      `me/events/${enc(event.id)}/${ANSWER_ACTIONS[answer]}`,
      { sendResponse: true },
      signal ? { signal } : {},
    );
    const me = this.#session.loginHint.toLowerCase();
    return {
      ...event,
      myResponse: answer,
      attendees: event.attendees.map((attendee) =>
        attendee.address.address.toLowerCase() === me
          ? { ...attendee, response: answer }
          : attendee,
      ),
    };
  }

  async findInvitation(
    uid: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent | undefined> {
    if (this.access() === "missing") return undefined;
    const page = await this.#http.get<GraphPage<GraphEvent>>(
      "me/events",
      {
        $filter: `iCalUId eq '${uid.replace(/'/g, "''")}'`,
        $select: EVENT_SELECT,
        $expand: "calendar($select=id)",
        $top: 1,
      },
      signal,
      'outlook.timezone="UTC"',
    );
    const found = page.value?.[0];
    return found ? toCalendarEvent(found.calendar?.id ?? "", found) : undefined;
  }
}
