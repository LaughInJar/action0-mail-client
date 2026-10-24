// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MicrosoftAuthSession } from "../../auth/microsoft/MicrosoftAuthSession";
import { StaticAuthSession } from "../../auth/staticSession";
import { asCalendarId, asEventId } from "../../core/calendar";
import {
  GraphCalendarProvider,
  toCalendarEvent,
  type GraphEvent,
} from "./calendar";
import { GRAPH_BASE, GraphHttp } from "./http";
import { loadZones } from "./zones";

const server = setupServer();
beforeAll(async () => {
  server.listen({ onUnhandledFrame: "error" });
  // Tests map events themselves too.
  await loadZones();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const url = (path: string) => `${GRAPH_BASE}${path}`;

function setup() {
  const session = {
    hasScopes: () => true,
    requestScopes: () => Promise.resolve(),
    subscribe: () => () => undefined,
    loginHint: "max@contoso.com",
  } as unknown as MicrosoftAuthSession;
  const tokens: string[] = [];
  const provider = new GraphCalendarProvider(
    new GraphHttp({
      auth: new StaticAuthSession(),
      token: () => {
        tokens.push("calendar");
        return Promise.resolve("calendar-token");
      },
      sleep: () => Promise.resolve(),
    }),
    session,
  );
  return { provider, tokens };
}

const event: GraphEvent = {
  id: "AAMk-1",
  subject: "Quarterly planning",
  start: { dateTime: "2026-10-19T08:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-10-19T09:30:00.0000000", timeZone: "UTC" },
  originalStartTimeZone: "W. Europe Standard Time",
  isAllDay: false,
  isOrganizer: false,
  type: "singleInstance",
  location: { displayName: "Board room" },
  body: { contentType: "html", content: "<p>Bring numbers</p>" },
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/1" },
  organizer: { emailAddress: { name: "Jonas", address: "jonas@contoso.com" } },
  attendees: [
    {
      type: "required",
      status: { response: "accepted" },
      emailAddress: { name: "Anna", address: "anna@contoso.com" },
    },
    {
      type: "optional",
      status: { response: "none" },
      emailAddress: { name: "Max", address: "max@contoso.com" },
    },
  ],
  responseStatus: { response: "notResponded" },
  iCalUId: "planning@contoso.com",
  webLink: "https://outlook.office365.com/owa/?itemid=1",
};

describe("GraphCalendarProvider", () => {
  it("lists calendars with their colours, the default first", async () => {
    server.use(
      http.get(url("me/calendars"), () =>
        HttpResponse.json({
          value: [
            {
              id: "birthdays",
              name: "Birthdays",
              color: "lightGreen",
              hexColor: "",
              canEdit: false,
            },
            {
              id: "cal",
              name: "Calendar",
              hexColor: "#4f8ad9",
              isDefaultCalendar: true,
              canEdit: true,
            },
          ],
        }),
      ),
    );
    const { provider, tokens } = setup();
    expect(await provider.listCalendars()).toEqual([
      {
        id: "cal",
        name: "Calendar",
        color: "#4f8ad9",
        primary: true,
        shownByDefault: true,
        readOnly: false,
        // Outlook's default for new events.
        defaultReminders: [15],
      },
      {
        id: "birthdays",
        name: "Birthdays",
        color: "#5fb25f",
        primary: false,
        shownByDefault: true,
        readOnly: true,
        defaultReminders: [15],
      },
    ]);
    // Calendar requests use the calendar token.
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("lists the calendar view in UTC and maps events", async () => {
    let prefer: string | null = null;
    server.use(
      http.get(url("me/calendars/cal/calendarView"), ({ request }) => {
        prefer = request.headers.get("Prefer");
        return HttpResponse.json({
          value: [
            event,
            {
              ...event,
              id: "AAMk-2",
              subject: "Holiday",
              isAllDay: true,
              start: { dateTime: "2026-10-26T00:00:00.0000000" },
              end: { dateTime: "2026-10-27T00:00:00.0000000" },
              type: "occurrence",
            },
            { ...event, id: "AAMk-3", isCancelled: true },
          ],
        });
      }),
    );
    const events = await setup().provider.listEvents([asCalendarId("cal")], {
      from: "2026-10-19T00:00:00Z",
      to: "2026-10-27T00:00:00Z",
    });
    expect(prefer).toContain('outlook.timezone="UTC"');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      title: "Quarterly planning",
      start: {
        dateTime: "2026-10-19T08:00:00.000Z",
        // Outlook's Windows zone, as the IANA zone it stands for.
        timeZone: "Europe/Berlin",
      },
      location: "Board room",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/1",
      myResponse: "needsAction",
      description: { html: "<p>Bring numbers</p>" },
      uid: "planning@contoso.com",
    });
    expect(events[0]?.attendees[1]).toMatchObject({
      optional: true,
      response: "needsAction",
    });
    expect(events[1]).toMatchObject({
      start: { date: "2026-10-26" },
      end: { date: "2026-10-27" },
      recurring: true,
    });
  });

  it("accepts, tentatively accepts and declines with a response to the organizer", async () => {
    const calls: { action: string; body: unknown }[] = [];
    server.use(
      http.post(url("me/events/:id/:action"), async ({ params, request }) => {
        calls.push({
          action: String(params.action),
          body: await request.json(),
        });
        return new HttpResponse(null, { status: 202 });
      }),
      http.get(url("me/events"), () =>
        HttpResponse.json({ value: [{ ...event, calendar: { id: "cal" } }] }),
      ),
    );
    const { provider } = setup();
    const found = await provider.findInvitation("planning@contoso.com");
    expect(found?.calendarId).toBe("cal");
    if (!found) return;
    expect((await provider.respond(found, "tentative")).myResponse).toBe(
      "tentative",
    );
    await provider.respond(found, "accepted");
    await provider.respond(found, "declined");
    expect(calls).toEqual([
      { action: "tentativelyAccept", body: { sendResponse: true } },
      { action: "accept", body: { sendResponse: true } },
      { action: "decline", body: { sendResponse: true } },
    ]);
  });
});

describe("GraphCalendarProvider changes", () => {
  const teamsText =
    '<div style="width:100%"><span style="white-space:nowrap">________________________________________________________________________________</span></div><div class="me-email-text">Microsoft Teams meeting <a href="https://teams.microsoft.com/l/meetup-join/9">Join</a></div>';
  const master: GraphEvent = {
    id: "S",
    subject: "Jour fixe",
    start: { dateTime: "2026-10-22T08:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-22T09:00:00.0000000", timeZone: "UTC" },
    originalStartTimeZone: "W. Europe Standard Time",
    isAllDay: false,
    isOrganizer: true,
    type: "seriesMaster",
    isOnlineMeeting: true,
    body: {
      contentType: "html",
      content: `<html><head></head><body><p>Agenda first</p>${teamsText}</body></html>`,
    },
    organizer: { emailAddress: { name: "Max", address: "max@contoso.com" } },
    attendees: [
      {
        type: "required",
        status: { response: "accepted" },
        emailAddress: { name: "Anna", address: "anna@contoso.com" },
      },
    ],
    recurrence: {
      pattern: {
        type: "weekly",
        interval: 1,
        daysOfWeek: ["thursday"],
        firstDayOfWeek: "monday",
      },
      range: {
        type: "numbered",
        startDate: "2026-10-22",
        numberOfOccurrences: 10,
        recurrenceTimeZone: "W. Europe Standard Time",
      },
    },
  };
  /** The second occurrence (29 October, winter time). */
  const second: GraphEvent = {
    ...master,
    id: "O2",
    type: "occurrence",
    seriesMasterId: "S",
    recurrence: null,
    originalStart: "2026-10-29T09:00:00Z",
    start: { dateTime: "2026-10-29T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-29T10:00:00.0000000", timeZone: "UTC" },
  };

  interface Call {
    readonly method: string;
    readonly path: string;
    readonly prefer: string | null;
    readonly body: Record<string, unknown> | undefined;
  }

  /** Graph's events in memory; every write is recorded. */
  function serve(events: GraphEvent[]) {
    const store = new Map<string, object>(events.map((e) => [e.id, e]));
    const calls: Call[] = [];
    let created = 0;
    const record = async (request: Request) => {
      const text = await request.text();
      const body = text
        ? (JSON.parse(text) as Record<string, unknown>)
        : undefined;
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname.replace("/v1.0/", ""),
        prefer: request.headers.get("Prefer"),
        body,
      });
      return body ?? {};
    };
    server.use(
      http.get(url("me/events/:id/instances"), () =>
        HttpResponse.json({ value: [{ id: "O1" }] }),
      ),
      http.get(url("me/events/:id"), ({ params }) => {
        const found = store.get(String(params.id));
        return found
          ? HttpResponse.json(found)
          : HttpResponse.json(
              { error: { code: "ErrorItemNotFound" } },
              { status: 404 },
            );
      }),
      http.post(url("me/calendars/:cal/events"), async ({ request }) => {
        const body = await record(request);
        created += 1;
        const event = {
          ...body,
          id: `new-${String(created)}`,
          start: { dateTime: "2026-10-22T13:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-10-22T14:00:00.0000000", timeZone: "UTC" },
          isOrganizer: true,
        };
        store.set(event.id, event);
        return HttpResponse.json(event);
      }),
      http.patch(url("me/events/:id"), async ({ request, params }) => {
        const body = await record(request);
        const id = String(params.id);
        const event = { ...store.get(id), ...body };
        store.set(id, event);
        return HttpResponse.json(event);
      }),
      http.delete(url("me/events/:id"), async ({ request, params }) => {
        await record(request);
        store.delete(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return { calls };
  }

  const cal = asCalendarId("cal");

  it("offers Teams where the calendar allows it", async () => {
    server.use(
      http.get(url("me/calendars"), () =>
        HttpResponse.json({
          value: [
            {
              id: "cal",
              name: "Calendar",
              isDefaultCalendar: true,
              canEdit: true,
              allowedOnlineMeetingProviders: ["teamsForBusiness"],
            },
          ],
        }),
      ),
    );
    const [calendar] = await setup().provider.listCalendars();
    expect(calendar?.videoCall).toBe("teams");
  });

  it("creates an event in its zone (as Windows names it), with Teams and a repeat; undo deletes it", async () => {
    const { calls } = serve([]);
    const { provider } = setup();
    const { event, undo } = await provider.createEvent(
      {
        calendarId: cal,
        title: "Planning",
        start: {
          dateTime: "2026-10-22T13:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
        end: {
          dateTime: "2026-10-22T14:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
        location: "Room 3",
        descriptionHtml: "<p>Bring numbers</p>",
        guests: [{ name: "Anna", address: "anna@contoso.com" }],
        videoCall: true,
        repeat: { kind: "weekly", until: "2026-12-31" },
        reminders: [],
      },
      { notify: false },
    );
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "me/calendars/cal/events",
      body: {
        transactionId: expect.any(String) as unknown,
        subject: "Planning",
        start: {
          dateTime: "2026-10-22T15:00:00",
          timeZone: "W. Europe Standard Time",
        },
        end: {
          dateTime: "2026-10-22T16:00:00",
          timeZone: "W. Europe Standard Time",
        },
        isAllDay: false,
        location: { displayName: "Room 3" },
        body: { contentType: "html", content: "<p>Bring numbers</p>" },
        attendees: [
          {
            emailAddress: { address: "anna@contoso.com", name: "Anna" },
            type: "required",
          },
        ],
        recurrence: {
          pattern: { type: "weekly", interval: 1, daysOfWeek: ["thursday"] },
          range: {
            type: "endDate",
            startDate: "2026-10-22",
            endDate: "2026-12-31",
            recurrenceTimeZone: "W. Europe Standard Time",
          },
        },
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      },
    });
    expect(calls[0]?.prefer).toContain('outlook.timezone="UTC"');
    expect(event).toMatchObject({ title: "Planning", organizedByMe: true });

    await undo({ notify: false });
    expect(calls[1]).toMatchObject({
      method: "DELETE",
      path: "me/events/new-1",
    });
  });

  it("moves a whole series like its occurrence moved, and undoes it", async () => {
    const { calls } = serve([master, second]);
    const { provider } = setup();
    const occurrence = toCalendarEvent("cal", second);
    expect(occurrence).toMatchObject({ seriesId: "S", organizedByMe: true });
    const change = await provider.updateEvent(
      occurrence,
      {
        start: {
          dateTime: "2026-10-29T10:00:00.000Z",
          timeZone: "Europe/Berlin",
        },
        end: {
          dateTime: "2026-10-29T11:00:00.000Z",
          timeZone: "Europe/Berlin",
        },
      },
      "all",
      { notify: true },
    );
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "me/events/S",
      body: {
        start: {
          dateTime: "2026-10-22T11:00:00",
          timeZone: "W. Europe Standard Time",
        },
        end: {
          dateTime: "2026-10-22T12:00:00",
          timeZone: "W. Europe Standard Time",
        },
      },
    });
    expect(calls[0]?.body).not.toHaveProperty("recurrence");

    await change.undo({ notify: true });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      path: "me/events/S",
      body: {
        start: {
          dateTime: "2026-10-22T10:00:00",
          timeZone: "W. Europe Standard Time",
        },
      },
    });
  });

  it("keeps a Teams meeting's join text out of the editor, and in the event", async () => {
    const { calls } = serve([master]);
    const { provider } = setup();
    const event = toCalendarEvent("cal", master);
    const editable = await provider.loadForEdit(event);
    expect(editable.draft.descriptionHtml).toBe("<p>Agenda first</p>");
    expect(editable.videoCallFixed).toBe(true);
    expect(editable.draft.repeat).toEqual({ kind: "custom" });
    expect(editable.firstOccurrence).toBe(true);
    expect(editable.draft.guests).toEqual([
      { name: "Anna", address: "anna@contoso.com" },
    ]);

    await provider.updateEvent(
      event,
      { descriptionHtml: "<p>New agenda</p>", videoCall: false },
      "all",
      { notify: true },
    );
    expect(calls[0]?.body).toEqual({
      body: { contentType: "html", content: `<p>New agenda</p>${teamsText}` },
    });
  });

  it("splits a series for 'this and following', counting what took place", async () => {
    const { calls } = serve([master, second]);
    const { provider } = setup();
    const change = await provider.updateEvent(
      toCalendarEvent("cal", second),
      { title: "New jour fixe" },
      "following",
      { notify: true },
    );
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "me/events/S",
      body: {
        recurrence: {
          range: {
            type: "endDate",
            startDate: "2026-10-22",
            endDate: "2026-10-28",
          },
        },
      },
    });
    expect(calls[0]?.body?.recurrence).not.toHaveProperty(
      "range.numberOfOccurrences",
    );
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: {
        subject: "New jour fixe",
        start: {
          dateTime: "2026-10-29T10:00:00",
          timeZone: "W. Europe Standard Time",
        },
        recurrence: {
          range: {
            type: "numbered",
            startDate: "2026-10-29",
            numberOfOccurrences: 9,
          },
        },
        isOnlineMeeting: true,
      },
    });

    await change.undo({ notify: true });
    expect(calls[2]).toMatchObject({
      method: "DELETE",
      path: "me/events/new-1",
    });
    expect(calls[3]).toMatchObject({
      method: "PATCH",
      path: "me/events/S",
      body: { recurrence: master.recurrence },
    });
  });

  it("deletes an occurrence, and brings it back as an event of its own", async () => {
    const { calls } = serve([master, second]);
    const { provider } = setup();
    const change = await provider.deleteEvent(
      toCalendarEvent("cal", second),
      "this",
      { notify: true },
    );
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "me/events/O2" });
    await change.undo({ notify: true });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "me/calendars/cal/events",
      body: {
        subject: "Jour fixe",
        start: {
          dateTime: "2026-10-29T10:00:00",
          timeZone: "W. Europe Standard Time",
        },
        recurrence: null,
      },
    });
  });
});

