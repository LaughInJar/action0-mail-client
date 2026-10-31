/**
 * iCalendar (RFC 5545) for the calendar providers that read and write it
 * themselves, iCal subscriptions and CalDAV. Reading turns VEVENTs into
 * `CalendarEvent`s with repeating events expanded; writing builds and
 * changes VEVENTs from the editor's `EventDraft`. Uses ical.js, loaded on
 * first use.
 */
import type IcalModule from "ical.js";
import type {
  Attendee,
  CalendarEvent,
  CalendarId,
  EventChanges,
  EventDraft,
  EventId,
  EventTime,
  ResponseStatus,
  Rsvp,
} from "../../core/calendar";
import type { EmailAddress } from "../../core/model";
import { repeatOf, retimeRule, ruleOf } from "../../core/recurrence";
import { isKnownZone, offsetAt, wallTime } from "../../core/timeZones";

export type Ical = typeof IcalModule;
export type IcalComponent = InstanceType<Ical["Component"]>;
export type IcalTime = InstanceType<Ical["Time"]>;
export type IcalEvent = InstanceType<Ical["Event"]>;
type IcalProperty = InstanceType<Ical["Property"]>;

/** Occurrences of one series shown at most in one range. */
const MAX_OCCURRENCES = 5000;

/** Steps through one series at most (a daily series over 100 years). */
const MAX_STEPS = 40_000;

/** Occurrences that start this much before a range are skipped unread (events are shorter). */
const MAX_EVENT_MS = 31 * 24 * 60 * 60 * 1000;

let library: Promise<Ical> | undefined;
/** ical.js, loaded on first use. */
export function loadIcal(): Promise<Ical> {
  library ??= import("ical.js").then((module) => module.default);
  return library;
}

/**
 * ical.js's types promise values that can be missing at run time (absent
 * properties are null, floating times have no zone, an expansion ends with
 * nothing): this widens the type back.
 */
