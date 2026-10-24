import {
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
  type Repeat,
  type ResponseStatus,
  type Rsvp,
  type SeriesScope,
  type WriteOptions,
} from "../../core/calendar";
import { MailError } from "../../core/errors";
import type { EmailAddress } from "../../core/model";
import { previousDay } from "../../core/recurrence";
import { Emitter } from "../../lib/emitter";
import { sleep } from "../../lib/sleep";

/** One kind of event of the fake calendar, placed relative to "now". */
export interface FakeEventTemplate {
  readonly key: string;
  readonly calendarId: CalendarId;
  readonly title: string;
  /** Repeats on these weekdays (1 = Monday … 7 = Sunday). */
  readonly weekdays?: readonly number[];
  /** Otherwise once: days after the Monday of the week of "now". */
  readonly day?: number;
  /** "HH:MM" local; absent for all-day events. */
  readonly start?: string;
  readonly end?: string;
  /** All-day events: how many days (default 1). */
  readonly days?: number;
  readonly location?: string;
  readonly description?: string;
  readonly meetingUrl?: string;
  readonly organizer?: EmailAddress;
  readonly attendees?: readonly EmailAddress[];
  /** You're invited: your starting answer. */
  readonly invited?: ResponseStatus;
  readonly uid?: string;
}

/** In-memory content of a fake calendar source. */
export interface FakeCalendarData {
  readonly calendars: readonly Calendar[];
  readonly events: readonly FakeEventTemplate[];
  readonly me: EmailAddress;
  /** "Now", to place the events around. */
  readonly now: number;
}

/** A write the fake provider took, for tests. */
export interface FakeCalendarWrite {
  readonly kind: "create" | "update" | "delete" | "undo";
  readonly scope?: SeriesScope;
  readonly notify: boolean;
}

/** The fields an occurrence can change on its own. */
interface FakeFields {
  readonly title: string;
  readonly start: EventTime;
  readonly end: EventTime;
  readonly location?: string;
  readonly description?: { readonly html?: string; readonly text?: string };
  readonly guests: readonly EmailAddress[];
  readonly videoCall: boolean;
}

/** An event or series as the fake calendar stores it. */
interface FakeRecord extends FakeFields {
  /** The series id; occurrences are `<id>@<day>`. */
  readonly id: string;
  readonly calendarId: CalendarId;
  readonly meetingUrl?: string;
  readonly organizer?: EmailAddress;
  /** You're invited: your starting answer. */
  readonly invited?: ResponseStatus;
  readonly uid: string;
  /** How it repeats; `custom` series repeat on {@link weekdays}. */
  readonly repeat: Repeat | null;
  /** Weekdays (1 = Monday … 7 = Sunday) of a `custom` series. */
  readonly weekdays?: readonly number[];
  /** Last day of a `custom` series. */
  readonly until?: string;
  /** Occurrences changed on their own (or deleted: `null`), by their planned day. */
  readonly exceptions: Readonly<Record<string, Partial<FakeFields> | null>>;
}

const DAY = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** A local date as "YYYY-MM-DD". */
export function localDate(time: Date): string {
  return `${String(time.getFullYear())}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

function parseLocal(day: string): Date {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function mondayOf(time: number): Date {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  const weekday = (day.getDay() + 6) % 7; // Monday = 0
  day.setDate(day.getDate() - weekday);
  return day;
}

function at(day: Date, hhmm: string): Date {
  const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
  const time = new Date(day);
  time.setHours(hours, minutes, 0, 0);
  return time;
}

/** Epoch ms of an event time (all-day dates at local midnight). */
function timeOf(value: EventTime): number {
  return "date" in value
    ? parseLocal(value.date).getTime()
    : Date.parse(value.dateTime);
}

/** The local day an event time starts on. */
function dayOfTime(value: EventTime): string {
  return "date" in value ? value.date : localDate(new Date(value.dateTime));
}

/** An event time moved to another local day, keeping its clock time. */
function onOtherDay(value: EventTime, from: string, to: string): EventTime {
  const shift = parseLocal(to).getTime() - parseLocal(from).getTime();
  if ("date" in value) {
    const day = new Date(timeOf(value));
    day.setDate(day.getDate() + Math.round(shift / DAY));
    return { date: localDate(day) };
  }
  const time = new Date(value.dateTime);
  time.setDate(time.getDate() + Math.round(shift / DAY));
  return { ...value, dateTime: time.toISOString() };
}

/** An event time moved by `ms` (all-day: by whole days). */
function shifted(value: EventTime, ms: number): EventTime {
  if ("date" in value) {
    const day = parseLocal(value.date);
    day.setDate(day.getDate() + Math.round(ms / DAY));
    return { date: localDate(day) };
  }
  return {
    ...value,
    dateTime: new Date(Date.parse(value.dateTime) + ms).toISOString(),
  };
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c] ?? c};`,
  );

