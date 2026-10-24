import type { ScopedSession } from "../../auth/types";
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
import { dayOf, moveLike } from "../../core/recurrence";
import { localZone, wallTime } from "../../core/timeZones";
import type { GraphHttp } from "./http";
import {
  graphRecurrence,
  repeatOfGraph,
  retimeGraph,
  splitGraph,
  type GraphRecurrence,
} from "./recurrence";
import type { GraphPage, GraphRecipient } from "./types";
import { ianaZone, loadZones, usableZone, windowsZone } from "./zones";

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
  readonly seriesMasterId?: string | null;
  readonly isOnlineMeeting?: boolean;
  readonly recurrence?: GraphRecurrence | null;
  /** When an occurrence was planned to start (ISO with offset). */
  readonly originalStart?: string | null;
}

interface GraphCalendar {
  readonly id: string;
  readonly name?: string;
  readonly hexColor?: string;
  readonly color?: string;
  readonly isDefaultCalendar?: boolean;
  readonly canEdit?: boolean;
  readonly allowedOnlineMeetingProviders?: readonly string[];
}

/** `$select` of events. */
export const EVENT_SELECT =
  "id,subject,start,end,originalStartTimeZone,isAllDay,isCancelled,isOrganizer,type,seriesMasterId,location,body,onlineMeeting,onlineMeetingUrl,organizer,attendees,responseStatus,iCalUId,webLink";

/** `$select` of an event about to be edited. */
const EDIT_SELECT = `${EVENT_SELECT},isOnlineMeeting,recurrence,originalStart`;

