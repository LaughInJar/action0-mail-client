import { describe, expect, it } from "vitest";
import { asCalendarId, asEventId, type EventDraft } from "../../core/calendar";
import {
  answer,
  changeEvent,
  draftOf,
  excludeOccurrence,
  expandEvents,
  loadIcal,
  masterOf,
  newEventObject,
  overrideFor,
  readEvent,
  registerZones,
  serialize,
  shiftSeries,
  zoneComponent,
  type Ical,
  type IcalComponent,
} from "./icalendar";

const calendarId = asCalendarId("cal");
const me = { name: "Me", address: "me@example.com" };
const mine = new Set(["me@example.com"]);
const NOW = Date.parse("2026-10-18T12:00:00Z");

const draft: EventDraft = {
  calendarId,
  title: "Standup",
  start: { dateTime: "2026-10-19T07:00:00.000Z", timeZone: "Europe/Vienna" },
  end: { dateTime: "2026-10-19T07:30:00.000Z", timeZone: "Europe/Vienna" },
  location: "Room 1",
  descriptionHtml: "<p>Daily <b>sync</b></p>",
  guests: [{ name: "Anna", address: "anna@example.org" }],
  videoCall: false,
  repeat: { kind: "weekly" },
  reminders: [10],
};

/** The text with folded lines joined again. */
const unfolded = (root: IcalComponent) =>
  serialize(root).replace(/\r\n[ \t]/g, "");

/** Writes and reads back through text, as a server would keep it. */
async function roundTrip(
  root: IcalComponent,
): Promise<{ ICAL: Ical; root: IcalComponent }> {
  const ICAL = await loadIcal();
  const again = ICAL.Component.fromString(serialize(root));
  registerZones(ICAL, again);
  return { ICAL, root: again };
}

function events(
  ICAL: Ical,
  root: IcalComponent,
  from: string,
  to: string,
  place: { me?: ReadonlySet<string> } = { me: mine },
) {
  return expandEvents(ICAL, root, Date.parse(from), Date.parse(to)).map(
    (occurrence) =>
      readEvent(occurrence, {
        id: asEventId(occurrence.start.toICALString()),
        calendarId,
        ...place,
      }),
  );
}