export function absent<T>(value: T): T | null | undefined {
  return value;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------- reading

/** An iCalendar time as an event time (all-day dates, or an instant with its zone). */
export function eventTime(time: IcalTime): EventTime {
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
export function calendarAddress(
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

export function partstat(value: unknown): ResponseStatus {
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
 * Registers the time zones `root` defines, and generates the ones it only
 * names (servers may leave them out, RFC 7809) from what the browser knows.
 */
export function registerZones(ICAL: Ical, root: IcalComponent): void {
  for (const zone of root.getAllSubcomponents("vtimezone"))
    ICAL.TimezoneService.register(zone);
  for (const tzid of zonesUsed(root)) {
    if (ICAL.TimezoneService.has(tzid)) continue;
    const zone = zoneComponent(ICAL, tzid, new Date().getFullYear());
    if (zone) ICAL.TimezoneService.register(zone);
  }
}

/** One occurrence of a VEVENT, as {@link expandEvents} finds them. */
export interface Occurrence {
  /** The VEVENT that describes it: the series', or the occurrence's own changed one. */
  readonly item: IcalEvent;
  readonly start: IcalTime;
  readonly end: IcalTime;
  /** Part of a series. */
  readonly recurring: boolean;
  /** Where it was planned in its series (its RECURRENCE-ID). */
  readonly recurrenceId?: IcalTime;
}

/**
 * The occurrences of the VEVENTs in `root` (a VCALENDAR) that overlap
 * `from`–`to` (epoch ms), repeating events expanded and changed
 * occurrences taken from their own VEVENT. Cancelled ones are left out.
 */
export function expandEvents(
  ICAL: Ical,
  root: IcalComponent,
  from: number,
  to: number,
): Occurrence[] {
  const found: Occurrence[] = [];
  const vevents = root.getAllSubcomponents("vevent");
  for (const component of vevents) {
    if (component.hasProperty("recurrence-id")) continue;
    const uid = component.getFirstPropertyValue("uid");
    // Changed occurrences belong to the series with the same UID.
    const event = new ICAL.Event(component, {
      exceptions: vevents.filter(
        (other) =>
          other.hasProperty("recurrence-id") &&
          other.getFirstPropertyValue("uid") === uid,
      ),
    });
    if (!event.isRecurring()) {
      const occurrence = {
        item: event,
        start: event.startDate,
        end: event.endDate,
        recurring: false,
      };
      if (overlapping(occurrence, from, to)) found.push(occurrence);
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
      const occurrence = {
        item: details.item,
        start: details.startDate,
        end: details.endDate,
        recurring: true,
        recurrenceId: details.recurrenceId,
      };
      if (overlapping(occurrence, from, to)) found.push(occurrence);
    }
  }
  // Changed occurrences that moved into the range from outside it.
  for (const component of vevents) {
    if (!component.hasProperty("recurrence-id")) continue;
    const exception = new ICAL.Event(component);
    const planned = exception.recurrenceId.toJSDate().getTime();
    if (planned >= from - MAX_EVENT_MS && planned < to) continue;
    const occurrence = {
      item: exception,
      start: exception.startDate,
      end: exception.endDate,
      recurring: true,
      recurrenceId: exception.recurrenceId,
    };
    if (overlapping(occurrence, from, to)) found.push(occurrence);
  }
  return found;
}

function overlapping(occurrence: Occurrence, from: number, to: number) {
  const status = String(
    occurrence.item.component.getFirstPropertyValue("status") ?? "",
  ).toUpperCase();
  if (status === "CANCELLED") return false;
  const start = occurrence.start.toJSDate().getTime();
  const end = Math.max(start, occurrence.end.toJSDate().getTime());
  return start < to && (end > from || (end === start && start >= from));
}

/** What a provider adds to an occurrence to make it an event. */
export interface EventPlace {
  readonly id: EventId;
  readonly calendarId: CalendarId;
  /** The series it belongs to (opaque), to change them together. */
  readonly seriesId?: string;
  /**
   * The user's addresses (lower case), to find their answer and their own
   * events; without them nothing counts as the user's (subscriptions).
   */
  readonly me?: ReadonlySet<string>;
}

/** An occurrence as a calendar event. */
export function readEvent(
  occurrence: Occurrence,
  place: EventPlace,
): CalendarEvent {
  const { item, start, end, recurring } = occurrence;
  const component = item.component;
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
      const cutype = String(
        absent(property.getParameter("cutype")) ?? "",
      ).toUpperCase();
      return address
        ? [
            {
              address,
              response: partstat(property.getParameter("partstat")),
              ...(String(
                absent(property.getParameter("role")) ?? "",
              ).toUpperCase() === "OPT-PARTICIPANT"
                ? { optional: true }
                : {}),
              ...(cutype === "ROOM" || cutype === "RESOURCE"
                ? { resource: true }
                : {}),
            },
          ]
        : [];
    });
  const me = place.me;
  const mine = (address: EmailAddress | undefined) =>
    address !== undefined && me?.has(address.address.toLowerCase()) === true;
  const organizedByMe =
    me !== undefined && (organizer === undefined || mine(organizer));
  const myAttendee = organizedByMe
    ? undefined
    : attendees.find((attendee) => mine(attendee.address));
  const status = String(
    component.getFirstPropertyValue("status") ?? "",
  ).toUpperCase();
  const url = component.getFirstPropertyValue("url");
  const text = absent(item.description)?.trim();
  const html = htmlDescription(component);
  const reminders = alarms(component, start, end);
  return {
    id: place.id,
    calendarId: place.calendarId,
    title: absent(item.summary) ?? "",
    start: eventTime(start),
    end: eventTime(end),
    ...(item.location ? { location: item.location } : {}),
    ...(text || html
      ? {
          description: {
            ...(html ? { html } : {}),
            ...(text ? { text } : {}),
          },
        }
      : {}),
    ...(organizer ? { organizer } : {}),
    attendees,
    ...(myAttendee ? { myResponse: myAttendee.response } : {}),
    ...(reminders.length > 0 ? { reminders } : {}),
    status:
      status === "CANCELLED"
        ? "cancelled"
        : status === "TENTATIVE"
          ? "tentative"
          : "confirmed",
    recurring,
    ...(place.seriesId !== undefined ? { seriesId: place.seriesId } : {}),
    organizedByMe,
    ...(item.uid ? { uid: item.uid } : {}),
    ...(typeof url === "string" && /^https?:/i.test(url)
      ? { webLink: url }
      : {}),
  };
}

/** The HTML description some programs add (`X-ALT-DESC;FMTTYPE=text/html`). */
function htmlDescription(component: IcalComponent): string | undefined {
  for (const property of component.getAllProperties("x-alt-desc")) {
    const type = String(
      absent(property.getParameter("fmttype")) ?? "",
    ).toLowerCase();
    const value = property.getFirstValue();
    if (type === "text/html" && typeof value === "string" && value.trim())
      return value.trim();
  }
  return undefined;
}

/**
 * An event's on-screen alarms (`VALARM` with `ACTION:DISPLAY` or `AUDIO`)
 * as minutes before its start: triggers relative to the start or the end,
 * or at a fixed time. Alarms after the start count as "at the start".
 */
export function alarms(
  component: IcalComponent,
  start: IcalTime,
  end: IcalTime,
): number[] {
  const startMs = start.toJSDate().getTime();
  const minutes = component.getAllSubcomponents("valarm").flatMap((alarm) => {
    const action = String(
      alarm.getFirstPropertyValue("action") ?? "",
    ).toUpperCase();
    if (action !== "DISPLAY" && action !== "AUDIO") return [];
    const trigger = alarm.getFirstProperty("trigger");
    const value = absent(trigger?.getFirstValue()) as
      { toSeconds?: () => number; toJSDate?: () => Date } | null | undefined;
    if (!value || !trigger) return [];
    let at: number;
    if (typeof value.toSeconds === "function") {
      const fromEnd =
        String(absent(trigger.getParameter("related")) ?? "").toUpperCase() ===
        "END";
      const base = fromEnd ? end.toJSDate().getTime() : startMs;
      at = base + value.toSeconds() * 1000;
    } else if (typeof value.toJSDate === "function") {
      at = value.toJSDate().getTime();
    } else return [];
    return [Math.max(0, Math.round((startMs - at) / 60_000))];
  });
  return [...new Set(minutes)];
}

// ---------------------------------------------------------------- editing

/** The editor's fields of an occurrence, with its series' rule. */
export function draftOf(
  occurrence: Occurrence,
  master: IcalComponent,
  calendarId: CalendarId,
  me: ReadonlySet<string>,
): EventDraft {
  const component = occurrence.item.component;
  const text = absent(occurrence.item.description)?.trim() ?? "";
  const html = htmlDescription(component);
  const masterStart = master.getFirstPropertyValue("dtstart") as IcalTime;
  return {
    calendarId,
    title: absent(occurrence.item.summary) ?? "",
    start: eventTime(occurrence.start),
    end: eventTime(occurrence.end),
    location: absent(occurrence.item.location) ?? "",
    descriptionHtml: html ?? (text ? htmlOfText(text) : ""),
    guests: component.getAllProperties("attendee").flatMap((property) => {
      const address = calendarAddress(
        property.getFirstValue(),
        property.getParameter("cn"),
      );
      const cutype = String(
        absent(property.getParameter("cutype")) ?? "",
      ).toUpperCase();
      if (!address || me.has(address.address.toLowerCase())) return [];
      return cutype === "ROOM" || cutype === "RESOURCE" ? [] : [address];
    }),
    videoCall: false,
    repeat: repeatOf(ruleLines(master), eventTime(masterStart)),
    reminders: alarms(component, occurrence.start, occurrence.end),
  };
}

/** A VEVENT's `RRULE` lines ("RRULE:FREQ=…"). */
export function ruleLines(vevent: IcalComponent): string[] {
  return vevent
    .getAllProperties("rrule")
    .map((property) => `RRULE:${String(property.getFirstValue())}`);
}

/** What writing needs besides the event. */
export interface WriteContext {
  readonly ICAL: Ical;
  /** The user, as the organizer of events with guests. */
  readonly me?: EmailAddress;
  readonly now: number;
}

/** A new event as an iCalendar object: a VCALENDAR with its VEVENT and time zones. */
export function newEventObject(
  context: WriteContext,
  draft: EventDraft,
  uid: string,
): IcalComponent {
  const { ICAL } = context;
  const root = new ICAL.Component("vcalendar");
  root.addPropertyWithValue("prodid", "-//action0//action0//EN");
  root.addPropertyWithValue("version", "2.0");
  const vevent = new ICAL.Component("vevent");
  vevent.addPropertyWithValue("uid", uid);
  vevent.addPropertyWithValue("created", utcTime(ICAL, context.now));
  root.addSubcomponent(vevent);
  changeEvent(context, vevent, {
    title: draft.title,
    start: draft.start,
    end: draft.end,
    location: draft.location,
    descriptionHtml: draft.descriptionHtml,
    guests: draft.guests,
    repeat: draft.repeat,
    reminders: draft.reminders,
  });
  // A new event's first version.
  vevent.updatePropertyWithValue("sequence", 0);
  addZones(ICAL, root);
  return root;
}

/**
 * Applies the editor's changes to a VEVENT (a series, a changed
 * occurrence, or a single event). A new start moves a series' rule along
 * (weekly on the new weekday). Changes guests would care about raise
 * `SEQUENCE`.
 */
export function changeEvent(
  context: WriteContext,
  vevent: IcalComponent,
  changes: EventChanges,
): void {
  const { ICAL } = context;
  let significant = false;
  if (changes.title !== undefined)
    setText(vevent, "summary", changes.title.trim());
  if (changes.start !== undefined) {
    const before = vevent.getFirstPropertyValue("dtstart") as IcalTime | null;
    const lines = ruleLines(vevent);
    if (before && lines.length > 0 && changes.repeat === undefined)
      setRuleLines(
        ICAL,
        vevent,
        retimeRule(lines, eventTime(before), changes.start),
      );
    setTime(ICAL, vevent, "dtstart", changes.start);
    significant = true;
  }
  if (changes.end !== undefined) {
    vevent.removeAllProperties("duration");
    setTime(ICAL, vevent, "dtend", changes.end);
    significant = true;
  }
  if (changes.location !== undefined) {
    setText(vevent, "location", changes.location.trim());
    significant = true;
  }
  if (changes.descriptionHtml !== undefined) {
    const html = changes.descriptionHtml.trim();
    const text = html ? textOfHtml(html) : "";
    setText(vevent, "description", text);
    vevent.removeAllProperties("x-alt-desc");
    if (html && /<[a-z]/i.test(html)) {
      const property = vevent.addPropertyWithValue("x-alt-desc", html);
      property.setParameter("fmttype", "text/html");
    }
  }
  if (changes.guests !== undefined) {
    setGuests(context, vevent, changes.guests);
    significant = true;
  }
  if (changes.repeat !== undefined && changes.repeat?.kind !== "custom") {
    const start = vevent.getFirstPropertyValue("dtstart") as IcalTime;
    setRuleLines(
      ICAL,
      vevent,
      changes.repeat ? [ruleOf(changes.repeat, eventTime(start))] : [],
    );
    if (!changes.repeat) vevent.removeAllProperties("exdate");
    significant = true;
  }
  if (changes.reminders !== undefined)
    setReminders(ICAL, vevent, changes.reminders);
  const stamp = utcTime(ICAL, context.now);
  vevent.updatePropertyWithValue("dtstamp", stamp);
  vevent.updatePropertyWithValue("last-modified", stamp);
  if (significant) bumpSequence(vevent);
}

/** Raises a VEVENT's `SEQUENCE` (a new version guests should get). */
export function bumpSequence(vevent: IcalComponent): void {
  const sequence = Number(vevent.getFirstPropertyValue("sequence") ?? 0);
  vevent.updatePropertyWithValue(
    "sequence",
    Number.isFinite(sequence) ? sequence + 1 : 1,
  );
}

function setText(vevent: IcalComponent, name: string, value: string) {
  if (value) vevent.updatePropertyWithValue(name, value);
  else vevent.removeAllProperties(name);
}

/** Replaces a VEVENT's `RRULE`s with these lines. */
export function setRuleLines(
  ICAL: Ical,
  vevent: IcalComponent,
  lines: readonly string[],
) {
  vevent.removeAllProperties("rrule");
  for (const line of lines)
    vevent.addPropertyWithValue(
      "rrule",
      ICAL.Recur.fromString(line.replace(/^RRULE:/i, "")),
    );
}

/** An event time as an iCalendar time, in the zone it's planned in. */
export function icalTime(ICAL: Ical, time: EventTime): IcalTime {
  if ("date" in time) return ICAL.Time.fromDateString(time.date);
  const zone = time.timeZone;
  if (!zone || !isKnownZone(zone))
    return utcTime(ICAL, Date.parse(time.dateTime));
  const wall = wallTime(Date.parse(time.dateTime), zone);
  const [year = 1970, month = 1, day = 1] = wall.date.split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = wall.time.split(":").map(Number);
  ensureZone(ICAL, zone, year);
  return ICAL.Time.fromData(
    { year, month, day, hour, minute, second, isDate: false },
    ICAL.TimezoneService.get(zone),
  );
}

function utcTime(ICAL: Ical, instant: number): IcalTime {
  return ICAL.Time.fromJSDate(new Date(instant), true);
}

/** Sets a date-time property (DTSTART, DTEND, RECURRENCE-ID, …) with its TZID. */
export function setTime(
  ICAL: Ical,
  component: IcalComponent,
  name: string,
  time: EventTime,
): IcalProperty {
  component.removeAllProperties(name);
  const value = icalTime(ICAL, time);
  const property = new ICAL.Property(name);
  property.setValue(value);
  setZoneParameter(property, value);
  component.addProperty(property);
  return property;
}

function setZoneParameter(property: IcalProperty, value: IcalTime) {
  const tzid = absent(value.zone)?.tzid;
  if (!value.isDate && tzid && tzid !== "UTC" && tzid !== "floating")
    property.setParameter("tzid", tzid);
  else property.removeParameter("tzid");
}

/** The attendees: guests keep their answers, new ones are asked; the user organizes. */
function setGuests(
  context: WriteContext,
  vevent: IcalComponent,
  guests: readonly EmailAddress[],
) {
  const { ICAL, me } = context;
  const lower = (value: unknown) =>
    (typeof value === "string" ? value : "")
      .replace(/^mailto:/i, "")
      .trim()
      .toLowerCase();
  const myAddress = me?.address.toLowerCase();
  const existing = vevent.getAllProperties("attendee");
  const wanted = new Set(guests.map((guest) => guest.address.toLowerCase()));
  for (const property of existing) {
    const address = lower(property.getFirstValue());
    const cutype = String(
      absent(property.getParameter("cutype")) ?? "",
    ).toUpperCase();
    // The user's own entry and rooms stay as they are.
    if (address === myAddress || cutype === "ROOM" || cutype === "RESOURCE")
      continue;
    if (!wanted.has(address)) vevent.removeProperty(property);
  }
  const kept = new Set(
    vevent
      .getAllProperties("attendee")
      .map((property) => lower(property.getFirstValue())),
  );
  for (const guest of guests) {
    if (kept.has(guest.address.toLowerCase())) continue;
    const property = new ICAL.Property("attendee");
    property.setValue(`mailto:${guest.address}`);
    if (guest.name) property.setParameter("cn", guest.name);
    property.setParameter("role", "REQ-PARTICIPANT");
    property.setParameter("partstat", "NEEDS-ACTION");
    property.setParameter("rsvp", "TRUE");
    vevent.addProperty(property);
  }
  const others = vevent
    .getAllProperties("attendee")
    .filter((property) => lower(property.getFirstValue()) !== myAddress);
  if (others.length === 0) {
    // No guests left: a plain event of the user's again.
    if (lower(vevent.getFirstPropertyValue("organizer")) === myAddress)
      vevent.removeAllProperties("organizer");
    return;
  }
  if (!vevent.hasProperty("organizer") && me) {
    const organizer = new ICAL.Property("organizer");
    organizer.setValue(`mailto:${me.address}`);
    if (me.name) organizer.setParameter("cn", me.name);
    vevent.addProperty(organizer);
  }
}

function setReminders(
  ICAL: Ical,
  vevent: IcalComponent,
  minutes: readonly number[],
) {
  for (const alarm of vevent.getAllSubcomponents("valarm")) {
    const action = String(
      alarm.getFirstPropertyValue("action") ?? "",
    ).toUpperCase();
    if (action === "DISPLAY" || action === "AUDIO")
      vevent.removeSubcomponent(alarm);
  }
  for (const before of minutes) {
    const alarm = new ICAL.Component("valarm");
    alarm.addPropertyWithValue("action", "DISPLAY");
    alarm.addPropertyWithValue(
      "trigger",
      ICAL.Duration.fromSeconds(-before * 60),
    );
    alarm.addPropertyWithValue(
      "description",
      String(vevent.getFirstPropertyValue("summary") ?? "Reminder"),
    );
    vevent.addSubcomponent(alarm);
  }
}

/** The VEVENT of a series' occurrence planned at `recurrenceId`, made if it has none. */
export function overrideFor(
  context: WriteContext,
  root: IcalComponent,
  master: IcalComponent,
  recurrenceId: IcalTime,
  start: IcalTime,
  end: IcalTime,
): IcalComponent {
  const { ICAL } = context;
  const existing = findOverride(root, master, recurrenceId);
  if (existing) return existing;
  const copy = ICAL.Component.fromString(master.toString());
  for (const name of ["rrule", "rdate", "exdate", "recurrence-id"])
    copy.removeAllProperties(name);
  const id = new ICAL.Property("recurrence-id");
  id.setValue(recurrenceId);
  setZoneParameter(id, recurrenceId);
  copy.addProperty(id);
  copy.removeAllProperties("duration");
  setTime(ICAL, copy, "dtstart", eventTime(start));
  setTime(ICAL, copy, "dtend", eventTime(end));
  root.addSubcomponent(copy);
  return copy;
}

/** A series' changed occurrence planned at `recurrenceId`, if there is one. */
export function findOverride(
  root: IcalComponent,
  master: IcalComponent,
  recurrenceId: IcalTime,
): IcalComponent | undefined {
  const uid = master.getFirstPropertyValue("uid");
  const at = recurrenceId.toJSDate().getTime();
  return root
    .getAllSubcomponents("vevent")
    .find(
      (vevent) =>
        vevent.getFirstPropertyValue("uid") === uid &&
        vevent.hasProperty("recurrence-id") &&
        (vevent.getFirstPropertyValue("recurrence-id") as IcalTime)
          .toJSDate()
          .getTime() === at,
    );
}

/** The series' VEVENT of an object (the one without RECURRENCE-ID), or its only one. */
export function masterOf(root: IcalComponent): IcalComponent | undefined {
  const vevents = root.getAllSubcomponents("vevent");
  return (
    vevents.find((vevent) => !vevent.hasProperty("recurrence-id")) ?? vevents[0]
  );
}

/** Leaves out the occurrence planned at `recurrenceId` (an EXDATE; its changed VEVENT goes). */
export function excludeOccurrence(
  context: WriteContext,
  root: IcalComponent,
  master: IcalComponent,
  recurrenceId: IcalTime,
): void {
  const override = findOverride(root, master, recurrenceId);
  if (override) root.removeSubcomponent(override);
  const exdate = new context.ICAL.Property("exdate");
  exdate.setValue(recurrenceId);
  setZoneParameter(exdate, recurrenceId);
  master.addProperty(exdate);
  changeEvent(context, master, {});
  bumpSequence(master);
}

/** Changed occurrences of the series planned at or after `at`. */
export function overridesFrom(
  root: IcalComponent,
  master: IcalComponent,
  at: number,
): IcalComponent[] {
  const uid = master.getFirstPropertyValue("uid");
  return root
    .getAllSubcomponents("vevent")
    .filter(
      (vevent) =>
        vevent.getFirstPropertyValue("uid") === uid &&
        vevent.hasProperty("recurrence-id") &&
        (vevent.getFirstPropertyValue("recurrence-id") as IcalTime)
          .toJSDate()
          .getTime() >= at,
    );
}

/**
 * Moves a whole series' changed occurrences and left-out dates by as much
 * as its start moved (`shift` ms; whole days for all-day series), so they
 * stay attached to the same occurrences.
 */
export function shiftSeries(
  ICAL: Ical,
  root: IcalComponent,
  master: IcalComponent,
  shift: number,
): void {
  if (shift === 0) return;
  const move = (component: IcalComponent, name: string) => {
    for (const property of component.getAllProperties(name)) {
      const value = property.getFirstValue() as IcalTime;
      const moved = value.clone();
      if (moved.isDate) moved.adjust(Math.round(shift / 86_400_000), 0, 0, 0);
      else moved.addDuration(ICAL.Duration.fromSeconds(shift / 1000));
      property.setValue(moved);
      setZoneParameter(property, moved);
    }
  };
  move(master, "exdate");
  const uid = master.getFirstPropertyValue("uid");
  for (const vevent of root.getAllSubcomponents("vevent"))
    if (
      vevent !== master &&
      vevent.getFirstPropertyValue("uid") === uid &&
      vevent.hasProperty("recurrence-id")
    )
      move(vevent, "recurrence-id");
}

/**
 * Sets the user's answer on every VEVENT of the object where they're an
 * attendee; false if they aren't one.
 */
export function answer(
  root: IcalComponent,
  me: ReadonlySet<string>,
  response: Rsvp,
): boolean {
  const value =
    response === "accepted"
      ? "ACCEPTED"
      : response === "tentative"
        ? "TENTATIVE"
        : "DECLINED";
  let found = false;
  for (const vevent of root.getAllSubcomponents("vevent"))
    for (const property of vevent.getAllProperties("attendee")) {
      const address = String(property.getFirstValue() ?? "")
        .replace(/^mailto:/i, "")
        .trim()
        .toLowerCase();
      if (!me.has(address)) continue;
      property.setParameter("partstat", value);
      property.removeParameter("rsvp");
      found = true;
    }
  return found;
}

/** Adds a VTIMEZONE for every zone the object names but doesn't define. */
export function addZones(ICAL: Ical, root: IcalComponent): void {
  const defined = new Set(
    root
      .getAllSubcomponents("vtimezone")
      .map((zone) => String(zone.getFirstPropertyValue("tzid"))),
  );
  const firstYear = Math.min(
    ...root
      .getAllSubcomponents("vevent")
      .map(
        (vevent) =>
          (vevent.getFirstPropertyValue("dtstart") as IcalTime | null)?.year ??
          new Date().getFullYear(),
      ),
    new Date().getFullYear(),
  );
  for (const tzid of zonesUsed(root)) {
    if (defined.has(tzid)) continue;
    const zone = zoneComponent(ICAL, tzid, firstYear);
    if (zone) root.addSubcomponent(zone);
  }
}

/** The text of an object with CRLF line ends (what servers expect). */
export function serialize(root: IcalComponent): string {
  const text = root.toString();
  return `${text.replace(/\r?\n/g, "\r\n")}\r\n`;
}

// ---------------------------------------------------------------- zones

function ensureZone(ICAL: Ical, tzid: string, year: number) {
  if (ICAL.TimezoneService.has(tzid)) return;
  const zone = zoneComponent(ICAL, tzid, year);
  if (zone) ICAL.TimezoneService.register(zone);
}

/** The TZIDs an object's events use. */
function zonesUsed(root: IcalComponent): Set<string> {
  const zones = new Set<string>();
  const visit = (component: IcalComponent) => {
    if (component.name === "vtimezone") return;
    for (const property of component.getAllProperties()) {
      const tzid = absent(property.getParameter("tzid"));
      if (typeof tzid === "string" && tzid) zones.add(tzid);
    }
    for (const child of component.getAllSubcomponents()) visit(child);
  };
  visit(root);
  return zones;
}

/**
 * A VTIMEZONE for an IANA zone the browser knows: its daylight-saving
 * changes in `year` as yearly rules (the "last Sunday of March" kind),
 * which is how zones are written in practice.
 */
export function zoneComponent(
  ICAL: Ical,
  tzid: string,
  year: number,
): IcalComponent | undefined {
  if (!isKnownZone(tzid) || tzid === "UTC") return undefined;
  const changes = changesIn(tzid, year);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  if (changes.length === 0) {
    const offset = offsetText(offsetAt(Date.UTC(year, 0, 1), tzid));
    lines.push(
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      "END:STANDARD",
    );
  }
  for (const change of changes) {
    const kind = change.after > change.before ? "DAYLIGHT" : "STANDARD";
    // The change as a clock before it shows it.
    const local = new Date(change.at + change.before);
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const weekday = local.getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
    const code = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekday] ?? "SU";
    const first = nthWeekday(1970, month, nth, weekday);
    const clock = local.toISOString().slice(11, 19).replace(/:/g, "");
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:1970${pad(month)}${pad(first)}T${clock}`,
      `RRULE:FREQ=YEARLY;BYMONTH=${String(month)};BYDAY=${String(nth)}${code}`,
      `TZOFFSETFROM:${offsetText(change.before)}`,
      `TZOFFSETTO:${offsetText(change.after)}`,
      `END:${kind}`,
    );
  }
  lines.push("END:VTIMEZONE");
  return ICAL.Component.fromString(lines.join("\r\n"));
}

/** "+0100" for an offset in ms. */
function offsetText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** The day of the month of the `nth` (−1: last) `weekday` in a month. */
function nthWeekday(
  year: number,
  month: number,
  nth: number,
  weekday: number,
): number {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0));
  return lastDay.getUTCDate() - ((lastDay.getUTCDay() - weekday + 7) % 7);
}

/** A zone's offset changes in a year: when (UTC ms), and the offsets before and after. */
function changesIn(
  tzid: string,
  year: number,
): { readonly at: number; readonly before: number; readonly after: number }[] {
  const DAY = 86_400_000;
  const changes = [];
  let previous = Date.UTC(year, 0, 1);
  let offset = offsetAt(previous, tzid);
  for (let day = 1; day <= 366; day++) {
    const next = Date.UTC(year, 0, 1) + day * DAY;
    const nextOffset = offsetAt(next, tzid);
    if (nextOffset !== offset) {
      // To the minute.
      let low = previous;
      let high = next;
      while (high - low > 60_000) {
        const middle = low + Math.floor((high - low) / 120_000) * 60_000;
        if (offsetAt(middle, tzid) === offset) low = middle;
        else high = middle;
      }
      changes.push({ at: high, before: offset, after: nextOffset });
      offset = nextOffset;
    }
    previous = next;
  }
  return changes;
}

// ---------------------------------------------------------------- text

/** Plain text of description HTML. */
export function textOfHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const br of doc.body.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of doc.body.querySelectorAll("p, div, li"))
    block.append("\n");
  return doc.body.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

/** Description text as HTML for the editor. */
export function htmlOfText(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n/)
    .map((line) => `<p>${line || "<br>"}</p>`)
    .join("");
}
