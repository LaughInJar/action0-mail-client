// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GoogleAuthSession } from "../../auth/google/GoogleAuthSession";
import { StaticAuthSession } from "../../auth/staticSession";
import { asCalendarId } from "../../core/calendar";
import { isMailError } from "../../core/errors";
import {
  CALENDAR_API_BASE,
  CALENDAR_SCOPES,
  GoogleCalendarProvider,
  toCalendarEvent,
  type GoogleEvent,
} from "./calendar";
import { GmailHttp } from "./http";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const url = (path: string) => `${CALENDAR_API_BASE}${path}`;

function setup(granted = true) {
  let scopes = granted;
  const requested: (readonly string[])[] = [];
  const session = {
    hasScopes: () => scopes,
    requestScopes: (wanted: readonly string[]) => {
      requested.push(wanted);
      scopes = true;
      return Promise.resolve();
    },
    subscribe: () => () => undefined,
  } as unknown as GoogleAuthSession;
  const provider = new GoogleCalendarProvider(
    new GmailHttp({
      auth: new StaticAuthSession(),
      baseUrl: CALENDAR_API_BASE,
      service: "Google Calendar",
      sleep: () => Promise.resolve(),
    }),
    session,
  );
  return { provider, requested };
}

const designReview = {
  id: "ev1",
  status: "confirmed",
  summary: "Design review",
  location: "Room 2",
  description: "<b>Agenda</b>",
  start: { dateTime: "2026-10-15T11:00:00+02:00", timeZone: "Europe/Vienna" },
  end: { dateTime: "2026-10-15T12:00:00+02:00", timeZone: "Europe/Vienna" },
  organizer: { email: "anna@example.org", displayName: "Anna" },
  attendees: [
    {
      email: "anna@example.org",
      displayName: "Anna",
      organizer: true,
      responseStatus: "accepted",
    },
    { email: "me@example.com", self: true, responseStatus: "needsAction" },
    {
      email: "room@resource.example",
      resource: true,
      responseStatus: "accepted",
    },
  ],
  conferenceData: {
    entryPoints: [
      { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
    ],
  },
  iCalUID: "design@example.org",
  htmlLink: "https://calendar.google.com/event?eid=1",
};

describe("GoogleCalendarProvider", () => {
  it("lists calendars, the primary first, ticked like in Google Calendar", async () => {
    server.use(
      http.get(url("users/me/calendarList"), () =>
        HttpResponse.json({
          items: [
            {
              id: "holidays",
              summary: "Holidays",
              backgroundColor: "#16a765",
              accessRole: "reader",
              selected: false,
            },
            {
              id: "me@example.com",
              summary: "me@example.com",
              summaryOverride: "Mine",
              backgroundColor: "#9fe1e7",
              accessRole: "owner",
              primary: true,
              selected: true,
            },
          ],
        }),
      ),
    );
    const calendars = await setup().provider.listCalendars();
    expect(calendars).toEqual([
      {
        id: "me@example.com",
        name: "Mine",
        color: "#9fe1e7",
        primary: true,
        shownByDefault: true,
        readOnly: false,
      },
      {
        id: "holidays",
        name: "Holidays",
        color: "#16a765",
        primary: false,
        shownByDefault: false,
        readOnly: true,
      },
    ]);
  });

  it("lists single occurrences in a range and maps them", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(url("calendars/:id/events"), ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          items: [
            designReview,
            {
              id: "gone",
              status: "cancelled",
              start: { date: "2026-10-15" },
              end: { date: "2026-10-16" },
            },
            {
              id: "fair",
              summary: "Fair",
              start: { date: "2026-10-14" },
              end: { date: "2026-10-16" },
              recurringEventId: "series",
            },
          ],
        });
      }),
    );
    const events = await setup().provider.listEvents(
      [asCalendarId("me@example.com")],
      { from: "2026-10-12T00:00:00Z", to: "2026-10-19T00:00:00Z" },
    );
    expect(query?.get("singleEvents")).toBe("true");
    expect(query?.get("timeMin")).toBe("2026-10-12T00:00:00Z");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      title: "Design review",
      start: {
        dateTime: "2026-10-15T09:00:00.000Z",
        timeZone: "Europe/Vienna",
      },
      location: "Room 2",
      description: { html: "<b>Agenda</b>" },
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      organizer: { name: "Anna", address: "anna@example.org" },
      myResponse: "needsAction",
      uid: "design@example.org",
      recurring: false,
    });
    expect(events[0]?.attendees.find((a) => a.resource)?.address.address).toBe(
      "room@resource.example",
    );
    expect(events[1]).toMatchObject({
      start: { date: "2026-10-14" },
      recurring: true,
    });
  });

  it("answers by setting your own attendee entry, and finds invitations by UID", async () => {
    let patched:
      { attendees: { email: string; responseStatus: string }[] } | undefined;
    let sendUpdates: string | null = null;
    server.use(
      http.get(url("calendars/primary/events"), ({ request }) =>
        HttpResponse.json({
          items:
            new URL(request.url).searchParams.get("iCalUID") ===
            "design@example.org"
              ? [designReview]
              : [],
        }),
      ),
      http.get(url("calendars/primary/events/ev1"), () =>
        HttpResponse.json(designReview),
      ),
      http.patch(url("calendars/primary/events/ev1"), async ({ request }) => {
        sendUpdates = new URL(request.url).searchParams.get("sendUpdates");
        patched = (await request.json()) as typeof patched;
        return HttpResponse.json({
          ...designReview,
          attendees: patched?.attendees,
        });
      }),
    );
    const { provider } = setup();
    const event = await provider.findInvitation("design@example.org");
    expect(event?.myResponse).toBe("needsAction");
    if (!event) return;
    const updated = await provider.respond(event, "accepted");
    expect(sendUpdates).toBe("all");
    expect(
      patched?.attendees.find((a) => a.email === "me@example.com")
        ?.responseStatus,
    ).toBe("accepted");
    expect(
      patched?.attendees.find((a) => a.email === "anna@example.org")
        ?.responseStatus,
    ).toBe("accepted");
    expect(updated.myResponse).toBe("accepted");
  });

  it("needs calendar access, asks for it, and explains Google's refusal", async () => {
    const { provider, requested } = setup(false);
    expect(provider.access()).toBe("missing");
    const missing = await provider.listCalendars().catch((e: unknown) => e);
    expect(isMailError(missing, "unavailable") && missing.reason).toBe(
      "calendarAccessNeeded",
    );
    await provider.requestAccess();
    expect(requested).toEqual([CALENDAR_SCOPES]);
    expect(provider.access()).toBe("granted");

    server.use(
      http.get(url("users/me/calendarList"), () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
            },
          },
          { status: 403 },
        ),
      ),
    );
    const refused = await provider.listCalendars().catch((e: unknown) => e);
    expect(isMailError(refused) && refused.reason).toBe("calendarAccessNeeded");
  });
});