/**
 * {@link CalendarProvider} kept in memory: the templates become series
 * placed around "now", and everything can be answered, created, changed and
 * deleted (an occurrence, the series from one on, or all of it), with undo.
 * Used by the demo account and tests.
 */
export class FakeCalendarProvider implements CalendarProvider {
  readonly canRespond = true;
  readonly canEdit = true;
  readonly guestNotices: "ask" | "always";
  readonly #data: FakeCalendarData;
  readonly #latencyMs: number;
  readonly #responses = new Map<string, Rsvp>();
  readonly #records = new Map<string, FakeRecord>();
  readonly #emitter = new Emitter();
  #access: CalendarAccess;
  #created = 0;
  /** Set to make answers and changes fail (to exercise rollback). */
  failWrites = false;
  /** Every write, oldest first (for tests). */
  readonly writes: FakeCalendarWrite[] = [];

  constructor(
    data: FakeCalendarData,
    options: {
      latencyMs?: number;
      access?: CalendarAccess;
      guestNotices?: "ask" | "always";
    } = {},
  ) {
    this.#data = data;
    this.#latencyMs = options.latencyMs ?? 0;
    this.#access = options.access ?? "granted";
    this.guestNotices = options.guestNotices ?? "ask";
    for (const template of data.events) {
      const record = this.#fromTemplate(template);
      this.#records.set(record.id, record);
    }
  }

  readonly access = (): CalendarAccess => this.#access;

  readonly requestAccess = (): Promise<void> => {
    this.#access = "granted";
    this.#emitter.emit();
    return Promise.resolve();
  };

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  async listCalendars(signal?: AbortSignal): Promise<readonly Calendar[]> {
    await this.#ready(signal);
    return this.#data.calendars;
  }

  async listEvents(
    calendarIds: readonly CalendarId[],
    { from, to }: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    await this.#ready(signal);
    const start = Date.parse(from);
    const end = Date.parse(to);
    const events: CalendarEvent[] = [];
    // Start a month early: events that began (or were planned) before the
    // range can still reach into it.
    for (
      let day = mondayOf(start - 31 * DAY);
      day.getTime() < end;
      day = new Date(day.getTime() + DAY + 2 * 60 * 60 * 1000)
    ) {
      day.setHours(0, 0, 0, 0);
      const key = localDate(day);
      for (const record of this.#records.values()) {
        if (!calendarIds.includes(record.calendarId)) continue;
        if (!occursOn(record, key)) continue;
        const event = this.#occurrence(record, key);
        if (!event) continue;
        if (timeOf(event.start) < end && timeOf(event.end) > start)
          events.push(event);
      }
    }
    return events;
  }

  async respond(
    event: CalendarEvent,
    response: Rsvp,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    await this.#ready(signal);
    this.#checkWrites();
    this.#responses.set(event.id, response);
    return this.#withResponse(event, response);
  }

