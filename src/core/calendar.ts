/**
 * Provider-agnostic calendar model: calendars of an account (or an iCal
 * subscription), and their events as occurrences in a date range, with
 * repeating events already expanded by the provider.
 *
 * All values are plain, JSON-serializable data so the cache layer can
 * persist them unchanged.
 */
import { MailError } from "./errors";
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
  /** The video call new events here can get, if any. */
  readonly videoCall?: VideoCall;
  /** Reminders new timed events here start with (minutes before). */
  readonly defaultReminders?: readonly number[];
}

/** A video call a provider adds to an event: Google Meet or a Teams meeting. */
export type VideoCall = "googleMeet" | "teams";

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
  /** The series an occurrence belongs to (opaque), to change them together. */
  readonly seriesId?: string;
  /** You organize it, or nobody does: it's yours to change (where its calendar allows). */
  readonly organizedByMe: boolean;
  /** Its reminders: minutes before it starts (on-screen ones; none if absent). */
  readonly reminders?: readonly number[];
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
 * How an event repeats: the rules action0 creates (weekly on the start's
 * weekday, monthly on its day of the month, yearly on its date), ending
 * never or after `until` (a "YYYY-MM-DD" day, inclusive). Any other rule is
 * `custom`: it can't be shown in detail and stays as it is.
 */
export type Repeat =
  | {
      readonly kind: "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
      readonly until?: string;
    }
  | { readonly kind: "custom" };

/**
 * An event as the editor has it: a new one, or every field of an existing
 * one. Timed events' `start` and `end` carry the zone they're planned in.
 */
export interface EventDraft {
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly start: EventTime;
  readonly end: EventTime;
  readonly location: string;
  /** The description as HTML (empty for none). */
  readonly descriptionHtml: string;
  /** Who's invited, apart from you. */
  readonly guests: readonly EmailAddress[];
  /** It has a video call (of its calendar's {@link Calendar.videoCall} kind). */
  readonly videoCall: boolean;
  /** `null`: it doesn't repeat. */
  readonly repeat: Repeat | null;
  /** Minutes before it starts (at most the provider's `maxReminders`). */
  readonly reminders: readonly number[];
}

/** The fields of an event that change; the calendar can't. */
export type EventChanges = Partial<Omit<EventDraft, "calendarId">>;

/** Which occurrences of a repeating event a change is for. */
export type SeriesScope = "this" | "following" | "all";

/** How a change is made. */
export interface WriteOptions {
  /**
   * Tell the guests (invitations, updates, cancellations). Ignored by
   * providers whose {@link CalendarProvider.guestNotices} is `always`.
   */
  readonly notify: boolean;
  readonly signal?: AbortSignal;
}

/** An existing event, read fresh for the editor. */
export interface EditableEvent {
  /** The occurrence's fields, with its series' rule. */
  readonly draft: EventDraft;
  /** Its video call can't be taken off again (Teams). */
  readonly videoCallFixed: boolean;
  /** The first occurrence of its series ("this and following" is everything). */
  readonly firstOccurrence: boolean;
}

/**
 * Reminders a provider keeps itself, with their snooze and dismiss state
 * (Outlook): what's dismissed or snoozed anywhere shows here too.
 */
export interface ReminderSync {
  /** Due times (ISO) of reminders of events starting in `range`; dismissed ones are left out. */
  list(
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly { readonly eventId: EventId; readonly fireAt: string }[]>;
  dismiss(eventId: EventId): Promise<void>;
  /** Reminds again at `until` (ISO). */
  snooze(eventId: EventId, until: string): Promise<void>;
}

/** A change that went through, and how to take it back. */
export interface EventChange {
  /** Takes the change back (Undo); rejects with a `MailError`. */
  readonly undo: (options: WriteOptions) => Promise<void>;
}

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
  /** Events can be created, changed and deleted (in calendars that aren't read-only). */
  readonly canEdit: boolean;
  /**
   * Whether guests hear about changes only when asked to (`ask`, Google),
   * or always (`always`: Microsoft sends updates whatever you do).
   */
  readonly guestNotices: "ask" | "always";
  /** How many reminders an event can have (0: they can't be set). */
  readonly maxReminders: number;
  /** The provider keeps reminders (and their snoozes) itself. */
  readonly reminderSync?: ReminderSync;
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

  /** An event's fields for the editor, with its series' rule. */
  loadForEdit(
    event: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<EditableEvent>;

  /** Creates an event; resolves to it (its first occurrence) and its undo. */
  createEvent(
    draft: EventDraft,
    options: WriteOptions,
  ): Promise<EventChange & { readonly event: CalendarEvent }>;

  /**
   * Changes an event, or its series from this occurrence on, or all of it.
   * Time changes move a series by the same amount; "this and following"
   * ends the series before the occurrence and starts a new one.
   */
  updateEvent(
    event: CalendarEvent,
    changes: EventChanges,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange>;

  /** Deletes an occurrence, the series from it on, or all of it. */
  deleteEvent(
    event: CalendarEvent,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange>;
}

/** Can't be changed: the change methods of read-only sources reject with this. */
export function readOnlyError(): MailError {
  return new MailError("unavailable", "These events can't be changed.", {
    reason: "calendarReadOnly",
  });
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