describe("GoogleCalendarProvider changes", () => {
  const CAL = "me@example.com";
  const path = (rest: string) =>
    url(`calendars/${encodeURIComponent(CAL)}/${rest}`);
  const master: GoogleEvent = {
    id: "ser",
    status: "confirmed",
    summary: "Jour fixe",
    start: { dateTime: "2026-10-22T10:00:00+02:00", timeZone: "Europe/Vienna" },
    end: { dateTime: "2026-10-22T11:00:00+02:00", timeZone: "Europe/Vienna" },
    organizer: { email: CAL, self: true },
    attendees: [
      { email: CAL, self: true, organizer: true, responseStatus: "accepted" },
      { email: "anna@example.org", responseStatus: "accepted" },
    ],
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=TH"],
  };
  /** The third occurrence (29 October; winter time from the 25th). */
  const { recurrence: _rule, ...single } = master;
  const third: GoogleEvent = {
    ...single,
    id: "ser_20261029T090000Z",
    recurringEventId: "ser",
    originalStartTime: {
      dateTime: "2026-10-29T10:00:00+01:00",
      timeZone: "Europe/Vienna",
    },
    start: { dateTime: "2026-10-29T10:00:00+01:00", timeZone: "Europe/Vienna" },
    end: { dateTime: "2026-10-29T11:00:00+01:00", timeZone: "Europe/Vienna" },
  };

  interface Call {
    readonly method: string;
    readonly id: string;
    readonly query: URLSearchParams;
    readonly body: Record<string, unknown> | undefined;
  }

  /** Google's events of one calendar, in memory; every write is recorded. */
  function serve(events: GoogleEvent[]) {
    const store = new Map(events.map((event) => [event.id, event]));
    const calls: Call[] = [];
    const record = async (request: Request, id: string) => {
      const text = await request.text();
      calls.push({
        method: request.method,
        id,
        query: new URL(request.url).searchParams,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      });
      return calls.at(-1)?.body ?? {};
    };
    server.use(
      http.get(path("events/:id/instances"), ({ params }) =>
        HttpResponse.json({
          items: params.id === "ser" ? [{ id: "a" }, { id: "b" }] : [],
        }),
      ),
      http.get(path("events/:id"), ({ params }) => {
        const event = store.get(String(params.id));
        return event
          ? HttpResponse.json(event)
          : HttpResponse.json(
              { error: { message: "Not Found" } },
              { status: 404 },
            );
      }),
      http.post(path("events"), async ({ request }) => {
        const body = (await record(request, "")) as unknown as GoogleEvent;
        const created: GoogleEvent = {
          ...body,
          ...(body.conferenceData
            ? {
                conferenceData: {
                  entryPoints: [
                    {
                      entryPointType: "video",
                      uri: "https://meet.google.com/new",
                    },
                  ],
                },
              }
            : {}),
        };
        store.set(created.id, created);
        return HttpResponse.json(created);
      }),
      http.patch(path("events/:id"), async ({ request, params }) => {
        const id = String(params.id);
        const body = await record(request, id);
        const event = { ...store.get(id), ...body } as GoogleEvent;
        store.set(id, event);
        return HttpResponse.json(event);
      }),
      http.delete(path("events/:id"), async ({ request, params }) => {
        const id = String(params.id);
        await record(request, id);
        const event = store.get(id);
        if (event) store.set(id, { ...event, status: "cancelled" });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return { calls, store };
  }

  const draft = {
    calendarId: asCalendarId(CAL),
    title: "Planning",
    start: { dateTime: "2026-10-22T13:00:00.000Z", timeZone: "Europe/Vienna" },
    end: { dateTime: "2026-10-22T14:00:00.000Z", timeZone: "Europe/Vienna" },
    location: "Room 3",
    descriptionHtml: "<p>Bring numbers</p>",
    guests: [{ name: "Anna", address: "anna@example.org" }],
    videoCall: true,
    repeat: { kind: "weekly" as const },
    reminders: [10],
  };

  it("creates an event with its own id, a Meet, a repeat rule and guests; undo deletes it", async () => {
    const { calls } = serve([]);
    const { provider } = setup();
    const { event, undo } = await provider.createEvent(draft, { notify: true });
    const post = calls[0];
    expect(post?.method).toBe("POST");
    expect(post?.query.get("sendUpdates")).toBe("all");
    expect(post?.query.get("conferenceDataVersion")).toBe("1");
    expect(post?.body).toMatchObject({
      id: expect.stringMatching(/^[0-9a-v]{26}$/) as unknown,
      summary: "Planning",
      start: draft.start,
      location: "Room 3",
      description: "<p>Bring numbers</p>",
      attendees: [{ email: "anna@example.org", displayName: "Anna" }],
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
      conferenceData: {
        createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    });
    expect(event).toMatchObject({
      title: "Planning",
      meetingUrl: "https://meet.google.com/new",
      organizedByMe: true,
    });

    await undo({ notify: false });
    expect(calls[1]).toMatchObject({ method: "DELETE", id: post?.body?.id });
    expect(calls[1]?.query.get("sendUpdates")).toBe("none");
  });

  it("changes one occurrence, or the whole series moved as far, and undoes it", async () => {
    const { calls } = serve([master, third]);
    const { provider } = setup();
    const occurrence = toCalendarEvent(CAL, third);
    expect(occurrence).toMatchObject({ seriesId: "ser", organizedByMe: true });

    await provider.updateEvent(
      occurrence,
      { title: "Moved jour fixe", repeat: null },
      "this",
      { notify: false },
    );
    // Only the occurrence; it can't stop repeating on its own.
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      id: third.id,
      body: { summary: "Moved jour fixe" },
    });

    // An hour later, for all of them: the series starts an hour later too.
    const change = await provider.updateEvent(
      occurrence,
      {
        start: {
          dateTime: "2026-10-29T10:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
        end: {
          dateTime: "2026-10-29T11:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
      },
      "all",
      { notify: true },
    );
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      id: "ser",
      body: {
        start: {
          dateTime: "2026-10-22T09:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
        end: {
          dateTime: "2026-10-22T10:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
        recurrence: master.recurrence,
      },
    });
    expect(calls[1]?.query.get("sendUpdates")).toBe("all");

    await change.undo({ notify: false });
    expect(calls[2]).toMatchObject({
      method: "PATCH",
      id: "ser",
      body: {
        start: master.start,
        end: master.end,
        recurrence: master.recurrence,
      },
    });
  });

  it("splits a series for 'this and following', counting what took place", async () => {
    const { calls } = serve([master, third]);
    const { provider } = setup();
    const change = await provider.updateEvent(
      toCalendarEvent(CAL, third),
      { title: "New jour fixe" },
      "following",
      { notify: false },
    );
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      id: "ser",
      body: {
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029T085959Z"],
      },
    });
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.body).toMatchObject({
      summary: "New jour fixe",
      start: {
        dateTime: "2026-10-29T09:00:00.000Z",
        timeZone: "Europe/Vienna",
      },
      // Two occurrences took place before.
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=TH"],
    });

    await change.undo({ notify: false });
    expect(calls[2]).toMatchObject({
      method: "DELETE",
      id: calls[1]?.body?.id,
    });
    expect(calls[3]).toMatchObject({
      method: "PATCH",
      id: "ser",
      body: { recurrence: master.recurrence },
    });
  });

  it("deletes an occurrence, the rest of a series, or all of it, and brings them back", async () => {
    const { calls, store } = serve([master, third]);
    const { provider } = setup();
    const occurrence = toCalendarEvent(CAL, third);

    const one = await provider.deleteEvent(occurrence, "this", {
      notify: true,
    });
    expect(calls[0]).toMatchObject({ method: "DELETE", id: third.id });
    await one.undo({ notify: true });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      id: third.id,
      body: { status: "confirmed" },
    });

    await provider.deleteEvent(occurrence, "following", { notify: false });
    expect(calls[2]).toMatchObject({
      method: "PATCH",
      id: "ser",
      body: {
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029T085959Z"],
      },
    });

    store.set("ser", master);
    await provider.deleteEvent(occurrence, "all", { notify: false });
    expect(calls[3]).toMatchObject({ method: "DELETE", id: "ser" });
  });

  it("keeps the answers of guests who stay invited", async () => {
    const { calls } = serve([master]);
    const { provider } = setup();
    await provider.updateEvent(
      toCalendarEvent(CAL, master),
      {
        guests: [
          { address: "anna@example.org" },
          { name: "Jonas", address: "jonas@example.org" },
        ],
      },
      "all",
      { notify: true },
    );
    expect(calls[0]?.body?.attendees).toEqual([
      { email: CAL, self: true, organizer: true, responseStatus: "accepted" },
      { email: "anna@example.org", responseStatus: "accepted" },
      { email: "jonas@example.org", displayName: "Jonas" },
    ]);
  });

  it("reads an event for the editor with its series' rule", async () => {
    serve([master, third]);
    server.use(
      http.get(url("users/me/calendarList/:id"), () =>
        HttpResponse.json({
          id: CAL,
          defaultReminders: [
            { method: "popup", minutes: 10 },
            { method: "email", minutes: 60 },
          ],
        }),
      ),
    );
    const editable = await setup().provider.loadForEdit(
      toCalendarEvent(CAL, third),
    );
    expect(editable).toEqual({
      draft: {
        calendarId: CAL,
        title: "Jour fixe",
        start: {
          dateTime: "2026-10-29T09:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
        end: {
          dateTime: "2026-10-29T10:00:00.000Z",
          timeZone: "Europe/Vienna",
        },
        location: "",
        descriptionHtml: "",
        guests: [{ address: "anna@example.org" }],
        videoCall: false,
        repeat: { kind: "custom" },
        // The calendar's default, on screen (email reminders aren't shown).
        reminders: [10],
      },
      videoCallFixed: false,
      firstOccurrence: false,
    });
  });
});