  async findInvitation(
    uid: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent | undefined> {
    await this.#ready(signal);
    const record = [...this.#records.values()].find((r) => r.uid === uid);
    return record
      ? this.#occurrence(record, dayOfTime(record.start))
      : undefined;
  }

  async loadForEdit(
    event: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<EditableEvent> {
    await this.#ready(signal);
    const { record, day } = this.#find(event);
    const repeat = record.repeat;
    return {
      draft: {
        calendarId: record.calendarId,
        title: event.title,
        start: event.start,
        end: event.end,
        location: event.location ?? "",
        descriptionHtml:
          event.description?.html ??
          (event.description?.text
            ? `<p>${escapeHtml(event.description.text)}</p>`
            : ""),
        guests: event.attendees
          .filter((a) => !this.#isMe(a.address))
          .map((a) => a.address),
        videoCall: this.#fields(record, day)?.videoCall ?? false,
        repeat: repeat?.kind === "custom" || !repeat ? repeat : { ...repeat },
      },
      videoCallFixed: false,
      firstOccurrence: day === dayOfTime(record.start),
    };
  }

  async createEvent(
    draft: EventDraft,
    options: WriteOptions,
  ): Promise<EventChange & { readonly event: CalendarEvent }> {
    await this.#ready(options.signal);
    this.#checkWrites();
    this.#created += 1;
    const id = `new-${String(this.#created)}`;
    const record: FakeRecord = {
      id,
      calendarId: draft.calendarId,
      uid: `${id}@demo.example`,
      exceptions: {},
      ...fieldsOf(draft),
      repeat: draft.repeat?.kind === "custom" ? null : draft.repeat,
      ...(draft.videoCall ? { meetingUrl: `https://meet.example/${id}` } : {}),
    };
    this.#records.set(id, record);
    this.writes.push({ kind: "create", notify: options.notify });
    this.#emitter.emit();
    const event = this.#occurrence(record, dayOfTime(record.start));
    if (!event) throw new Error("A new event has its first occurrence.");
    return { event, undo: this.#undoFor(new Map([[id, undefined]])) };
  }

  async updateEvent(
    event: CalendarEvent,
    changes: EventChanges,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    await this.#ready(options.signal);
    this.#checkWrites();
    const { record, day } = this.#find(event);
    const before = new Map<string, FakeRecord | undefined>([
      [record.id, record],
    ]);
    const fields = fieldsOf(changes);
    const repeating = record.repeat !== null;
    const first = day === dayOfTime(record.start);

    if (repeating && scope === "this") {
      this.#records.set(record.id, {
        ...record,
        exceptions: {
          ...record.exceptions,
          [day]: { ...record.exceptions[day], ...fields },
        },
      });
    } else if (!repeating || scope === "all" || first) {
      // Times move the whole series by as much as this occurrence moved.
      const startShift =
        changes.start === undefined
          ? 0
          : timeOf(changes.start) - timeOf(event.start);
      const endShift =
        changes.end === undefined ? 0 : timeOf(changes.end) - timeOf(event.end);
      const allDay = changes.start !== undefined && "date" in changes.start;
      const wasAllDay = "date" in record.start;
      const moved =
        allDay !== wasAllDay &&
        changes.start !== undefined &&
        changes.end !== undefined
          ? {
              start: onOtherDay(
                changes.start,
                dayOfTime(changes.start),
                dayOfTime(record.start),
              ),
              end: onOtherDay(
                changes.end,
                dayOfTime(changes.start),
                dayOfTime(record.start),
              ),
            }
          : {
              start: shifted(record.start, startShift),
              end: shifted(record.end, endShift),
            };
      this.#records.set(record.id, {
        ...record,
        ...fields,
        ...(repeating ? moved : {}),
        ...(changes.repeat !== undefined
          ? repeatFields(changes.repeat, record)
          : {}),
        ...(changes.videoCall === true && !record.meetingUrl
          ? { meetingUrl: `https://meet.example/${record.id}` }
          : {}),
      });
    } else {
      // This and following: the series ends the day before, a new one starts.
      this.#records.set(record.id, endedBefore(record, day));
      this.#created += 1;
      const id = `${record.id}-${String(this.#created)}`;
      const own = this.#fields(record, day);
      const rest: FakeRecord = {
        ...record,
        ...(own ?? {}),
        start: onOtherDay(record.start, dayOfTime(record.start), day),
        end: onOtherDay(record.end, dayOfTime(record.start), day),
        ...fields,
        id,
        uid: `${id}@demo.example`,
        exceptions: {},
        ...(changes.repeat !== undefined
          ? repeatFields(changes.repeat, record)
          : {}),
      };
      this.#records.set(id, rest);
      before.set(id, undefined);
    }
    this.writes.push({ kind: "update", scope, notify: options.notify });
    this.#emitter.emit();
    return { undo: this.#undoFor(before) };
  }

  async deleteEvent(
    event: CalendarEvent,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    await this.#ready(options.signal);
    this.#checkWrites();
    const { record, day } = this.#find(event);
    const before = new Map<string, FakeRecord | undefined>([
      [record.id, record],
    ]);
    const first = day === dayOfTime(record.start);
    if (
      record.repeat === null ||
      scope === "all" ||
      (scope === "following" && first)
    )
      this.#records.delete(record.id);
    else if (scope === "this")
      this.#records.set(record.id, {
        ...record,
        exceptions: { ...record.exceptions, [day]: null },
      });
    else this.#records.set(record.id, endedBefore(record, day));
    this.writes.push({ kind: "delete", scope, notify: options.notify });
    this.#emitter.emit();
    return { undo: this.#undoFor(before) };
  }

  /** Puts records back as they were (`undefined`: it didn't exist). */
  #undoFor(
    before: ReadonlyMap<string, FakeRecord | undefined>,
  ): (options: WriteOptions) => Promise<void> {
    return async (options) => {
      await this.#ready(options.signal);
      this.#checkWrites();
      for (const [id, record] of before)
        if (record) this.#records.set(id, record);
        else this.#records.delete(id);
      this.writes.push({ kind: "undo", notify: options.notify });
      this.#emitter.emit();
    };
  }

