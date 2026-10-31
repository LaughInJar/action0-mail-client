/**
 * Invitations, updates, cancellations and answers as mail (iMIP, RFC 6047
 * over iTIP, RFC 5546), for calendar servers that don't send them
 * themselves: the iCalendar part with its `METHOD`, and a short text in
 * the app's language next to it.
 */
import type { Rsvp } from "../../core/calendar";
import type { EmailAddress } from "../../core/model";
import type { CalendarMail } from "../../core/provider";
import {
  absent,
  calendarAddress,
  eventTime,
  serialize,
  type Ical,
  type IcalComponent,
  type IcalTime,
} from "../ical/icalendar";

/** Sends a calendar mail from one of the user's accounts. */
export type CalendarMailer = (mail: CalendarMail) => Promise<void>;

/** What the mails say, in the app's language (wired in `src/app`). */
export interface ItipTexts {
  /** BCP 47, for dates and times. */
  readonly locale: string;
  readonly request: (title: string) => string;
  readonly update: (title: string) => string;
  readonly cancel: (title: string) => string;
  readonly reply: (name: string, answer: Rsvp, title: string) => string;
  /** "When", "Where" and "Organizer" in the text. */
  readonly when: string;
  readonly where: string;
  readonly organizer: string;
}

const lower = (value: unknown) =>
  (typeof value === "string" ? value : "")
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();

/** The guests of an object's events (not the user, not the organizer), by address. */
export function guestsOf(
  root: IcalComponent,
  me: ReadonlySet<string>,
): EmailAddress[] {
  const found = new Map<string, EmailAddress>();
  for (const vevent of root.getAllSubcomponents("vevent")) {
    const organizer = lower(vevent.getFirstPropertyValue("organizer"));
    for (const property of vevent.getAllProperties("attendee")) {
      const address = calendarAddress(
        property.getFirstValue(),
        property.getParameter("cn"),
      );
      if (!address) continue;
      const key = address.address.toLowerCase();
      if (me.has(key) || key === organizer) continue;
      found.set(key, address);
    }
  }
  return [...found.values()];
}

/** The organizer of an object's events, if it has one. */
export function organizerOf(root: IcalComponent): EmailAddress | undefined {
  for (const vevent of root.getAllSubcomponents("vevent")) {
    const property = vevent.getFirstProperty("organizer");
    const address = calendarAddress(
      property?.getFirstValue(),
      property?.getParameter("cn"),
    );
    if (address) return address;
  }
  return undefined;
}

/**
 * Whether the user's client sends the mails for this object: RFC 6638's
 * `SCHEDULE-AGENT=CLIENT` on its organizer (set on invitations added from
 * mail, so a scheduling server doesn't answer a second time).
 */
export function clientScheduled(root: IcalComponent): boolean {
  return root
    .getAllSubcomponents("vevent")
    .some(
      (vevent) =>
        String(
          absent(
            vevent
              .getFirstProperty("organizer")
              ?.getParameter("schedule-agent"),
          ) ?? "",
        ).toUpperCase() === "CLIENT",
    );
}

/** Marks an object's organizer as handled by the client (see {@link clientScheduled}). */
export function markClientScheduled(root: IcalComponent): void {
  for (const vevent of root.getAllSubcomponents("vevent"))
    vevent
      .getFirstProperty("organizer")
      ?.setParameter("schedule-agent", "CLIENT");
}

/** A copy of an object as an iTIP message with this `METHOD`. */
function message(
  ICAL: Ical,
  root: IcalComponent,
  method: "REQUEST" | "CANCEL" | "REPLY",
): IcalComponent {
  const copy = ICAL.Component.fromString(root.toString());
  copy.updatePropertyWithValue("method", method);
  return copy;
}

/** An invitation or update of the whole object, to these guests. */
export function requestMail(
  ICAL: Ical,
  root: IcalComponent,
  from: EmailAddress,
  to: readonly EmailAddress[],
  texts: ItipTexts,
  update: boolean,
): CalendarMail {
  const copy = message(ICAL, root, "REQUEST");
  const title = titleOf(root);
  return mail(
    from,
    to,
    update ? texts.update(title) : texts.request(title),
    summary(root, texts),
    { method: "REQUEST", ics: serialize(copy) },
  );
}

/**
 * A cancellation: of the whole object, or of the occurrences planned at
 * `recurrenceIds`, to these guests.
 */