describe("Google reminders", () => {
  it("reads on-screen reminders, the calendar's defaults where the event uses them", async () => {
    server.use(
      http.get(url("calendars/:id/events"), () =>
        HttpResponse.json({
          defaultReminders: [{ method: "popup", minutes: 30 }],
          items: [
            { ...designReview, id: "d", reminders: { useDefault: true } },
            {
              ...designReview,
              id: "own",
              reminders: {
                useDefault: false,
                overrides: [
                  { method: "email", minutes: 1440 },
                  { method: "popup", minutes: 5 },
                ],
              },
            },
            {
              ...designReview,
              id: "none",
              reminders: { useDefault: false },
            },
          ],
        }),
      ),
    );
    const events = await setup().provider.listEvents(
      [asCalendarId("me@example.com")],
      { from: "2026-10-12T00:00:00Z", to: "2026-10-19T00:00:00Z" },
    );
    expect(events.map((event) => event.reminders)).toEqual([
      [30],
      [5],
      undefined,
    ]);
  });

  it("writes on-screen reminders and keeps the email ones", async () => {
    let body: Record<string, unknown> | undefined;
    const CAL = "me@example.com";
    const own = {
      ...designReview,
      organizer: { email: CAL, self: true },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 1440 },
          { method: "popup", minutes: 5 },
        ],
      },
    };
    server.use(
      http.get(url(`calendars/${encodeURIComponent(CAL)}/events/ev1`), () =>
        HttpResponse.json(own),
      ),
      http.patch(
        url(`calendars/${encodeURIComponent(CAL)}/events/ev1`),
        async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(own);
        },
      ),
    );
    await setup().provider.updateEvent(
      toCalendarEvent(CAL, own),
      { reminders: [10, 60] },
      "all",
      { notify: false },
    );
    expect(body).toEqual({
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 10 },
          { method: "popup", minutes: 60 },
          { method: "email", minutes: 1440 },
        ],
      },
    });
  });
});