  #find(event: CalendarEvent): { record: FakeRecord; day: string } {
    const at = event.id.lastIndexOf("@");
    const record = this.#records.get(event.seriesId ?? event.id.slice(0, at));
    if (!record)
      throw new MailError("not-found", "The event no longer exists.", {
        reason: "eventGone",
      });
    return { record, day: event.id.slice(at + 1) };
  }

  async #ready(signal: AbortSignal | undefined) {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs, signal);
    if (this.#access === "missing")
      throw new MailError("unavailable", "Calendar access isn't allowed.", {
        reason: "calendarAccessNeeded",
      });
  }

  #checkWrites() {
    if (this.failWrites)
      throw new MailError("provider", "The demo server refused the change.", {
        reason: "demoRefused",
      });
  }

  #isMe(address: EmailAddress): boolean {
    return (
      address.address.toLowerCase() === this.#data.me.address.toLowerCase()
    );
  }

  #fromTemplate(template: FakeEventTemplate): FakeRecord {
    const monday = mondayOf(this.#data.now);
    const first = new Date(monday);
    if (template.weekdays) {
      // The series started a year ago, on its first weekday.
      const firstWeekday = Math.min(...template.weekdays);
      first.setDate(monday.getDate() - 52 * 7 + firstWeekday - 1);
    } else first.setDate(monday.getDate() + (template.day ?? 0));
    const timed = template.start !== undefined && template.end !== undefined;
    const lastDay = new Date(first);
    lastDay.setDate(first.getDate() + (template.days ?? 1));
    const weekdays = template.weekdays;
    const workdays = weekdays?.join() === "1,2,3,4,5";
    const single = weekdays?.length === 1;
    return {
      id: template.key,
      calendarId: template.calendarId,
      title: template.title,
      start: timed
        ? { dateTime: at(first, template.start ?? "").toISOString() }
        : { date: localDate(first) },
      end: timed
        ? { dateTime: at(first, template.end ?? "").toISOString() }
        : { date: localDate(lastDay) },
      ...(template.location ? { location: template.location } : {}),
      ...(template.description
        ? { description: { text: template.description } }
        : {}),
      ...(template.meetingUrl ? { meetingUrl: template.meetingUrl } : {}),
      ...(template.organizer ? { organizer: template.organizer } : {}),
      guests: template.attendees ?? [],
      videoCall: template.meetingUrl !== undefined,
      ...(template.invited ? { invited: template.invited } : {}),
      uid: template.uid ?? `${template.key}@demo.example`,
      repeat: !weekdays
        ? null
        : workdays
          ? { kind: "weekdays" }
          : single
            ? { kind: "weekly" }
            : { kind: "custom" },
      ...(weekdays && !workdays && !single ? { weekdays } : {}),
      exceptions: {},
    };
  }

  /** The fields of an occurrence: the series' with its own changes; `undefined` if deleted. */
  #fields(record: FakeRecord, day: string): FakeFields | undefined {
    const own = record.exceptions[day];
    if (own === null) return undefined;
    const first = dayOfTime(record.start);
    return {
      ...record,
      start: onOtherDay(record.start, first, day),
      end: onOtherDay(record.end, first, day),
      ...own,
    };
  }

  #occurrence(record: FakeRecord, day: string): CalendarEvent | undefined {
    const fields = this.#fields(record, day);
    if (!fields) return undefined;
    const id = asEventId(`${record.id}@${day}`);
    const invited = record.invited;
    const organizer = record.organizer;
    const mine = organizer === undefined || this.#isMe(organizer);
    const event: CalendarEvent = {
      id,
      calendarId: record.calendarId,
      title: fields.title,
      start: fields.start,
      end: fields.end,
      ...(fields.location ? { location: fields.location } : {}),
      ...(fields.description ? { description: fields.description } : {}),
      ...(record.meetingUrl && fields.videoCall
        ? { meetingUrl: record.meetingUrl }
        : {}),
      ...(organizer ? { organizer } : {}),
      attendees: [
        ...(organizer
          ? [{ address: organizer, response: "accepted" as const }]
          : []),
        ...fields.guests
          .filter((address) => address.address !== organizer?.address)
          .map((address): Attendee => ({
            address,
            response: mine ? "needsAction" : "accepted",
          })),
        ...(invited ? [{ address: this.#data.me, response: invited }] : []),
      ],
      ...(invited ? { myResponse: invited } : {}),
      status: "confirmed",
      recurring: record.repeat !== null,
      ...(record.repeat !== null ? { seriesId: record.id } : {}),
      organizedByMe: mine,
      uid: record.uid,
    };
    const answer = this.#responses.get(id);
    return answer ? this.#withResponse(event, answer) : event;
  }

  #withResponse(event: CalendarEvent, response: Rsvp): CalendarEvent {
    return {
      ...event,
      myResponse: response,
      attendees: event.attendees.map((attendee) =>
        this.#isMe(attendee.address) ? { ...attendee, response } : attendee,
      ),
    };
  }
}

