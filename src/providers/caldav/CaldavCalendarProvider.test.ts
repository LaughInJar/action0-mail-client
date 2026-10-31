import { describe, expect, it, vi } from "vitest";
import {
  asCalendarId,
  type CalendarEvent,
  type EventDraft,
} from "../../core/calendar";
import { isMailError } from "../../core/errors";
import type { CalendarMail } from "../../core/provider";
import {
  DAV_HOME,
  fakeDavServer,
  icsEvent,
  type FakeDavOptions,
} from "../../test/davServer";
import { CaldavCalendarProvider } from "./CaldavCalendarProvider";
import type { ItipTexts } from "./itip";
import { createCalendarServers } from "./servers";

const KEY = "imap:me@example.com";
const PERSONAL = asCalendarId(`${DAV_HOME}personal/`);
const OCTOBER = {
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-11-01T00:00:00.000Z",
};

const texts: ItipTexts = {
  locale: "en-US",
  request: (title) => `Invitation: ${title}`,
  update: (title) => `Updated: ${title}`,
  cancel: (title) => `Cancelled: ${title}`,
  reply: (name, answer, title) => `${name} ${answer}: ${title}`,
  when: "When",
  where: "Where",
  organizer: "Organizer",
};

async function setup(
  options: FakeDavOptions = {},
  extra: { mailer?: boolean; now?: () => number } = {},
) {
  const server = fakeDavServer({ connected: [KEY], ...options });
  const servers = createCalendarServers(server.bridge);
  await servers.ready;
  const mails: CalendarMail[] = [];
  const provider = new CaldavCalendarProvider({
    bridge: server.bridge,
    key: KEY,
    servers,
    identity: () => ({
      me: { name: "Me", address: "me@example.com" },
      addresses: ["me@example.com"],
    }),
    mailerFor: (address) =>
      extra.mailer === false || address.toLowerCase() !== "me@example.com"
        ? undefined
        : (mail) => {
            mails.push(mail);
            return Promise.resolve();
          },
    texts: () => texts,
    ...(extra.now ? { now: extra.now } : {}),
  });
  return { server, servers, provider, mails };
}

const weekly = icsEvent({
  uid: "standup",
  start: "20261005T070000Z",
  end: "20261005T073000Z",
  summary: "Standup",
  extra: ["RRULE:FREQ=WEEKLY;COUNT=4"],
});

const draft: EventDraft = {
  calendarId: PERSONAL,
  title: "Lunch",
  start: { dateTime: "2026-10-14T10:00:00.000Z", timeZone: "Europe/Vienna" },
  end: { dateTime: "2026-10-14T11:00:00.000Z", timeZone: "Europe/Vienna" },
  location: "",
  descriptionHtml: "",
  guests: [],
  videoCall: false,
  repeat: null,
  reminders: [],
};

const titles = (events: readonly CalendarEvent[]) =>
  events.map((event) => event.title).sort();

