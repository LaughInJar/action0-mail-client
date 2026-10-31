import type { CalendarServerInfo } from "../../accounts/calendarServer";
import {
  asCalendarId,
  asEventId,
  timeOf,
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
  type Rsvp,
  type SeriesScope,
  type WriteOptions,
} from "../../core/calendar";
import { MailError } from "../../core/errors";
import type { EmailAddress } from "../../core/model";
import { moveLike, splitRule, retimeRule, ruleOf } from "../../core/recurrence";
import {
  absent,
  addZones,
  answer,
  changeEvent,
  draftOf,
  eventTime,
  excludeOccurrence,
  expandEvents,
  findOverride,
  loadIcal,
  masterOf,
  newEventObject,
  overrideFor,
  overridesFrom,
  readEvent,
  registerZones,
  ruleLines,
  serialize,
  setRuleLines,
  setTime,
  shiftSeries,
  type Ical,
  type IcalComponent,
  type IcalTime,
  type Occurrence,
  type WriteContext,
} from "../ical/icalendar";
import { toMailError } from "../imap/mappers";
import type { CaldavBridge, DavRequest, DavResponse } from "./bridge";
import {
  APPLE,
  CALDAV,
  CALENDARS_PROPFIND,
  DAV,
  components,
  parseMultistatus,
  propHas,
  propText,
  sameUrl,
} from "./dav";
import {
  cancelMail,
  clientScheduled,
  guestsOf,
  markClientScheduled,
  organizerOf,
  replyMail,
  requestMail,
  type CalendarMailer,
  type ItipTexts,
} from "./itip";
import type { CalendarServerDirectory } from "./servers";
import { CalendarStore } from "./store";

/** Colours for calendars that don't name one. */
const PALETTE = ["#039be5", "#33b679", "#8e24aa", "#e67c73", "#f6bf26"];

/** Options of {@link CaldavCalendarProvider}. */
export interface CaldavProviderOptions {
  readonly bridge: CaldavBridge;
  /** The source: `imap:<address>` or `caldav:<id>`. */
  readonly key: string;
  readonly servers: CalendarServerDirectory;
  /**
   * The user: who events with guests are organized by, and every address
   * that is theirs (the account's, its senders').
   */
  readonly identity: () => {
    readonly me: EmailAddress | undefined;
    readonly addresses: readonly string[];
  };
  /** Sends mail from one of the user's addresses, if an account can. */
  readonly mailerFor: (address: string) => CalendarMailer | undefined;
  readonly texts: () => ItipTexts;
  readonly now?: () => number;
}

/** A calendar of the server, as found by `listCalendars`. */
interface Collection {
  readonly url: string;
  readonly readOnly: boolean;
  readonly store: CalendarStore;
}

/** Where an event lives, and its object parsed for changing. */
interface Located {
  readonly collection: Collection;
  readonly url: string;
  readonly etag: string | undefined;
  readonly text: string;
  readonly root: IcalComponent;
  readonly master: IcalComponent;
  readonly occurrence: Occurrence;
}

/**
 * {@link CalendarProvider} for a calendar server (CalDAV, RFC 4791): the
 * calendars of a mail server account, or of a calendar-only server, over
 * the apps' native side (which adds the login).
 *
 * Each calendar's objects are kept in memory ({@link CalendarStore}) and
 * expanded with ical.js. Writes are conditional (`If-Match`): a change
 * made elsewhere meanwhile reloads the calendar and fails as
 * `eventChanged`. Servers that schedule themselves (RFC 6638) tell guests
 * and organizers; otherwise this provider sends iMIP mails through the
 * mail account the address belongs to.
 *
 * Event ids are `<calendar URL>\n<object URL>\n<planned start, ms>`.
 */
export class CaldavCalendarProvider implements CalendarProvider {
  readonly canRespond = true;
  readonly canEdit = true;
  readonly maxReminders = 5;
  readonly setup = "server";
  readonly #options: CaldavProviderOptions;
  readonly #now: () => number;
  #collections = new Map<string, Collection>();
  /** Invitations read from mails, by UID: what answering them saves. */
  readonly #invitations = new Map<string, string>();