describe("writing events", () => {
  it("writes a new event with its zone, guests, rule and reminder, and reads it back", async () => {
    const ICAL = await loadIcal();
    const text = unfolded(
      newEventObject({ ICAL, me, now: NOW }, draft, "uid-1"),
    );
    expect(text).toContain("DTSTART;TZID=Europe/Vienna:20261019T090000");
    expect(text).toContain("BEGIN:VTIMEZONE");
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(text).toMatch(/ATTENDEE;.*CN=Anna.*:mailto:anna@example\.org/);
    expect(text).toContain("ORGANIZER;CN=Me:mailto:me@example.com");
    expect(text).toContain("TRIGGER:-PT10M");
    expect(text).toContain("DESCRIPTION:Daily sync");
    expect(text).toMatch(/\r\n$/);

    const { ICAL: again, root } = await roundTrip(
      newEventObject({ ICAL, me, now: NOW }, draft, "uid-1"),
    );
    const [first] = events(
      again,
      root,
      "2026-10-19T00:00:00Z",
      "2026-10-20T00:00:00Z",
    );
    expect(first).toMatchObject({
      title: "Standup",
      start: {
        dateTime: "2026-10-19T07:00:00.000Z",
        timeZone: "Europe/Vienna",
      },
      location: "Room 1",
      description: { html: "<p>Daily <b>sync</b></p>" },
      organizedByMe: true,
      recurring: true,
      reminders: [10],
      uid: "uid-1",
    });
    expect(first?.myResponse).toBeUndefined();
  });

  it("keeps the clock time of a weekly series across the change from summer time", async () => {
    const ICAL = await loadIcal();
    const { root } = await roundTrip(
      newEventObject({ ICAL, me, now: NOW }, draft, "uid-2"),
    );
    const starts = events(
      ICAL,
      root,
      "2026-10-19T00:00:00Z",
      "2026-11-03T00:00:00Z",
    ).map((event) => "dateTime" in event.start && event.start.dateTime);
    // 09:00 in Vienna: UTC+2 before 25 October, UTC+1 after.
    expect(starts).toEqual([
      "2026-10-19T07:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
      "2026-11-02T08:00:00.000Z",
    ]);
  });

  it("makes time zones with yearly daylight-saving rules", async () => {
    const ICAL = await loadIcal();
    const text = zoneComponent(ICAL, "Europe/Vienna", 2026)?.toString() ?? "";
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU");
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
    expect(text).toContain("TZOFFSETTO:+0200");
    const tokyo = zoneComponent(ICAL, "Asia/Tokyo", 2026)?.toString() ?? "";
    expect(tokyo).toContain("TZOFFSETTO:+0900");
    expect(tokyo).not.toContain("RRULE");
  });

  it("changes one occurrence, leaves one out, and moves a whole series with them", async () => {
    const ICAL = await loadIcal();
    const context = { ICAL, me, now: NOW };
    const { root } = await roundTrip(newEventObject(context, draft, "uid-3"));
    const master = masterOf(root)!;
    const [, second, third] = expandEvents(
      ICAL,
      root,
      Date.parse("2026-10-19T00:00:00Z"),
      Date.parse("2026-11-03T00:00:00Z"),
    );
    // The second one an hour later, the third one left out.
    const override = overrideFor(
      context,
      root,
      master,
      second!.recurrenceId!,
      second!.start,
      second!.end,
    );
    changeEvent(context, override, {
      start: {
        dateTime: "2026-10-26T09:00:00.000Z",
        timeZone: "Europe/Vienna",
      },
      end: { dateTime: "2026-10-26T09:30:00.000Z", timeZone: "Europe/Vienna" },
      title: "Late standup",
    });
    excludeOccurrence(context, root, master, third!.recurrenceId!);
    const { root: saved } = await roundTrip(root);
    const shown = events(
      ICAL,
      saved,
      "2026-10-19T00:00:00Z",
      "2026-11-03T00:00:00Z",
    );
    expect(shown.map((event) => event.title)).toEqual([
      "Standup",
      "Late standup",
    ]);

    // The series a day later: the change and the gap move along.
    const savedMaster = masterOf(saved)!;
    changeEvent(context, savedMaster, {
      start: {
        dateTime: "2026-10-20T07:00:00.000Z",
        timeZone: "Europe/Vienna",
      },
      end: { dateTime: "2026-10-20T07:30:00.000Z", timeZone: "Europe/Vienna" },
    });
    shiftSeries(ICAL, saved, savedMaster, 86_400_000);
    const moved = events(
      ICAL,
      (await roundTrip(saved)).root,
      "2026-10-19T00:00:00Z",
      "2026-11-04T00:00:00Z",
    );
    expect(
      moved.map((event) => [
        event.title,
        "dateTime" in event.start && event.start.dateTime,
      ]),
    ).toEqual([
      ["Standup", "2026-10-20T07:00:00.000Z"],
      ["Late standup", "2026-10-26T09:00:00.000Z"],
    ]);
    expect(serialize(saved)).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");
  });

  it("keeps guests' answers when guests change, and drops the organizer with the last guest", async () => {
    const ICAL = await loadIcal();
    const context = { ICAL, me, now: NOW };
    const root = newEventObject(context, draft, "uid-4");
    const vevent = masterOf(root)!;
    vevent.getFirstProperty("attendee")!.setParameter("partstat", "ACCEPTED");
    changeEvent(context, vevent, {
      guests: [
        { address: "anna@example.org" },
        { name: "Ben", address: "ben@example.net" },
      ],
    });
    const text = unfolded(root);
    expect(text).toMatch(/PARTSTAT=ACCEPTED.*anna@example\.org/);
    expect(text).toMatch(/PARTSTAT=NEEDS-ACTION.*ben@example\.net/);
    expect(text).toContain("SEQUENCE:1");
    changeEvent(context, vevent, { guests: [] });
    expect(serialize(root)).not.toContain("ATTENDEE");
    expect(serialize(root)).not.toContain("ORGANIZER");
  });

  it("answers an invitation and reads the editor's fields back", async () => {
    const ICAL = await loadIcal();
    const invitation = ICAL.Component.fromString(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:inv-1",
        "DTSTAMP:20261018T120000Z",
        "DTSTART:20261020T100000Z",
        "DTEND:20261020T110000Z",
        "SUMMARY:Review",
        "ORGANIZER;CN=Anna:mailto:anna@example.org",
        "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ME@example.com",
        "ATTENDEE;CUTYPE=ROOM:mailto:room@example.org",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const [event] = events(
      ICAL,
      invitation,
      "2026-10-20T00:00:00Z",
      "2026-10-21T00:00:00Z",
    );
    expect(event).toMatchObject({
      organizedByMe: false,
      myResponse: "needsAction",
    });
    expect(answer(invitation, mine, "tentative")).toBe(true);
    expect(serialize(invitation)).toContain(
      "ATTENDEE;PARTSTAT=TENTATIVE:mailto:ME@example.com",
    );
    const [occurrence] = expandEvents(
      ICAL,
      invitation,
      Date.parse("2026-10-20T00:00:00Z"),
      Date.parse("2026-10-21T00:00:00Z"),
    );
    expect(
      draftOf(occurrence!, masterOf(invitation)!, calendarId, mine),
    ).toMatchObject({
      title: "Review",
      guests: [],
      repeat: null,
      descriptionHtml: "",
    });
  });
});