export function cancelMail(
  ICAL: Ical,
  root: IcalComponent,
  from: EmailAddress,
  to: readonly EmailAddress[],
  texts: ItipTexts,
  recurrenceIds: readonly IcalTime[] = [],
): CalendarMail {
  const copy = message(ICAL, root, "CANCEL");
  const vevents = copy.getAllSubcomponents("vevent");
  const master =
    vevents.find((vevent) => !vevent.hasProperty("recurrence-id")) ??
    vevents[0];
  for (const vevent of vevents) copy.removeSubcomponent(vevent);
  const cancelled = (vevent: IcalComponent) => {
    vevent.updatePropertyWithValue("status", "CANCELLED");
    // Guests taken off the event still need to see who cancels, and for whom.
    if (!vevent.hasProperty("organizer")) {
      const organizer = vevent.addPropertyWithValue(
        "organizer",
        `mailto:${from.address}`,
      );
      if (from.name) organizer.setParameter("cn", from.name);
    }
    const listed = new Set(
      vevent
        .getAllProperties("attendee")
        .map((property) => lower(property.getFirstValue())),
    );
    for (const guest of to)
      if (!listed.has(guest.address.toLowerCase())) {
        const attendee = vevent.addPropertyWithValue(
          "attendee",
          `mailto:${guest.address}`,
        );
        if (guest.name) attendee.setParameter("cn", guest.name);
      }
    for (const name of ["rrule", "exdate", "valarm"])
      vevent.removeAllProperties(name);
    for (const alarm of vevent.getAllSubcomponents("valarm"))
      vevent.removeSubcomponent(alarm);
    copy.addSubcomponent(vevent);
  };
  if (master && recurrenceIds.length === 0) cancelled(master);
  else if (master)
    for (const id of recurrenceIds) {
      const one = ICAL.Component.fromString(master.toString());
      one.removeAllProperties("rrule");
      one.removeAllProperties("exdate");
      const property = one.addPropertyWithValue("recurrence-id", id);
      const tzid = absent(id.zone)?.tzid;
      if (!id.isDate && tzid && tzid !== "UTC" && tzid !== "floating")
        property.setParameter("tzid", tzid);
      cancelled(one);
    }
  const title = titleOf(root);
  return mail(from, to, texts.cancel(title), summary(root, texts), {
    method: "CANCEL",
    ics: serialize(copy),
  });
}

/**
 * The user's answer to the organizer: their attendee entry only, sent
 * from that address (with `name` where the entry has none).
 */
export function replyMail(
  ICAL: Ical,
  root: IcalComponent,
  me: ReadonlySet<string>,
  answer: Rsvp,
  texts: ItipTexts,
  name?: string,
): CalendarMail | undefined {
  const organizer = organizerOf(root);
  if (!organizer) return undefined;
  const copy = message(ICAL, root, "REPLY");
  let from: EmailAddress | undefined;
  for (const vevent of copy.getAllSubcomponents("vevent")) {
    for (const alarm of vevent.getAllSubcomponents("valarm"))
      vevent.removeSubcomponent(alarm);
    for (const property of vevent.getAllProperties("attendee")) {
      const address = calendarAddress(
        property.getFirstValue(),
        property.getParameter("cn"),
      );
      if (address && me.has(address.address.toLowerCase())) from ??= address;
      else vevent.removeProperty(property);
    }
  }
  if (!from) return undefined;
  if (!from.name && name) from = { ...from, name };
  const title = titleOf(root);
  return mail(
    from,
    [organizer],
    texts.reply(from.name ?? from.address, answer, title),
    summary(root, texts),
    { method: "REPLY", ics: serialize(copy) },
  );
}

function titleOf(root: IcalComponent): string {
  const master = root.getAllSubcomponents("vevent")[0];
  return String(master?.getFirstPropertyValue("summary") ?? "");
}

/** When, where and who, for the text of the mail. */
function summary(root: IcalComponent, texts: ItipTexts): string[] {
  const master = root.getAllSubcomponents("vevent")[0];
  if (!master) return [];
  const lines: string[] = [];
  const start = master.getFirstPropertyValue("dtstart") as IcalTime | null;
  if (start) {
    const time = eventTime(start);
    const format = new Intl.DateTimeFormat(
      texts.locale,
      "date" in time
        ? { dateStyle: "full" }
        : { dateStyle: "full", timeStyle: "long" },
    );
    const date =
      "date" in time
        ? new Date(`${time.date}T00:00:00`)
        : new Date(time.dateTime);
    lines.push(`${texts.when}: ${format.format(date)}`);
  }
  const location = master.getFirstPropertyValue("location");
  if (typeof location === "string" && location)
    lines.push(`${texts.where}: ${location}`);
  const organizer = organizerOf(root);
  if (organizer)
    lines.push(
      `${texts.organizer}: ${organizer.name ? `${organizer.name} <${organizer.address}>` : organizer.address}`,
    );
  return lines;
}

function mail(
  from: EmailAddress,
  to: readonly EmailAddress[],
  subject: string,
  lines: readonly string[],
  calendar: CalendarMail["calendar"],
): CalendarMail {
  const all = [subject, "", ...lines];
  const html = all
    .map((line) =>
      line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    )
    .map((line, index) => (index === 0 ? `<p><b>${line}</b></p>` : line))
    .join("<br>");
  return {
    from,
    to,
    subject,
    text: all.join("\n"),
    html: `<div>${html}</div>`,
    calendar,
  };
}