describe("CaldavCalendarProvider", () => {
  it("lists the server's event calendars, writable ones first as the primary", async () => {
    const { provider } = await setup({
      calendars: [
        { name: "holidays", displayName: "Holidays", readOnly: true },
        { name: "personal", displayName: "Personal", color: "#33b679ff" },
      ],
    });
    expect(provider.access()).toBe("granted");
    expect(await provider.listCalendars()).toEqual([
      expect.objectContaining({
        name: "Holidays",
        readOnly: true,
        primary: false,
      }),
      expect.objectContaining({
        id: PERSONAL,
        name: "Personal",
        color: "#33b679",
        readOnly: false,
        primary: true,
      }),
    ]);
  });

  it("is missing until the server is set up", async () => {
    const { provider } = await setup({ connected: [] });
    expect(provider.access()).toBe("missing");
    expect(provider.setup).toBe("server");
  });

  it("expands series and follows changes made elsewhere, with the change list or ETags", async () => {
    for (const syncable of [true, false]) {
      let now = 0;
      const { provider, server } = await setup(
        { syncable, objects: { personal: { "standup.ics": weekly } } },
        { now: () => now },
      );
      await provider.listCalendars();
      const first = await provider.listEvents([PERSONAL], OCTOBER);
      expect(first.map((event) => event.title)).toEqual(
        Array(4).fill("Standup"),
      );
      expect(first[0]).toMatchObject({ recurring: true, organizedByMe: true });

      server.edit(
        "personal",
        "lunch.ics",
        icsEvent({
          uid: "lunch",
          start: "20261014T100000Z",
          end: "20261014T110000Z",
          summary: "Lunch",
        }),
      );
      server.remove("personal", "standup.ics");
      // Checked again once it's a while ago.
      now += 60_000;
      expect(titles(await provider.listEvents([PERSONAL], OCTOBER))).toEqual([
        "Lunch",
      ]);
    }
  });

  it("creates, changes and deletes events, each undoable", async () => {
    const { provider, server } = await setup();
    await provider.listCalendars();
    const created = await provider.createEvent(draft, { notify: false });
    const [file] = Object.keys(server.files("personal"));
    expect(server.text("personal", file!)).toContain(
      "DTSTART;TZID=Europe/Vienna:20261014T120000",
    );
    expect(created.event).toMatchObject({
      title: "Lunch",
      calendarId: PERSONAL,
    });

    const changed = await provider.updateEvent(
      created.event,
      { title: "Long lunch" },
      "all",
      { notify: false },
    );
    expect(server.text("personal", file!)).toContain("SUMMARY:Long lunch");
    await changed.undo({ notify: false });
    expect(server.text("personal", file!)).toContain("SUMMARY:Lunch");

    const deleted = await provider.deleteEvent(created.event, "all", {
      notify: false,
    });
    expect(server.files("personal")).toEqual({});
    await deleted.undo({ notify: false });
    expect(Object.keys(server.files("personal"))).toEqual([file]);

    await created.undo({ notify: false });
    expect(server.files("personal")).toEqual({});
  });

  it("changes one occurrence, the following ones, or a whole series", async () => {
    const { provider, server } = await setup({
      objects: { personal: { "standup.ics": weekly } },
    });
    await provider.listCalendars();
    const events = await provider.listEvents([PERSONAL], OCTOBER);
    const [, second, third] = events;

    await provider.updateEvent(second!, { title: "Retro" }, "this", {
      notify: false,
    });
    expect(
      (await provider.listEvents([PERSONAL], OCTOBER)).map((e) => e.title),
    ).toEqual(["Standup", "Retro", "Standup", "Standup"]);

    // From the third on: a new series of its own (two left of COUNT=4).
    await provider.updateEvent(third!, { title: "Daily" }, "following", {
      notify: false,
    });
    expect(Object.keys(server.files("personal"))).toHaveLength(2);
    const after = await provider.listEvents([PERSONAL], OCTOBER);
    expect(after.map((e) => e.title).sort()).toEqual([
      "Daily",
      "Daily",
      "Retro",
      "Standup",
    ]);
    expect(server.text("personal", "standup.ics")).toContain("UNTIL=");

    // Deleting one occurrence of the first series.
    const standup = after.find((e) => e.title === "Standup")!;
    await provider.deleteEvent(standup, "this", { notify: false });
    expect(server.text("personal", "standup.ics")).toContain("EXDATE");
  });

  it("refuses to overwrite a change made elsewhere and says so", async () => {
    const { provider, server } = await setup({
      objects: {
        personal: {
          "lunch.ics": icsEvent({
            uid: "lunch",
            start: "20261014T100000Z",
            end: "20261014T110000Z",
            summary: "Lunch",
          }),
        },
      },
    });
    await provider.listCalendars();
    const [lunch] = await provider.listEvents([PERSONAL], OCTOBER);
    server.edit(
      "personal",
      "lunch.ics",
      icsEvent({
        uid: "lunch",
        start: "20261014T100000Z",
        end: "20261014T110000Z",
        summary: "Lunch with Anna",
      }),
    );
    const error: unknown = await provider
      .updateEvent(lunch!, { title: "Mine" }, "all", { notify: false })
      .catch((e: unknown) => e);
    expect(isMailError(error) && error.reason).toBe("eventChanged");
    expect(server.text("personal", "lunch.ics")).toContain("Lunch with Anna");
    // The calendar was read again.
    expect(titles(await provider.listEvents([PERSONAL], OCTOBER))).toEqual([
      "Lunch with Anna",
    ]);
  });

  it("invites guests by mail when the server doesn't, only when asked to", async () => {
    const { provider, mails } = await setup();
    expect(provider.guestNotices).toBe("ask");
    await provider.listCalendars();
    const guests = [{ name: "Anna", address: "anna@example.org" }];
    const quiet = await provider.createEvent(
      { ...draft, guests },
      { notify: false },
    );
    expect(mails).toEqual([]);
    const created = await provider.createEvent(
      { ...draft, title: "Planning", guests },
      { notify: true },
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      from: { address: "me@example.com" },
      to: guests,
      subject: "Invitation: Planning",
      calendar: { method: "REQUEST" },
    });
    expect(mails[0]?.calendar.ics).toContain("METHOD:REQUEST");

    await provider.updateEvent(created.event, { guests: [] }, "all", {
      notify: true,
    });
    expect(mails[1]).toMatchObject({
      to: guests,
      calendar: { method: "CANCEL" },
    });
    await provider.deleteEvent(quiet.event, "all", { notify: true });
    expect(mails.at(-1)?.calendar.method).toBe("CANCEL");
  });

  it("leaves guests to a server that schedules, and says when nobody can tell them", async () => {
    const scheduling = await setup({ scheduling: true });
    expect(scheduling.provider.guestNotices).toBe("always");
    await scheduling.provider.listCalendars();
    await scheduling.provider.createEvent(
      { ...draft, guests: [{ address: "anna@example.org" }] },
      { notify: true },
    );
    expect(scheduling.mails).toEqual([]);

    const unsent = await setup({}, { mailer: false });
    expect(unsent.provider.guestNotices).toBe("never");
  });

  it("answers an invitation from a mail: saved with the answer, the reply sent by mail", async () => {
    const { provider, server, mails } = await setup({ scheduling: true });
    await provider.listCalendars();
    const invitation = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:review-1",
      "DTSTAMP:20261001T000000Z",
      "DTSTART:20261020T100000Z",
      "DTEND:20261020T110000Z",
      "SUMMARY:Review",
      "ORGANIZER;CN=Anna:mailto:anna@example.org",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const found = await provider.findInvitation(
      "review-1",
      undefined,
      invitation,
    );
    expect(found).toMatchObject({
      title: "Review",
      inCalendar: false,
      myResponse: "needsAction",
      calendarId: PERSONAL,
    });
    expect(await provider.findInvitation("review-1")).toBeUndefined();

    const answered = await provider.respond(found!, "accepted");
    expect(answered).toMatchObject({ myResponse: "accepted" });
    expect(answered.inCalendar).toBeUndefined();
    const saved = server.text("personal", "review-1.ics") ?? "";
    expect(saved).toContain("PARTSTAT=ACCEPTED");
    expect(saved).toContain("SCHEDULE-AGENT=CLIENT");
    expect(saved).not.toContain("METHOD");
    // Added from a mail, so the answer goes by mail even here.
    expect(mails).toEqual([
      expect.objectContaining({
        to: [{ name: "Anna", address: "anna@example.org" }],
        calendar: expect.objectContaining({ method: "REPLY" }) as unknown,
      }),
    ]);
    expect(await provider.findInvitation("review-1")).toMatchObject({
      myResponse: "accepted",
    });
  });

  it("lets a scheduling server answer invitations it put into the calendar", async () => {
    const send = vi.fn();
    const { provider, server, mails } = await setup({
      scheduling: true,
      objects: {
        personal: {
          "inv.ics": icsEvent({
            uid: "inv",
            start: "20261020T100000Z",
            end: "20261020T110000Z",
            summary: "Board",
            extra: [
              "ORGANIZER:mailto:boss@example.org",
              "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
            ],
          }),
        },
      },
    });
    await provider.listCalendars();
    const [event] = await provider.listEvents([PERSONAL], OCTOBER);
    expect(event).toMatchObject({
      organizedByMe: false,
      myResponse: "needsAction",
    });
    await provider.respond(event!, "declined");
    expect(server.text("personal", "inv.ics")).toContain("PARTSTAT=DECLINED");
    expect(mails).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("takes a guest's answer mail into the event when it sends the mails itself", async () => {
    const { provider, server } = await setup();
    await provider.listCalendars();
    const { event } = await provider.createEvent(
      { ...draft, guests: [{ address: "anna@example.org" }] },
      { notify: false },
    );
    const reply = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REPLY",
      "BEGIN:VEVENT",
      `UID:${event.uid ?? ""}`,
      "DTSTAMP:20261010T000000Z",
      "DTSTART:20261014T100000Z",
      "ORGANIZER:mailto:me@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:anna@example.org",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const updated = await provider.applyReply(reply);
    expect(updated?.attendees).toEqual([
      expect.objectContaining({ response: "accepted" }),
    ]);
    const [file] = Object.keys(server.files("personal"));
    expect(server.text("personal", file!)).toContain("PARTSTAT=ACCEPTED");
  });
});