describe("Outlook reminders", () => {
  it("reads and writes Outlook's one reminder per event", () => {
    const { provider } = setup();
    expect(
      toCalendarEvent("cal", {
        ...event,
        isReminderOn: true,
        reminderMinutesBeforeStart: 30,
      }).reminders,
    ).toEqual([30]);
    expect(
      toCalendarEvent("cal", { ...event, isReminderOn: false }).reminders,
    ).toBeUndefined();
    expect(provider.maxReminders).toBe(1);
  });

  it("lists Outlook's reminders in UTC, and dismisses and snoozes them there", async () => {
    const calls: { path: string; prefer: string | null; body: unknown }[] = [];
    server.use(
      http.get(url("me/reminderView(*"), ({ request }) => {
        calls.push({
          path: decodeURIComponent(new URL(request.url).pathname),
          prefer: request.headers.get("Prefer"),
          body: undefined,
        });
        return HttpResponse.json({
          value: [
            {
              eventId: "AAMk-1",
              reminderFireTime: {
                dateTime: "2026-10-22T07:50:00.0000000",
                timeZone: "UTC",
              },
            },
          ],
        });
      }),
      http.post(url("me/events/:id/:action"), async ({ request, params }) => {
        const text = await request.text();
        calls.push({
          path: `${String(params.id)}/${String(params.action)}`,
          prefer: null,
          body: text ? (JSON.parse(text) as unknown) : undefined,
        });
        return new HttpResponse(null, { status: 202 });
      }),
    );
    const sync = setup().provider.reminderSync;
    const reminders = await sync.list({
      from: "2026-10-21T22:00:00.000Z",
      to: "2026-10-31T23:00:00.000Z",
    });
    expect(reminders).toEqual([
      { eventId: "AAMk-1", fireAt: "2026-10-22T07:50:00.000Z" },
    ]);
    expect(calls[0]?.path).toContain(
      "reminderView(startDateTime='2026-10-21T22:00:00',endDateTime='2026-10-31T23:00:00')",
    );
    expect(calls[0]?.prefer).toContain('outlook.timezone="UTC"');

    await sync.dismiss(asEventId("AAMk-1"));
    await sync.snooze(asEventId("AAMk-2"), "2026-10-22T08:05:00.000Z");
    expect(calls.slice(1)).toEqual([
      { path: "AAMk-1/dismissReminder", prefer: null, body: undefined },
      {
        path: "AAMk-2/snoozeReminder",
        prefer: null,
        body: {
          newReminderTime: { dateTime: "2026-10-22T08:05:00", timeZone: "UTC" },
        },
      },
    ]);
  });
});
