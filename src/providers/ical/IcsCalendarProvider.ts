import {
  asCalendarId,
  asEventId,
  type Calendar,
  type CalendarEvent,
  type CalendarId,
  type CalendarProvider,
  type DateRange,
  type EditableEvent,
  type EventChange,
  type IcsSubscription,
  readOnlyError,
} from "../../core/calendar";
import { MailError } from "../../core/errors";
import {
  expandEvents,
  loadIcal,
  readEvent,
  registerZones,
  type IcalComponent,
} from "./icalendar";

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

/**
 * {@link CalendarProvider} for one iCal subscription: the file is fetched
 * from the browser, which only works when its server allows that (CORS),
 * and parsed with ical.js. Read-only.
 */
export class IcsCalendarProvider implements CalendarProvider {
  readonly canRespond = false;
  readonly canEdit = false;
  readonly guestNotices = "always";
  readonly maxReminders = 0;
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
    registerZones(ICAL, root);
    return expandEvents(
      ICAL,
      root,
      Date.parse(range.from),
      Date.parse(range.to),
    ).map((occurrence) =>
      readEvent(occurrence, {
        id: asEventId(
          `${occurrence.item.uid}/${occurrence.start.toICALString()}`,
        ),
        calendarId,
      }),
    );
  }

  respond(): Promise<CalendarEvent> {
    return Promise.reject(
      new MailError("unavailable", "iCal calendars are read-only."),
    );
  }

  findInvitation(): Promise<CalendarEvent | undefined> {
    return Promise.resolve(undefined);
  }

  loadForEdit(): Promise<EditableEvent> {
    return Promise.reject(readOnlyError());
  }

  createEvent(): Promise<EventChange & { readonly event: CalendarEvent }> {
    return Promise.reject(readOnlyError());
  }

  updateEvent(): Promise<EventChange> {
    return Promise.reject(readOnlyError());
  }

  deleteEvent(): Promise<EventChange> {
    return Promise.reject(readOnlyError());
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
}