  constructor(options: CaldavProviderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get guestNotices(): "ask" | "always" | "never" {
    if (this.#info()?.scheduling === true) return "always";
    const me = this.#me();
    return me && this.#options.mailerFor(me.address) ? "ask" : "never";
  }

  readonly access = (): CalendarAccess =>
    this.#info() ? "granted" : "missing";

  /** The server is set up in its own dialog, not by consent. */
  readonly requestAccess = (): Promise<void> =>
    Promise.reject(
      new MailError("unavailable", "The calendar server isn't set up.", {
        reason: "calendarServerMissing",
      }),
    );

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#options.servers.subscribe(listener);

  async listCalendars(signal?: AbortSignal): Promise<readonly Calendar[]> {
    const info = this.#required();
    const answer = await this.#send(
      {
        method: "PROPFIND",
        url: info.home,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: "1",
        },
        body: CALENDARS_PROPFIND,
      },
      signal,
    );
    if (answer.status !== 207) throw httpError(answer);
    const resources = parseMultistatus(answer.body, answer.url)
      .resources.filter((resource) => !sameUrl(resource.url, info.home))
      .filter((resource) =>
        propHas(resource, DAV, "resourcetype", CALDAV, "calendar"),
      )
      .filter((resource) => components(resource)?.includes("VEVENT") ?? true)
      .sort(
        (a, b) =>
          Number(propText(a, APPLE, "calendar-order") ?? 0) -
          Number(propText(b, APPLE, "calendar-order") ?? 0),
      );
    const collections = new Map<string, Collection>();
    const calendars = resources.map((resource, index): Calendar => {
      const url = resource.url.endsWith("/")
        ? resource.url
        : `${resource.url}/`;
      const readOnly = !writable(resource);
      const known = this.#collections.get(url);
      collections.set(url, {
        url,
        readOnly,
        store:
          known?.store ??
          new CalendarStore(
            url,
            propText(resource, DAV, "sync-token") !== undefined,
            (request, inner) => this.#send(request, inner),
            this.#now,
          ),
      });
      return {
        id: asCalendarId(url),
        name:
          propText(resource, DAV, "displayname") ??
          decodeURIComponent(url.replace(/\/$/, "").split("/").at(-1) ?? ""),
        color: colorOf(propText(resource, APPLE, "calendar-color"), index),
        primary: false,
        shownByDefault: true,
        readOnly,
      };
    });
    this.#collections = collections;
    // The first one the user can write to is the account's own.
    const primary = calendars.findIndex((calendar) => !calendar.readOnly);
    return calendars.map((calendar, index) =>
      index === primary ? { ...calendar, primary: true } : calendar,
    );
  }