/** The stored fields of a draft or of changes. */
function fieldsOf(changes: EventDraft): FakeFields;
function fieldsOf(changes: EventChanges): Partial<FakeFields>;
function fieldsOf(changes: EventChanges): Partial<FakeFields> {
  return {
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.start !== undefined ? { start: changes.start } : {}),
    ...(changes.end !== undefined ? { end: changes.end } : {}),
    ...(changes.location !== undefined ? { location: changes.location } : {}),
    ...(changes.descriptionHtml !== undefined
      ? {
          description: changes.descriptionHtml
            ? { html: changes.descriptionHtml }
            : {},
        }
      : {}),
    ...(changes.guests !== undefined ? { guests: changes.guests } : {}),
    ...(changes.videoCall !== undefined
      ? { videoCall: changes.videoCall }
      : {}),
  };
}

/** A new rule for a series; a `custom` one stays as it was. */
function repeatFields(
  repeat: Repeat | null,
  record: FakeRecord,
): Pick<FakeRecord, "repeat" | "weekdays" | "until"> {
  if (repeat?.kind === "custom")
    return {
      repeat: record.repeat,
      ...(record.weekdays ? { weekdays: record.weekdays } : {}),
      ...(record.until ? { until: record.until } : {}),
    };
  return { repeat };
}

/** A series that ends the day before `day`. */
function endedBefore(record: FakeRecord, day: string): FakeRecord {
  const until = previousDay(day);
  if (record.repeat?.kind === "custom") return { ...record, until };
  return record.repeat
    ? { ...record, repeat: { ...record.repeat, until } }
    : record;
}

/** Whether a series has an occurrence planned on a local day. */
function occursOn(record: FakeRecord, day: string): boolean {
  const first = dayOfTime(record.start);
  if (day < first) return false;
  const repeat = record.repeat;
  if (repeat === null) return day === first;
  const until = repeat.kind === "custom" ? record.until : repeat.until;
  if (until !== undefined && day > until) return false;
  const date = parseLocal(day);
  const start = parseLocal(first);
  const weekday = ((date.getDay() + 6) % 7) + 1; // 1 = Monday
  switch (repeat.kind) {
    case "daily":
      return true;
    case "weekdays":
      return weekday <= 5;
    case "weekly":
      return date.getDay() === start.getDay();
    case "monthly":
      return date.getDate() === start.getDate();
    case "yearly":
      return (
        date.getDate() === start.getDate() &&
        date.getMonth() === start.getMonth()
      );
    case "custom":
      return (record.weekdays ?? []).includes(weekday);
  }
}
