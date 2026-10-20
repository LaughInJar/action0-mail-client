// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MicrosoftAuthSession } from "../../auth/microsoft/MicrosoftAuthSession";
import { StaticAuthSession } from "../../auth/staticSession";
import { asCalendarId } from "../../core/calendar";
import { GraphCalendarProvider } from "./calendar";
import { GRAPH_BASE, GraphHttp } from "./http";

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

const event = {
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
      },
      {
        id: "birthdays",
        name: "Birthdays",
        color: "#5fb25f",
        primary: false,
        shownByDefault: true,
        readOnly: true,
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
        timeZone: "W. Europe Standard Time",
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