  async listEvents(
    calendarIds: readonly CalendarId[],
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    this.#required();
    const ICAL = await loadIcal();
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    const events: CalendarEvent[] = [];
    for (const calendarId of calendarIds) {
      const collection = await this.#collection(calendarId, signal);
      await collection.store.sync(signal);
      for (const object of collection.store.objects()) {
        const root = parse(ICAL, object.text);
        if (!root) continue;
        for (const occurrence of expandEvents(ICAL, root, from, to))
          events.push(this.#event(collection, object.url, occurrence));
      }
    }
    return events;
  }

  async respond(
    event: CalendarEvent,
    response: Rsvp,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    const ICAL = await loadIcal();
    const me = this.#addresses();
    if (event.inCalendar === false) {
      // An invitation from a mail: it goes into the chosen calendar now.
      const text = event.uid ? this.#invitations.get(event.uid) : undefined;
      const root = text ? parse(ICAL, text) : undefined;
      if (!root || !answer(root, me, response))
        throw new MailError("not-found", "The invitation isn't readable.", {
          reason: "eventGone",
        });
      root.removeAllProperties("method");
      // The answer goes out by mail, so a scheduling server doesn't send a second one.
      markClientScheduled(root);
      addZones(ICAL, root);
      const collection = await this.#collection(event.calendarId, signal);
      const url = `${collection.url}${encodeURIComponent(event.uid ?? crypto.randomUUID())}.ics`;
      await this.#put(collection, url, root, undefined, signal);
      await this.#reply(ICAL, root, response);
      return this.#firstEvent(ICAL, collection, url, root);
    }
    const located = await this.#locate(ICAL, event, signal);
    if (!answer(located.root, me, response))
      throw new MailError("provider", "You aren't invited to this event.");
    await this.#put(
      located.collection,
      located.url,
      located.root,
      located.etag,
      signal,
    );
    if (!this.#serverSends(located.root))
      await this.#reply(ICAL, located.root, response);
    const again = await this.#locate(ICAL, event, signal);
    return this.#event(again.collection, again.url, again.occurrence);
  }

  async findInvitation(
    uid: string,
    signal?: AbortSignal,
    ics?: string,
  ): Promise<CalendarEvent | undefined> {
    if (!this.#info()) return undefined;
    const ICAL = await loadIcal();
    if (this.#collections.size === 0) await this.listCalendars(signal);
    for (const collection of this.#collections.values()) {
      await collection.store.sync(signal);
      for (const object of collection.store.objects()) {
        const root = parse(ICAL, object.text);
        if (root && masterOf(root)?.getFirstPropertyValue("uid") === uid)
          return this.#firstEvent(ICAL, collection, object.url, root);
      }
    }
    if (!ics) return undefined;
    const root = parse(ICAL, ics);
    const target = [...this.#collections.values()].find(
      (collection) => !collection.readOnly,
    );
    if (
      !root ||
      !target ||
      masterOf(root)?.getFirstPropertyValue("uid") !== uid
    )
      return undefined;
    this.#invitations.set(uid, ics);
    const event = this.#firstEvent(ICAL, target, `invite:${uid}`, root);
    return { ...event, inCalendar: false };
  }

  async applyReply(
    ics: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent | undefined> {
    const ICAL = await loadIcal();
    const reply = parse(ICAL, ics);
    const uid = reply && masterOf(reply)?.getFirstPropertyValue("uid");
    if (!reply || typeof uid !== "string") return undefined;
    const found = await this.findInvitation(uid, signal);
    if (!found || found.inCalendar === false || !found.organizedByMe)
      return undefined;
    const located = await this.#locate(ICAL, found, signal);
    if (this.#serverSends(located.root)) return undefined;
    const answers = new Map<string, string>();
    for (const vevent of reply.getAllSubcomponents("vevent"))
      for (const property of vevent.getAllProperties("attendee")) {
        const address = String(property.getFirstValue())
          .replace(/^mailto:/i, "")
          .toLowerCase();
        const status = absent(property.getParameter("partstat"));
        if (typeof status === "string") answers.set(address, status);
      }
    let changed = false;
    for (const vevent of located.root.getAllSubcomponents("vevent"))
      for (const property of vevent.getAllProperties("attendee")) {
        const address = String(property.getFirstValue())
          .replace(/^mailto:/i, "")
          .toLowerCase();
        const status = answers.get(address);
        if (status && property.getParameter("partstat") !== status) {
          property.setParameter("partstat", status);
          changed = true;
        }
      }
    if (!changed) return found;
    await this.#put(
      located.collection,
      located.url,
      located.root,
      located.etag,
      signal,
    );
    const again = await this.#locate(ICAL, found, signal);
    return this.#event(again.collection, again.url, again.occurrence);
  }

  async loadForEdit(
    event: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<EditableEvent> {
    const ICAL = await loadIcal();
    const { master, occurrence, collection } = await this.#locate(
      ICAL,
      event,
      signal,
    );
    const masterStart = master.getFirstPropertyValue("dtstart") as IcalTime;
    return {
      draft: draftOf(
        occurrence,
        master,
        asCalendarId(collection.url),
        this.#addresses(),
      ),
      videoCallFixed: false,
      firstOccurrence:
        occurrence.recurrenceId === undefined ||
        occurrence.recurrenceId.toJSDate().getTime() ===
          masterStart.toJSDate().getTime(),
    };
  }

  async createEvent(
    draft: EventDraft,
    options: WriteOptions,
  ): Promise<EventChange & { readonly event: CalendarEvent }> {
    const ICAL = await loadIcal();
    const collection = await this.#collection(draft.calendarId, options.signal);
    if (collection.readOnly) throw readOnly();
    const uid = crypto.randomUUID();
    const url = `${collection.url}${uid}.ics`;
    const root = newEventObject(this.#context(ICAL), draft, uid);
    let etag = await this.#put(
      collection,
      url,
      root,
      undefined,
      options.signal,
    );
    await this.#invite(ICAL, root, [], options);
    return {
      event: this.#firstEvent(ICAL, collection, url, root),
      undo: async (undo) => {
        etag = await this.#latestEtag(collection, url, etag, undo.signal);
        await this.#delete(collection, url, etag, undo.signal);
        await this.#cancel(ICAL, root, guestsOf(root, this.#addresses()), undo);
      },
    };
  }

  async updateEvent(
    event: CalendarEvent,
    changes: EventChanges,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    const ICAL = await loadIcal();
    const context = this.#context(ICAL);
    const located = await this.#locate(ICAL, event, options.signal);
    const { collection, url, root, master, occurrence } = located;
    if (collection.readOnly) throw readOnly();
    const me = this.#addresses();
    const guestsBefore = guestsOf(root, me);
    const series = ruleLines(master).length > 0;
    const planned = occurrence.recurrenceId;
    const masterStart = master.getFirstPropertyValue("dtstart") as IcalTime;
    const first =
      planned === undefined ||
      planned.toJSDate().getTime() === masterStart.toJSDate().getTime();
    let created: { url: string; root: IcalComponent } | undefined;
    if (!series || planned === undefined) {
      changeEvent(context, master, changes);
    } else if (scope === "this") {
      // An occurrence can't repeat on its own.
      const { repeat: _repeat, ...own } = changes;
      const override = overrideFor(
        context,
        root,
        master,
        planned,
        occurrence.start,
        occurrence.end,
      );
      changeEvent(context, override, own);
    } else if (scope === "all" || first) {
      const start = changes.start
        ? moveLike(eventTime(masterStart), event.start, changes.start)
        : undefined;
      const masterEnd = master.getFirstPropertyValue(
        "dtend",
      ) as IcalTime | null;
      const end =
        changes.end && masterEnd
          ? moveLike(eventTime(masterEnd), event.end, changes.end)
          : changes.end;
      changeEvent(context, master, {
        ...changes,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      });
      if (start)
        shiftSeries(
          ICAL,
          root,
          master,
          timeOf(start) - timeOf(eventTime(masterStart)),
        );
    } else {
      created = this.#split(
        ICAL,
        context,
        collection,
        root,
        master,
        occurrence,
        changes,
      );
    }
    addZones(ICAL, root);
    const etag = await this.#put(
      collection,
      url,
      root,
      located.etag,
      options.signal,
    );
    let createdEtag: string | undefined;
    if (created)
      createdEtag = await this.#put(
        collection,
        created.url,
        created.root,
        undefined,
        options.signal,
      );
    await this.#invite(ICAL, root, guestsBefore, options);
    if (created) await this.#invite(ICAL, created.root, [], options);
    const before = located.text;
    return {
      undo: async (undo) => {
        if (created) {
          const latest = await this.#latestEtag(
            collection,
            created.url,
            createdEtag,
            undo.signal,
          );
          await this.#delete(collection, created.url, latest, undo.signal);
          await this.#cancel(
            ICAL,
            created.root,
            guestsOf(created.root, me),
            undo,
          );
        }
        const previous = parse(ICAL, before);
        if (!previous) return;
        const latest = await this.#latestEtag(
          collection,
          url,
          etag,
          undo.signal,
        );
        await this.#put(collection, url, previous, latest, undo.signal);
        await this.#invite(ICAL, previous, guestsOf(root, me), undo);
      },
    };
  }

  async deleteEvent(
    event: CalendarEvent,
    scope: SeriesScope,
    options: WriteOptions,
  ): Promise<EventChange> {
    const ICAL = await loadIcal();
    const context = this.#context(ICAL);
    const located = await this.#locate(ICAL, event, options.signal);
    const { collection, url, root, master, occurrence, text } = located;
    if (collection.readOnly) throw readOnly();
    const me = this.#addresses();
    const guests = guestsOf(root, me);
    const planned = occurrence.recurrenceId;
    const masterStart = master.getFirstPropertyValue("dtstart") as IcalTime;
    const whole =
      ruleLines(master).length === 0 ||
      planned === undefined ||
      scope === "all" ||
      (scope === "following" &&
        planned.toJSDate().getTime() === masterStart.toJSDate().getTime());
    if (whole) {
      await this.#delete(collection, url, located.etag, options.signal);
      await this.#cancel(ICAL, root, guests, options);
      return {
        undo: async (undo) => {
          const previous = parse(ICAL, text);
          if (!previous) return;
          await this.#put(collection, url, previous, undefined, undo.signal);
          await this.#invite(ICAL, previous, [], undo);
        },
      };
    }
    if (scope === "this") {
      excludeOccurrence(context, root, master, planned);
      const etag = await this.#put(
        collection,
        url,
        root,
        located.etag,
        options.signal,
      );
      await this.#cancel(ICAL, root, guests, options, [planned]);
      return this.#restore(ICAL, collection, url, text, etag);
    }
    // "This and following": the series ends before this occurrence.
    const lines = ruleLines(master);
    const { old } = splitRule(lines, eventTime(planned), 0);
    setRuleLines(ICAL, master, old);
    for (const override of overridesFrom(
      root,
      master,
      planned.toJSDate().getTime(),
    ))
      root.removeSubcomponent(override);
    changeEvent(context, master, {});
    const etag = await this.#put(
      collection,
      url,
      root,
      located.etag,
      options.signal,
    );
    await this.#invite(ICAL, root, [], options);
    return this.#restore(ICAL, collection, url, text, etag);
  }

  // ------------------------------------------------------------ internals

  #info(): CalendarServerInfo | undefined {
    return this.#options.servers.info(this.#options.key);
  }

  #required(): CalendarServerInfo {
    const info = this.#info();
    if (!info)
      throw new MailError("unavailable", "The calendar server isn't set up.", {
        reason: "calendarServerMissing",
      });
    return info;
  }

  #me(): EmailAddress | undefined {
    const { me } = this.#options.identity();
    const address = me?.address ?? this.#info()?.address;
    if (!address) return undefined;
    return me?.name ? { name: me.name, address } : { address };
  }

  /** Every address of the user's, lower case. */
  #addresses(): ReadonlySet<string> {
    const { addresses, me } = this.#options.identity();
    const info = this.#info();
    return new Set(
      [
        ...addresses,
        ...(me ? [me.address] : []),
        ...(info?.address ? [info.address] : []),
      ].map((address) => address.toLowerCase()),
    );
  }

  #context(ICAL: Ical): WriteContext {
    const me = this.#me();
    return { ICAL, now: this.#now(), ...(me ? { me } : {}) };
  }

  /** The server sends invitations and answers for this object itself. */
  #serverSends(root: IcalComponent): boolean {
    return this.#info()?.scheduling === true && !clientScheduled(root);
  }

  /** A request, with the native side's failures as `MailError`s and refused logins said plainly. */
  async #send(request: DavRequest, signal?: AbortSignal): Promise<DavResponse> {
    let answer: DavResponse;
    try {
      answer = await this.#options.bridge.request(
        this.#options.key,
        request,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw toMailError(error, { service: hostOf(request.url) });
    }
    if (answer.status === 401)
      throw new MailError(
        "auth-required",
        "The calendar server refused the login.",
        {
          status: 401,
          reason: "calendarLoginRefused",
          params: { service: hostOf(request.url) },
        },
      );
    return answer;
  }

  async #collection(
    calendarId: CalendarId,
    signal: AbortSignal | undefined,
  ): Promise<Collection> {
    let collection = this.#collections.get(calendarId);
    if (!collection) {
      await this.listCalendars(signal);
      collection = this.#collections.get(calendarId);
    }
    if (!collection)
      throw new MailError("not-found", "This calendar is gone.", {
        reason: "eventGone",
      });
    return collection;
  }

  #event(
    collection: Collection,
    url: string,
    occurrence: Occurrence,
  ): CalendarEvent {
    const planned = occurrence.recurrenceId?.toJSDate().getTime();
    return readEvent(occurrence, {
      id: asEventId(
        `${collection.url}\n${url}\n${planned === undefined ? "" : String(planned)}`,
      ),
      calendarId: asCalendarId(collection.url),
      seriesId: url,
      me: this.#addresses(),
    });
  }

  /** The first occurrence of an object (a series' first, else its event). */
  #firstEvent(
    ICAL: Ical,
    collection: Collection,
    url: string,
    root: IcalComponent,
  ): CalendarEvent {
    registerZones(ICAL, root);
    const master = masterOf(root);
    const start = (master?.getFirstPropertyValue("dtstart") as IcalTime | null)
      ?.toJSDate()
      .getTime();
    const [occurrence] =
      start === undefined
        ? []
        : expandEvents(ICAL, root, start, start + 366 * 86_400_000);
    if (!occurrence || !master)
      throw new MailError("not-found", "This event is gone.", {
        reason: "eventGone",
      });
    return this.#event(collection, url, occurrence);
  }

  /** An event's object, fresh from the server's state, and the occurrence it is. */
  async #locate(
    ICAL: Ical,
    event: CalendarEvent,
    signal: AbortSignal | undefined,
  ): Promise<Located> {
    const [calendarUrl = "", url = "", planned = ""] = event.id.split("\n");
    const collection = await this.#collection(
      asCalendarId(calendarUrl),
      signal,
    );
    let object = collection.store.get(url);
    if (!object?.etag) {
      await collection.store.sync(signal, true);
      object = collection.store.get(url);
    }
    const root = object ? parse(ICAL, object.text) : undefined;
    const master = root ? masterOf(root) : undefined;
    if (!object || !root || !master) throw gone();
    const occurrence = occurrenceAt(ICAL, root, master, planned);
    if (!occurrence) throw gone();
    return {
      collection,
      url: object.url,
      etag: object.etag,
      text: object.text,
      root,
      master,
      occurrence,
    };
  }

  /**
   * Writes an object: over `etag` (`If-Match`), or as a new one. A change
   * made elsewhere meanwhile (412) reloads the calendar and fails as
   * `eventChanged`. Resolves to the new ETag, if the server says.
   */
  async #put(
    collection: Collection,
    url: string,
    root: IcalComponent,
    etag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const text = serialize(root);
    const answer = await this.#send(
      {
        method: "PUT",
        url,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
        },
        body: text,
      },
      signal,
    );
    if (answer.status === 412) {
      await collection.store.sync(signal, true);
      throw changedElsewhere();
    }
    if (answer.status < 200 || answer.status >= 300) throw httpError(answer);
    const newEtag = answer.headers.etag;
    collection.store.put({ url, text, ...(newEtag ? { etag: newEtag } : {}) });
    return newEtag;
  }

  async #delete(
    collection: Collection,
    url: string,
    etag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const answer = await this.#send(
      { method: "DELETE", url, headers: etag ? { "If-Match": etag } : {} },
      signal,
    );
    if (answer.status === 412) {
      await collection.store.sync(signal, true);
      throw changedElsewhere();
    }
    if (answer.status !== 404 && (answer.status < 200 || answer.status >= 300))
      throw httpError(answer);
    collection.store.forget(url);
  }

  /** The object's current ETag: as last seen, else read again. */
  async #latestEtag(
    collection: Collection,
    url: string,
    etag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const known = collection.store.get(url)?.etag ?? etag;
    if (known) return known;
    await collection.store.sync(signal, true);
    return collection.store.get(url)?.etag;
  }

  /** Undo for a change to one object: its previous text goes back. */
  #restore(
    ICAL: Ical,
    collection: Collection,
    url: string,
    before: string,
    etag: string | undefined,
  ): EventChange {
    return {
      undo: async (undo) => {
        const previous = parse(ICAL, before);
        if (!previous) return;
        const latest = await this.#latestEtag(
          collection,
          url,
          etag,
          undo.signal,
        );
        await this.#put(collection, url, previous, latest, undo.signal);
        await this.#invite(ICAL, previous, [], undo);
      },
    };
  }

  /**
   * "This and following": the series ends before the occurrence, and a new
   * object (its own UID) starts there with the changes. Changed
   * occurrences from then on are dropped.
   */
  #split(
    ICAL: Ical,
    context: WriteContext,
    collection: Collection,
    root: IcalComponent,
    master: IcalComponent,
    occurrence: Occurrence,
    changes: EventChanges,
  ): { url: string; root: IcalComponent } {
    const planned = occurrence.recurrenceId ?? occurrence.start;
    const lines = ruleLines(master);
    const counted = lines.some((line) => /COUNT=/i.test(line));
    const masterStart = master.getFirstPropertyValue("dtstart") as IcalTime;
    const before = counted
      ? expandEvents(
          ICAL,
          root,
          masterStart.toJSDate().getTime(),
          planned.toJSDate().getTime(),
        ).length
      : 0;
    const { old, rest } = splitRule(lines, eventTime(planned), before);
    const fresh = ICAL.Component.fromString(master.toString());
    setRuleLines(ICAL, master, old);
    for (const override of overridesFrom(
      root,
      master,
      planned.toJSDate().getTime(),
    ))
      root.removeSubcomponent(override);
    changeEvent(context, master, {});

    const uid = crypto.randomUUID();
    fresh.updatePropertyWithValue("uid", uid);
    fresh.removeAllProperties("exdate");
    fresh.updatePropertyWithValue("sequence", 0);
    const start = changes.start ?? eventTime(occurrence.start);
    const end = changes.end ?? eventTime(occurrence.end);
    setRuleLines(
      ICAL,
      fresh,
      changes.repeat === undefined || changes.repeat?.kind === "custom"
        ? retimeRule(rest, eventTime(occurrence.start), start)
        : changes.repeat
          ? [ruleOf(changes.repeat, start)]
          : [],
    );
    setTime(ICAL, fresh, "dtstart", start);
    fresh.removeAllProperties("duration");
    setTime(ICAL, fresh, "dtend", end);
    const { start: _start, end: _end, repeat: _repeat, ...fields } = changes;
    changeEvent(context, fresh, fields);
    const newRoot = new ICAL.Component("vcalendar");
    newRoot.addPropertyWithValue("prodid", "-//action0//action0//EN");
    newRoot.addPropertyWithValue("version", "2.0");
    newRoot.addSubcomponent(fresh);
    addZones(ICAL, newRoot);
    return { url: `${collection.url}${uid}.ics`, root: newRoot };
  }

  /**
   * Tells the guests about a new or changed object (when this provider
   * sends the mails and the user said so); guests no longer invited hear
   * it's cancelled.
   */
  async #invite(
    ICAL: Ical,
    root: IcalComponent,
    guestsBefore: readonly EmailAddress[],
    options: WriteOptions,
  ): Promise<void> {
    if (this.#serverSends(root) || !options.notify) return;
    const me = this.#me();
    // Without guests the event has no organizer any more: it was the user.
    const organizer =
      organizerOf(root) ?? (guestsBefore.length > 0 ? me : undefined);
    if (!me || !organizer) return;
    if (!this.#addresses().has(organizer.address.toLowerCase())) return;
    const mailer = this.#options.mailerFor(organizer.address);
    if (!mailer) return;
    const texts = this.#options.texts();
    const guests = guestsOf(root, this.#addresses());
    if (guests.length > 0)
      await mailer(
        requestMail(
          ICAL,
          root,
          organizer,
          guests,
          texts,
          guestsBefore.length > 0,
        ),
      );
    const removed = guestsBefore.filter(
      (before) =>
        !guests.some(
          (guest) =>
            guest.address.toLowerCase() === before.address.toLowerCase(),
        ),
    );
    if (removed.length > 0)
      await mailer(cancelMail(ICAL, root, organizer, removed, texts));
  }

  /** Tells these guests the object (or some occurrences) is cancelled. */
  async #cancel(
    ICAL: Ical,
    root: IcalComponent,
    guests: readonly EmailAddress[],
    options: WriteOptions,
    recurrenceIds: readonly IcalTime[] = [],
  ): Promise<void> {
    if (guests.length === 0 || this.#serverSends(root) || !options.notify)
      return;
    const organizer = organizerOf(root);
    if (!organizer || !this.#addresses().has(organizer.address.toLowerCase()))
      return;
    const mailer = this.#options.mailerFor(organizer.address);
    if (!mailer) return;
    await mailer(
      cancelMail(
        ICAL,
        root,
        organizer,
        guests,
        this.#options.texts(),
        recurrenceIds,
      ),
    );
  }

  /** Sends the user's answer to the organizer, from the address they're invited at. */
  async #reply(ICAL: Ical, root: IcalComponent, response: Rsvp) {
    const mail = replyMail(
      ICAL,
      root,
      this.#addresses(),
      response,
      this.#options.texts(),
      this.#me()?.name,
    );
    if (!mail) return;
    const mailer = this.#options.mailerFor(mail.from.address);
    if (mailer) await mailer(mail);
  }
}

/** Parses an object; undefined if it isn't iCalendar. */
function parse(ICAL: Ical, text: string): IcalComponent | undefined {
  try {
    const root = ICAL.Component.fromString(text);
    registerZones(ICAL, root);
    return root;
  } catch {
    return undefined;
  }
}

/**
 * The occurrence planned at `planned` (ms, "" for a single event): its
 * changed VEVENT if it has one, else worked out from the series.
 */
function occurrenceAt(
  ICAL: Ical,
  root: IcalComponent,
  master: IcalComponent,
  planned: string,
): Occurrence | undefined {
  const event = new ICAL.Event(master);
  if (planned === "")
    return {
      item: event,
      start: event.startDate,
      end: event.endDate,
      recurring: false,
    };
  const at = Number(planned);
  const masterStart = master.getFirstPropertyValue("dtstart") as IcalTime;
  let time: IcalTime;
  if (masterStart.isDate) {
    const day = new Date(at);
    time = ICAL.Time.fromData({
      year: day.getFullYear(),
      month: day.getMonth() + 1,
      day: day.getDate(),
      isDate: true,
    });
  } else {
    time = ICAL.Time.fromJSDate(new Date(at), true);
    const zone = absent(masterStart.zone);
    if (zone && zone.tzid !== "floating") time = time.convertToZone(zone);
  }
  const override = findOverride(root, master, time);
  if (override) {
    const changed = new ICAL.Event(override);
    return {
      item: changed,
      start: changed.startDate,
      end: changed.endDate,
      recurring: true,
      recurrenceId: time,
    };
  }
  const details = event.getOccurrenceDetails(time);
  return {
    item: details.item,
    start: details.startDate,
    end: details.endDate,
    recurring: true,
    recurrenceId: details.recurrenceId,
  };
}

/** Write rights from `current-user-privilege-set` (absent: assumed). */
function writable(resource: Parameters<typeof propHas>[0]): boolean {
  const set = resource.props.get(`{${DAV}}current-user-privilege-set`);
  if (!set) return true;
  return ["write", "write-content", "all"].some(
    (name) => set.getElementsByTagNameNS(DAV, name).length > 0,
  );
}

/** `#RRGGBBAA` (Apple) as `#RRGGBB`; a palette colour if none. */
function colorOf(value: string | undefined, index: number): string {
  const match = value ? /^#[0-9a-f]{6}/i.exec(value.trim()) : null;
  return match ? match[0] : (PALETTE[index % PALETTE.length] ?? "#039be5");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function httpError(answer: DavResponse): MailError {
  if (answer.status === 404 || answer.status === 410) return gone();
  if (answer.status === 403)
    return new MailError("unavailable", "The calendar server said no.", {
      status: 403,
      reason: "calendarReadOnly",
    });
  return new MailError(
    "provider",
    `The calendar server answered ${String(answer.status)}.`,
    { status: answer.status },
  );
}

function gone(): MailError {
  return new MailError("not-found", "This event is gone.", {
    reason: "eventGone",
  });
}

function changedElsewhere(): MailError {
  return new MailError("provider", "The event was changed elsewhere.", {
    status: 412,
    reason: "eventChanged",
  });
}

function readOnly(): MailError {
  return new MailError("unavailable", "This calendar can't be changed.", {
    reason: "calendarReadOnly",
  });
}
