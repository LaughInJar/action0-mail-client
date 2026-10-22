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
