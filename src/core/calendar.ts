/**
 * Provider-agnostic calendar model: calendars of an account (or an iCal
 * subscription), and their events as occurrences in a date range, with
 * repeating events already expanded by the provider.
 *
 * All values are plain, JSON-serializable data so the cache layer can
 * persist them unchanged.
 */
import type { Brand } from "./ids";
import type { EmailAddress } from "./model";

/** Identifies a calendar within its source. Opaque. */
export type CalendarId = Brand<string, "CalendarId">;

/** Identifies one occurrence of an event within its source. Opaque. */
export type EventId = Brand<string, "EventId">;

/** Brands a raw string as a {@link CalendarId}. */
export const asCalendarId = (value: string): CalendarId => value as CalendarId;
/** Brands a raw string as an {@link EventId}. */
export const asEventId = (value: string): EventId => value as EventId;

/** An answer to an invitation. */
export type Rsvp = "accepted" | "tentative" | "declined";

/** Where an invitee stands: an answer, or none yet. */
export type ResponseStatus = Rsvp | "needsAction";

/** A calendar, as listed in the calendar column. */
export interface Calendar {
  readonly id: CalendarId;
  readonly name: string;
  /** CSS colour, e.g. `#039be5`. */
  readonly color: string;
  /** The account's own calendar. */
  readonly primary: boolean;
  /** Ticked until the user decides (e.g. what Google Calendar shows). */
  readonly shownByDefault: boolean;
  /** Its events can't be changed (holidays, subscriptions, shared read-only). */
  readonly readOnly: boolean;
}

/**
 * When an event starts or ends: an instant for timed events (ISO 8601 with
 * offset, plus the zone it was planned in), or a local date for all-day
 * events, whose end is exclusive (a one-day event ends the next day).
 */
export type EventTime =
  | { readonly dateTime: string; readonly timeZone?: string }
  | { readonly date: string };

/** Someone invited to an event. */
export interface Attendee {
  readonly address: EmailAddress;
  readonly response: ResponseStatus;
  readonly optional?: boolean;
  /** A room or resource rather than a person. */
  readonly resource?: boolean;
}

/** One occurrence of an event. */
export interface CalendarEvent {
  readonly id: EventId;
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly start: EventTime;
  readonly end: EventTime;
  readonly location?: string;
  /** Raw and **unsanitized**. */
  readonly description?: { readonly html?: string; readonly text?: string };
  /** Link to join an online meeting (Meet, Teams, Zoom). */
  readonly meetingUrl?: string;
  readonly organizer?: EmailAddress;
  readonly attendees: readonly Attendee[];
  /** Your answer, when you're invited (absent for your own events). */
  readonly myResponse?: ResponseStatus;
  readonly status: "confirmed" | "tentative" | "cancelled";
  /** Part of a series. */
  readonly recurring: boolean;
  /** The iCalendar UID, which links invitation mails to the event. */
  readonly uid?: string;
  /** The event in the provider's own calendar app. */
  readonly webLink?: string;
}

/** An iCal subscription, as kept in the settings of this browser. */
export interface IcsSubscription {
  readonly id: string;
  /** `https://…` or `webcal://…` (read as https). Often secret. */
  readonly url: string;
  readonly name: string;
  /** CSS colour. */
  readonly color: string;
}

/** A date range: `from` inclusive, `to` exclusive, both ISO 8601 instants. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Whether a source's calendars can be read: `missing` means the account
 * hasn't allowed calendar access yet ({@link CalendarProvider.requestAccess}).
 */
export type CalendarAccess = "granted" | "missing";

/**
 * The calendars of one source (an account, or an iCal subscription).
 *
 * Implementations translate between the provider's API and this model, do
 * no caching and never open UI, except {@link requestAccess}. They reject
 * with a `MailError` on failure.
 */
export interface CalendarProvider {
  /** Invitations can be answered ({@link respond}). */
  readonly canRespond: boolean;
  /** Current access; changes are announced through {@link subscribe}. */
  readonly access: () => CalendarAccess;
  /** Asks the user for calendar access (a popup): call it from a click. */
  readonly requestAccess: () => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;

  /** The source's calendars, the primary one first. */
  listCalendars(signal?: AbortSignal): Promise<readonly Calendar[]>;

  /** Occurrences of the given calendars that overlap `range`, repeating events expanded. */
  listEvents(
    calendarIds: readonly CalendarId[],
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]>;

  /**
   * Answers an invitation; the organizer is told as the provider usually
   * does. Resolves to the updated event.
   */
  respond(
    event: CalendarEvent,
    response: Rsvp,
    signal?: AbortSignal,
  ): Promise<CalendarEvent>;

  /** The event an invitation mail is about (by its UID), if it's in your calendar. */
  findInvitation(
    uid: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent | undefined>;
}

/** Start of an event time as epoch ms (all-day dates at local midnight). */
export function timeOf(time: EventTime): number {
  if ("date" in time) {
    const [year = 0, month = 1, day = 1] = time.date.split("-").map(Number);
    return new Date(year, month - 1, day).getTime();
  }
  return Date.parse(time.dateTime);
}

/** True for all-day events. */
export function isAllDay(event: CalendarEvent): boolean {
  return "date" in event.start;
}

/**
 * What an iCalendar part of a mail is about (iMIP, RFC 6047): its `METHOD`
 * and the first event's `UID`. Undefined unless it's a request, a
 * cancellation or an answer with a UID.
 */
export function parseInvitation(
  ics: string,
):
  | { readonly uid: string; readonly method: "request" | "cancel" | "reply" }
  | undefined {
  // Long lines are folded: a line break followed by a space or tab.
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const value = (line: string) => line.slice(line.indexOf(":") + 1).trim();
  const method = lines.find((line) => /^METHOD[:;]/i.test(line));
  const start = lines.findIndex((line) => /^BEGIN:VEVENT\s*$/i.test(line));
  const uid =
    start === -1
      ? undefined
      : lines.slice(start).find((line) => /^UID[:;]/i.test(line));
  if (!method || !uid) return undefined;
  const kinds: Readonly<Record<string, "request" | "cancel" | "reply">> = {
    REQUEST: "request",
    CANCEL: "cancel",
    REPLY: "reply",
  };
  const kind = kinds[value(method).toUpperCase()];
  const id = value(uid);
  return kind && id ? { uid: id, method: kind } : undefined;
}
