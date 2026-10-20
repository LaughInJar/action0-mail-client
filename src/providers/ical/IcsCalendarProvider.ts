import {
  asCalendarId,
  asEventId,
  type Attendee,
  type Calendar,
  type CalendarEvent,
  type CalendarId,
  type CalendarProvider,
  type DateRange,
  type EventTime,
  type IcsSubscription,
  type ResponseStatus,
} from "../../core/calendar";
import type IcalModule from "ical.js";
import { MailError } from "../../core/errors";
import type { EmailAddress } from "../../core/model";

/** Occurrences of one series shown at most in one range. */
const MAX_OCCURRENCES = 5000;

/** Steps through one series at most (a daily series over 100 years). */
const MAX_STEPS = 40_000;

/** Occurrences that start this much before a range are skipped unread (events are shorter). */
const MAX_EVENT_MS = 31 * 24 * 60 * 60 * 1000;

/** Downloads are shared for this long, so several ranges loading at once fetch once. */
const SHARE_MS = 60_000;

/** The https address of a subscription URL (`webcal:` → `https:`); undefined if it isn't one. */
export function icsUrl(raw: string): URL | undefined {
  const text = raw.trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

type Ical = typeof IcalModule;
type IcalComponent = InstanceType<Ical["Component"]>;
type IcalTime = InstanceType<Ical["Time"]>;
type IcalEvent = InstanceType<Ical["Event"]>;

let library: Promise<Ical> | undefined;
/** ical.js, loaded on first use. */
function loadIcal(): Promise<Ical> {
  library ??= import("ical.js").then((module) => module.default);
  return library;
}

/**
 * ical.js's types promise values that can be missing at run time (absent
 * properties are null, floating times have no zone, an expansion ends with
 * nothing): this widens the type back.
 */
function absent<T>(value: T): T | null | undefined {
  return value;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function eventTime(time: IcalTime): EventTime {
  if (time.isDate)
    return {
      date: `${String(time.year)}-${pad(time.month)}-${pad(time.day)}`,
    };
  const tzid = absent(time.zone)?.tzid;
  return {
    dateTime: time.toJSDate().toISOString(),
    ...(tzid && tzid !== "floating" && tzid !== "UTC"
      ? { timeZone: tzid }
      : {}),
  };
}

/** A `mailto:` calendar address with its CN, as an email address. */
function calendarAddress(
  value: unknown,
  name: unknown,
): EmailAddress | undefined {
  if (typeof value !== "string") return undefined;
  const address = value.replace(/^mailto:/i, "").trim();
  if (!address.includes("@")) return undefined;
  return typeof name === "string" && name.trim()
    ? { name: name.trim(), address }
    : { address };
}

function partstat(value: unknown): ResponseStatus {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "ACCEPTED":
      return "accepted";
    case "TENTATIVE":
      return "tentative";
    case "DECLINED":
      return "declined";
    default:
      return "needsAction";
  }
}

/**
 * {@link CalendarProvider} for one iCal subscription: the file is fetched
 * from the browser, which only works when its server allows that (CORS),
 * and parsed with ical.js. Read-only.
 */
export class IcsCalendarProvider implements CalendarProvider {
  readonly canRespond = false;
  readonly #subscription: IcsSubscription;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #download: { at: number; text: Promise<string> } | undefined;

  constructor(
    subscription: IcsSubscription,
    options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.#subscription = subscription;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  readonly access = () => "granted" as const;
  readonly requestAccess = (): Promise<void> => Promise.resolve();
  readonly subscribe = (): (() => void) => () => undefined;

  listCalendars(): Promise<readonly Calendar[]> {
    const { id, name, color } = this.#subscription;
    return Promise.resolve([
      {
        id: asCalendarId(id),
        name,
        color,
        primary: false,
        shownByDefault: true,
        readOnly: true,
      },
    ]);
  }

  async listEvents(
    calendarIds: readonly CalendarId[],
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    const calendarId = asCalendarId(this.#subscription.id);
    if (!calendarIds.includes(calendarId)) return [];
    const [text, ICAL] = await Promise.all([this.#text(signal), loadIcal()]);
    let root: IcalComponent;
    try {
      root = ICAL.Component.fromString(text);
    } catch (cause) {
      throw new MailError("provider", "This isn't an iCal calendar.", {
        cause,
        reason: "icsUnreadable",
      });
    }
    for (const zone of root.getAllSubcomponents("vtimezone"))
      ICAL.TimezoneService.register(zone);

    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    const events: CalendarEvent[] = [];
    for (const component of root.getAllSubcomponents("vevent")) {
      const event = new ICAL.Event(component);
      // Changed occurrences come with their series.
      if (event.isRecurrenceException()) continue;
      if (!event.isRecurring()) {
        const occurrence = this.#toEvent(
          calendarId,
          event,
          event.startDate,
          event.endDate,
        );
        if (overlaps(occurrence, from, to)) events.push(occurrence);
        continue;
      }
      const expansion = event.iterator();
      for (
        let count = 0, shown = 0;
        count < MAX_STEPS && shown < MAX_OCCURRENCES;
        count++
      ) {
        const next = absent(expansion.next());
        if (!next) break;
        const at = next.toJSDate().getTime();
        if (at >= to) break;
        // Long-running series: walk past old occurrences without building them.
        if (at < from - MAX_EVENT_MS) continue;
        shown++;
        const details = event.getOccurrenceDetails(next);
        const occurrence = this.#toEvent(
          calendarId,
          details.item,
          details.startDate,
          details.endDate,
          true,
        );
        if (overlaps(occurrence, from, to)) events.push(occurrence);
      }
    }
    return events;
  }

  respond(): Promise<CalendarEvent> {
    return Promise.reject(
      new MailError("unavailable", "iCal calendars are read-only."),
    );
  }

  findInvitation(): Promise<CalendarEvent | undefined> {
    return Promise.resolve(undefined);
  }

  /** The calendar file, downloaded at most once a minute. */
  #text(signal: AbortSignal | undefined): Promise<string> {
    const now = this.#now();
    if (this.#download && now - this.#download.at < SHARE_MS)
      return this.#download.text;
    const text = this.#get(signal);
    this.#download = { at: now, text };
    text.catch(() => {
      this.#download = undefined;
    });
    return text;
  }

  async #get(signal: AbortSignal | undefined): Promise<string> {
    const url = icsUrl(this.#subscription.url);
    if (!url)
      throw new MailError("provider", "Not a web address.", {
        reason: "icsBadUrl",
      });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        // No cookies, no referrer: the address itself is the secret.
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      // No answer at all: the server doesn't allow browser apps (CORS), or is unreachable.
      throw new MailError("network", `${url.host} can't be read from here.`, {
        cause,
        reason: "icsBlocked",
        params: { host: url.host },
      });
    }
    if (!response.ok)
      throw new MailError("provider", `HTTP ${String(response.status)}`, {
        status: response.status,
        reason: "icsNotFound",
        params: { status: String(response.status) },
      });
    const text = await response.text();
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000)))
      throw new MailError("provider", "This isn't an iCal calendar.", {
        reason: "icsUnreadable",
      });
    return text;
  }

  #toEvent(
    calendarId: CalendarId,
    event: IcalEvent,
    start: IcalTime,
    end: IcalTime,
    recurring = false,
  ): CalendarEvent {
    const component = event.component;
    const organizerProp = component.getFirstProperty("organizer");
    const organizer = calendarAddress(
      organizerProp?.getFirstValue(),
      organizerProp?.getParameter("cn"),
    );
    const attendees: Attendee[] = component
      .getAllProperties("attendee")
      .flatMap((property) => {
        const address = calendarAddress(
          property.getFirstValue(),
          property.getParameter("cn"),
        );
        return address
          ? [{ address, response: partstat(property.getParameter("partstat")) }]
          : [];
      });
    const status = String(
      component.getFirstPropertyValue("status") ?? "",
    ).toUpperCase();
    const url = component.getFirstPropertyValue("url");
    const description = absent(event.description)?.trim();
    return {
      id: asEventId(`${event.uid}/${start.toICALString()}`),
      calendarId,
      title: absent(event.summary) ?? "",
      start: eventTime(start),
      end: eventTime(end),
      ...(event.location ? { location: event.location } : {}),
      ...(description ? { description: { text: description } } : {}),
      ...(organizer ? { organizer } : {}),
      attendees,
      status:
        status === "CANCELLED"
          ? "cancelled"
          : status === "TENTATIVE"
            ? "tentative"
            : "confirmed",
      recurring,
      ...(event.uid ? { uid: event.uid } : {}),
      ...(typeof url === "string" && /^https?:/i.test(url)
        ? { webLink: url }
        : {}),
    };
  }
}

function overlaps(event: CalendarEvent, from: number, to: number): boolean {
  const time = (value: EventTime) => {
    if ("date" in value) {
      const [y = 0, m = 1, d = 1] = value.date.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    }
    return Date.parse(value.dateTime);
  };
  if (event.status === "cancelled") return false;
  return time(event.start) < to && time(event.end) > from;
}