/** Times in Graph's answers come in UTC. */
const UTC = 'outlook.timezone="UTC"';

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

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c] ?? c};`,
  );

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
            ? {
                timeZone:
                  ianaZone(event.originalStartTimeZone) ??
                  event.originalStartTimeZone,
              }
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
    ...(event.seriesMasterId ? { seriesId: event.seriesMasterId } : {}),
    organizedByMe: event.isOrganizer !== false,
    ...(event.iCalUId ? { uid: event.iCalUId } : {}),
    ...(event.webLink ? { webLink: event.webLink } : {}),
  };
}

/** A time as Graph takes it: the clock time in a zone, named the Windows way. */
function graphTime(value: EventTime): {
  dateTime: string;
  timeZone: string;
} {
  if ("date" in value)
    return {
      dateTime: `${value.date}T00:00:00`,
      timeZone: windowsZone(localZone()),
    };
  const zone = usableZone(value.timeZone);
  const { date, time } = wallTime(Date.parse(value.dateTime), zone);
  return { dateTime: `${date}T${time}`, timeZone: windowsZone(zone) };
}

/** Graph attendees for guests, keeping how those already invited are listed. */
function attendeesFor(
  guests: readonly EmailAddress[],
  current: GraphEvent["attendees"] = [],
): unknown[] {
  const known = new Map(
    current.map((attendee) => [
      attendee.emailAddress?.address?.toLowerCase(),
      attendee,
    ]),
  );
  const rooms = current.filter((attendee) => attendee.type === "resource");
  return [
    ...rooms.map(({ emailAddress, type }) => ({ emailAddress, type })),
    ...guests.map((guest) => {
      const existing = known.get(guest.address.toLowerCase());
      return existing && existing.type !== "resource"
        ? { emailAddress: existing.emailAddress, type: existing.type }
        : {
            emailAddress: {
              address: guest.address,
              ...(guest.name ? { name: guest.name } : {}),
            },
            type: "required",
          };
    }),
  ];
}

/**
 * Splits a Teams meeting's description into your text and Outlook's join
 * text, which starts at its separator line (a row of underscores).
 */
export function splitMeetingText(html: string): {
  readonly own: string;
  readonly meeting: string;
} {
  const inner = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const line = inner.search(/_{30,}/);
  if (line === -1) return { own: inner, meeting: "" };
  const cut = inner.lastIndexOf("<div", line);
  const at = cut === -1 ? line : cut;
  return { own: inner.slice(0, at).trim(), meeting: inner.slice(at) };
}

/** The day an occurrence was planned on, where its series is planned. */
function plannedDay(event: GraphEvent): string {
  const zone = usableZone(
    event.recurrence?.range?.recurrenceTimeZone ??
      event.originalStartTimeZone ??
      undefined,
  );
  const at = event.originalStart ?? event.start?.dateTime;
  return at ? wallTime(Date.parse(utcInstant(at)), zone).date : "";
}

/** Graph's UTC times, with or without an offset, as an ISO instant. */
function utcInstant(value: string): string {
  return /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
}

/** What a copy of `event` (a new event like it) is created with. */
function copyOf(
  event: GraphEvent,
  mapped: CalendarEvent,
): Record<string, unknown> {
  return {
    subject: event.subject ?? "",
    start: graphTime(mapped.start),
    end: graphTime(mapped.end),
    isAllDay: event.isAllDay === true,
    ...(event.location?.displayName ? { location: event.location } : {}),
    ...(event.body?.content ? { body: event.body } : {}),
    attendees: (event.attendees ?? []).map(({ emailAddress, type }) => ({
      emailAddress,
      type,
    })),
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
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
  readonly canEdit = true;
  readonly guestNotices = "always";
  readonly #http: GraphHttp;
  readonly #session: ScopedSession & { readonly loginHint: string };

  /**
   * @param http Client whose token carries {@link CALENDAR_SCOPES}.
   * @param session The account's session, for consent to calendar access.
   */
  constructor(
    http: GraphHttp,
    session: ScopedSession & { readonly loginHint: string },
  ) {
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
        $select:
          "id,name,hexColor,color,isDefaultCalendar,canEdit,allowedOnlineMeetingProviders",
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
        ...(calendar.allowedOnlineMeetingProviders?.includes("teamsForBusiness")
          ? { videoCall: "teams" as const }
          : {}),
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  async listEvents(
    calendarIds: readonly CalendarId[],
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    await loadZones();
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
    await loadZones();
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

  async loadForEdit(
    event: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<EditableEvent> {
    await loadZones();
    const current = await this.#event(event.id, signal);
    const master = current.seriesMasterId
      ? await this.#event(current.seriesMasterId, signal)
      : current;
    const mapped = toCalendarEvent(event.calendarId, current);
    const content = current.body?.content ?? "";
    const { own, meeting } = splitMeetingText(content);
    const description =
      current.body?.contentType === "text"
        ? content
            .split(/\n{2,}/)
            .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
            .join("")
        : // Outlook's join text of a Teams meeting stays out of the editor.
          current.isOnlineMeeting
          ? own
          : own + meeting;
    const me = this.#session.loginHint.toLowerCase();
    return {
      draft: {
        calendarId: event.calendarId,
        title: current.subject ?? "",
        start: mapped.start,
        end: mapped.end,
        location: current.location?.displayName ?? "",
        descriptionHtml: content.trim() ? description : "",
        guests: (current.attendees ?? [])
          .filter((attendee) => attendee.type !== "resource")
          .flatMap((attendee) => person(attendee) ?? [])
          .filter((address) => address.address.toLowerCase() !== me),
        videoCall: current.isOnlineMeeting === true,
        repeat: repeatOfGraph(
          master.recurrence,
          dayOf(toCalendarEvent(event.calendarId, master).start),
        ),
      },
      videoCallFixed: current.isOnlineMeeting === true,
      firstOccurrence:
        !current.seriesMasterId ||
        plannedDay(current) === master.recurrence?.range?.startDate,
    };
  }

  async createEvent(
    draft: EventDraft,
    options: WriteOptions,
  ): Promise<EventChange & { readonly event: CalendarEvent }> {
    await loadZones();
    const zone =
      "date" in draft.start ? localZone() : usableZone(draft.start.timeZone);
    const body = {
      // Graph ignores a repeated request with the same transaction.
      transactionId: crypto.randomUUID(),
      subject: draft.title,
      start: graphTime(draft.start),
      end: graphTime(draft.end),
      isAllDay: "date" in draft.start,
      ...(draft.location ? { location: { displayName: draft.location } } : {}),
      ...(draft.descriptionHtml
        ? { body: { contentType: "html", content: draft.descriptionHtml } }
        : {}),
      attendees: attendeesFor(draft.guests),
      ...(draft.repeat && draft.repeat.kind !== "custom"
        ? {
            recurrence: graphRecurrence(
              draft.repeat,
              dayOf(draft.start),
              windowsZone(zone),
            ),
          }
        : {}),
      ...(draft.videoCall
        ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" }
        : {}),
    };
    const created = await this.#create(draft.calendarId, body, options);
    return {
      event: toCalendarEvent(draft.calendarId, created),
      undo: (undo) =>
        this.#http.delete(`me/events/${enc(created.id)}`, undo.signal),
    };
  }

  async updateEvent(
    event: CalendarEvent,
    changes: EventChanges,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    await loadZones();
    const current = await this.#event(event.id, options.signal);
    const masterId = current.seriesMasterId;
    if (!masterId)
      return this.#change(event.calendarId, current, changes, options);
    if (scope === "this") {
      // An occurrence can't repeat on its own.
      const { repeat: _repeat, ...own } = changes;
      return this.#change(event.calendarId, current, own, options);
    }
    const master = await this.#event(masterId, options.signal);
    if (
      scope === "all" ||
      plannedDay(current) === master.recurrence?.range?.startDate
    ) {
      const series = toCalendarEvent(event.calendarId, master);
      return this.#change(
        event.calendarId,
        master,
        {
          ...changes,
          ...(changes.start
            ? { start: moveLike(series.start, event.start, changes.start) }
            : {}),
          ...(changes.end
            ? { end: moveLike(series.end, event.end, changes.end) }
            : {}),
        },
        options,
      );
    }
    return this.#split(event, master, current, changes, options);
  }

  async deleteEvent(
    event: CalendarEvent,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    await loadZones();
    const current = await this.#event(event.id, options.signal);
    const masterId = current.seriesMasterId;
    let target = current;
    if (masterId && scope !== "this") {
      const master = await this.#event(masterId, options.signal);
      const day = plannedDay(current);
      if (
        scope === "following" &&
        day !== master.recurrence?.range?.startDate
      ) {
        const before = master.recurrence ?? {};
        const { old } = splitGraph(before, day, 0);
        await this.#patch(master.id, { recurrence: old }, options);
        return {
          undo: async (undo) => {
            await this.#patch(master.id, { recurrence: before }, undo);
          },
        };
      }
      target = master;
    }
    await this.#http.delete(`me/events/${enc(target.id)}`, options.signal);
    // Graph can't bring deleted events back: undo creates a copy (an
    // occurrence comes back as an event of its own).
    const copy = {
      ...copyOf(target, toCalendarEvent(event.calendarId, target)),
      ...(target === current ? { recurrence: null } : {}),
      transactionId: crypto.randomUUID(),
    };
    return {
      undo: async (undo) => {
        await this.#create(event.calendarId, copy, undo);
      },
    };
  }

  /** Changes one event: an occurrence, a series' master or a single event. */
  async #change(
    calendarId: CalendarId,
    current: GraphEvent,
    changes: EventChanges,
    options: WriteOptions,
  ): Promise<EventChange> {
    const mapped = toCalendarEvent(calendarId, current);
    const body: Record<string, unknown> = {};
    const undo: Record<string, unknown> = {};
    const set = (key: string, value: unknown, before: unknown) => {
      body[key] = value;
      undo[key] = before;
    };
    if (changes.title !== undefined)
      set("subject", changes.title, current.subject ?? "");
    const start = changes.start ?? mapped.start;
    if (changes.start !== undefined) {
      set("start", graphTime(changes.start), graphTime(mapped.start));
      set("isAllDay", "date" in changes.start, current.isAllDay === true);
    }
    if (changes.end !== undefined)
      set("end", graphTime(changes.end), graphTime(mapped.end));
    if (changes.location !== undefined)
      set(
        "location",
        { displayName: changes.location },
        current.location ?? { displayName: "" },
      );
    if (changes.descriptionHtml !== undefined) {
      const meeting = current.isOnlineMeeting
        ? splitMeetingText(current.body?.content ?? "").meeting
        : "";
      set(
        "body",
        { contentType: "html", content: changes.descriptionHtml + meeting },
        current.body ?? { contentType: "html", content: "" },
      );
    }
    if (changes.guests !== undefined)
      set(
        "attendees",
        attendeesFor(changes.guests, current.attendees),
        attendeesFor(
          (current.attendees ?? []).flatMap((attendee) =>
            attendee.type === "resource" ? [] : (person(attendee) ?? []),
          ),
          current.attendees,
        ),
      );
    // Teams meetings can't be taken off again.
    if (changes.videoCall === true && current.isOnlineMeeting !== true) {
      body.isOnlineMeeting = true;
      body.onlineMeetingProvider = "teamsForBusiness";
    }
    const zone = windowsZone(
      "date" in start ? localZone() : usableZone(start.timeZone),
    );
    if (changes.repeat !== undefined && changes.repeat?.kind !== "custom")
      set(
        "recurrence",
        changes.repeat
          ? graphRecurrence(changes.repeat, dayOf(start), zone)
          : null,
        current.recurrence ?? null,
      );
    else if (current.recurrence && changes.start !== undefined) {
      const from = dayOf(mapped.start);
      const to = dayOf(changes.start);
      if (from !== to)
        set(
          "recurrence",
          retimeGraph(current.recurrence, from, to),
          current.recurrence,
        );
    }
    await this.#patch(current.id, body, options);
    return {
      undo: async (options) => {
        await this.#patch(current.id, undo, options);
      },
    };
  }

  /** "This and following": the series ends before the occurrence, a new one starts with the changes. */
  async #split(
    event: CalendarEvent,
    master: GraphEvent,
    occurrence: GraphEvent,
    changes: EventChanges,
    options: WriteOptions,
  ): Promise<EventChange> {
    const recurrence = master.recurrence ?? {};
    const day = plannedDay(occurrence);
    const before =
      recurrence.range?.type === "numbered"
        ? await this.#countBefore(master, occurrence, options.signal)
        : 0;
    const { old, rest } = splitGraph(recurrence, day, before);
    const mapped = toCalendarEvent(event.calendarId, occurrence);
    const start = changes.start ?? mapped.start;
    const end = changes.end ?? mapped.end;
    const zone = windowsZone(
      "date" in start ? localZone() : usableZone(start.timeZone),
    );
    const meeting = master.isOnlineMeeting
      ? splitMeetingText(master.body?.content ?? "").meeting
      : "";
    const next =
      changes.repeat === undefined || changes.repeat?.kind === "custom"
        ? retimeGraph(rest, day, dayOf(start))
        : changes.repeat
          ? graphRecurrence(changes.repeat, dayOf(start), zone)
          : null;
    const body = {
      transactionId: crypto.randomUUID(),
      subject: changes.title ?? master.subject ?? "",
      start: graphTime(start),
      end: graphTime(end),
      isAllDay: "date" in start,
      location: {
        displayName: changes.location ?? master.location?.displayName ?? "",
      },
      body:
        changes.descriptionHtml === undefined
          ? (master.body ?? { contentType: "html", content: "" })
          : { contentType: "html", content: changes.descriptionHtml + meeting },
      attendees:
        changes.guests === undefined
          ? (master.attendees ?? []).map(({ emailAddress, type }) => ({
              emailAddress,
              type,
            }))
          : attendeesFor(changes.guests, master.attendees),
      ...(next ? { recurrence: next } : {}),
      ...((changes.videoCall ?? master.isOnlineMeeting)
        ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" }
        : {}),
    };
    await this.#patch(master.id, { recurrence: old }, options);
    const created = await this.#create(event.calendarId, body, options);
    return {
      undo: async (undo) => {
        await this.#http.delete(`me/events/${enc(created.id)}`, undo.signal);
        await this.#patch(master.id, { recurrence }, undo);
      },
    };
  }

  /** How many occurrences of a series came before one of them. */
  async #countBefore(
    master: GraphEvent,
    occurrence: GraphEvent,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const from = master.recurrence?.range?.startDate ?? "1970-01-01";
    let count = 0;
    let next: URL | undefined = this.#http.url(
      `me/events/${enc(master.id)}/instances`,
      {
        startDateTime: `${from}T00:00:00Z`,
        endDateTime: new Date(
          Date.parse(utcInstant(occurrence.originalStart ?? "")) - 1000,
        ).toISOString(),
        $select: "id",
        $top: 250,
      },
    );
    while (next) {
      const page: GraphPage<{ id: string }> = await this.#http.get<
        GraphPage<{ id: string }>
      >(next, undefined, signal);
      count += page.value?.length ?? 0;
      const link = page["@odata.nextLink"];
      next = link ? new URL(link) : undefined;
    }
    return count;
  }

  #event(id: string, signal: AbortSignal | undefined): Promise<GraphEvent> {
    return this.#http.get<GraphEvent>(
      `me/events/${enc(id)}`,
      { $select: EDIT_SELECT },
      signal,
      UTC,
    );
  }

  async #create(
    calendarId: CalendarId,
    body: Record<string, unknown>,
    options: WriteOptions,
  ): Promise<GraphEvent> {
    return this.#http.post<GraphEvent>(
      `me/calendars/${enc(calendarId)}/events`,
      body,
      { ...(options.signal ? { signal: options.signal } : {}), prefer: UTC },
    );
  }

  async #patch(
    id: string,
    body: Record<string, unknown>,
    options: WriteOptions,
  ): Promise<void> {
    if (Object.keys(body).length === 0) return;
    try {
      await this.#http.patch(`me/events/${enc(id)}`, body, options.signal, UTC);
    } catch (error) {
      if (isMailError(error, "not-found"))
        throw new MailError("not-found", "The event no longer exists.", {
          cause: error,
          reason: "eventGone",
        });
      throw error;
    }
  }
}
