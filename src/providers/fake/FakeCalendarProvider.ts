import {
  asEventId,
  type Calendar,
  type CalendarAccess,
  type CalendarEvent,
  type CalendarId,
  type CalendarProvider,
  type DateRange,
  type ResponseStatus,
  type Rsvp,
} from "../../core/calendar";
import { MailError } from "../../core/errors";
import type { EmailAddress } from "../../core/model";
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

const DAY = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** A local date as "YYYY-MM-DD". */
export function localDate(time: Date): string {
  return `${String(time.getFullYear())}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
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

/**
 * {@link CalendarProvider} with generated events: repeating ones on their
 * weekdays in any range, one-off ones around "now". Answers to invitations
 * are kept in memory. Used by the demo account and tests.
 */
export class FakeCalendarProvider implements CalendarProvider {
  readonly canRespond = true;
  readonly #data: FakeCalendarData;
  readonly #latencyMs: number;
  readonly #responses = new Map<string, Rsvp>();
  readonly #emitter = new Emitter();
  #access: CalendarAccess;
  /** Set to make answers fail (to exercise rollback). */
  failWrites = false;

  constructor(
    data: FakeCalendarData,
    options: { latencyMs?: number; access?: CalendarAccess } = {},
  ) {
    this.#data = data;
    this.#latencyMs = options.latencyMs ?? 0;
    this.#access = options.access ?? "granted";
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
    // Start a week early so events that began before the range still show.
    for (
      let day = mondayOf(start - 7 * DAY);
      day.getTime() < end;
      day = new Date(day.getTime() + DAY + 2 * 60 * 60 * 1000)
    ) {
      day.setHours(0, 0, 0, 0);
      for (const template of this.#data.events) {
        if (!calendarIds.includes(template.calendarId)) continue;
        if (!this.#occursOn(template, day)) continue;
        const event = this.#occurrence(template, day);
        const [first, last] = bounds(event);
        if (first < end && last > start) events.push(event);
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
    if (this.failWrites)
      throw new MailError("provider", "The demo server refused the change.", {
        reason: "demoRefused",
      });
    this.#responses.set(event.id, response);
    return this.#withResponse(event, response);
  }

  async findInvitation(
    uid: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent | undefined> {
    await this.#ready(signal);
    const template = this.#data.events.find((e) => e.uid === uid);
    const offset = template?.day;
    if (template === undefined || offset === undefined) return undefined;
    const day = new Date(mondayOf(this.#data.now));
    day.setDate(day.getDate() + offset);
    return this.#occurrence(template, day);
  }

  async #ready(signal: AbortSignal | undefined) {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs, signal);
    if (this.#access === "missing")
      throw new MailError("unavailable", "Calendar access isn't allowed.", {
        reason: "calendarAccessNeeded",
      });
  }

  #occursOn(template: FakeEventTemplate, day: Date): boolean {
    if (template.weekdays)
      return template.weekdays.includes(((day.getDay() + 6) % 7) + 1);
    const monday = mondayOf(this.#data.now);
    const target = new Date(monday);
    target.setDate(monday.getDate() + (template.day ?? 0));
    return localDate(target) === localDate(day);
  }

  #occurrence(template: FakeEventTemplate, day: Date): CalendarEvent {
    const id = asEventId(`${template.key}@${localDate(day)}`);
    const timed = template.start !== undefined && template.end !== undefined;
    const lastDay = new Date(day);
    lastDay.setDate(day.getDate() + (template.days ?? 1));
    const invited = template.invited;
    const event: CalendarEvent = {
      id,
      calendarId: template.calendarId,
      title: template.title,
      start: timed
        ? { dateTime: at(day, template.start ?? "").toISOString() }
        : { date: localDate(day) },
      end: timed
        ? { dateTime: at(day, template.end ?? "").toISOString() }
        : { date: localDate(lastDay) },
      ...(template.location ? { location: template.location } : {}),
      ...(template.description
        ? { description: { text: template.description } }
        : {}),
      ...(template.meetingUrl ? { meetingUrl: template.meetingUrl } : {}),
      ...(template.organizer ? { organizer: template.organizer } : {}),
      attendees: [
        ...(template.organizer
          ? [{ address: template.organizer, response: "accepted" as const }]
          : []),
        ...(template.attendees ?? []).map((address) => ({
          address,
          response: "accepted" as const,
        })),
        ...(invited ? [{ address: this.#data.me, response: invited }] : []),
      ],
      ...(invited ? { myResponse: invited } : {}),
      status: "confirmed",
      recurring: template.weekdays !== undefined,
      uid: template.uid ?? `${template.key}@demo.example`,
    };
    const answer = this.#responses.get(id);
    return answer ? this.#withResponse(event, answer) : event;
  }

  #withResponse(event: CalendarEvent, response: Rsvp): CalendarEvent {
    const me = this.#data.me.address.toLowerCase();
    return {
      ...event,
      myResponse: response,
      attendees: event.attendees.map((attendee) =>
        attendee.address.address.toLowerCase() === me
          ? { ...attendee, response }
          : attendee,
      ),
    };
  }
}

/** Start and end of an event in epoch ms (all-day dates at local midnight). */
function bounds(event: CalendarEvent): [number, number] {
  const time = (value: CalendarEvent["start"]) => {
    if ("date" in value) {
      const [y = 0, m = 1, d = 1] = value.date.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    }
    return Date.parse(value.dateTime);
  };
  return [time(event.start), time(event.end)];
}
