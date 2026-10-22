// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { asCalendarId } from "../../core/calendar";
import { isMailError } from "../../core/errors";
import { IcsCalendarProvider } from "./IcsCalendarProvider";

const CALENDAR = asCalendarId("club");
const subscription = {
  id: "club",
  url: "webcal://club.example.org/cal.ics",
  name: "Club",
  color: "#8e24aa",
};

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Vienna",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:choir@example.org",
  "DTSTART;TZID=Europe/Vienna:20261005T190000",
  "DTEND;TZID=Europe/Vienna:20261005T203000",
  "RRULE:FREQ=WEEKLY;COUNT=10",
  "EXDATE;TZID=Europe/Vienna:20261019T190000",
  "SUMMARY:Choir rehearsal",
  "LOCATION:Parish hall",
  "ORGANIZER;CN=Eva:mailto:eva@example.org",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:choir@example.org",
  "RECURRENCE-ID;TZID=Europe/Vienna:20261012T190000",
  "DTSTART;TZID=Europe/Vienna:20261012T200000",
  "DTEND;TZID=Europe/Vienna:20261012T213000",
  "SUMMARY:Choir rehearsal (later)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:fair@example.org",
  "DTSTART;VALUE=DATE:20261014",
  "DTEND;VALUE=DATE:20261016",
  "SUMMARY:Street fair",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const range = { from: "2026-10-05T00:00:00Z", to: "2026-10-26T00:00:00Z" };
const provider = (fetcher: typeof fetch) =>
  new IcsCalendarProvider(subscription, { fetch: fetcher });

describe("IcsCalendarProvider", () => {
  it("expands series in the range, with exceptions, exclusions and time zones", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(ICS)),
    );
    const events = await provider(fetcher).listEvents([CALENDAR], range);
    const titled = events.map((event) => [event.title, event.start]);
    expect(titled).toEqual(
      expect.arrayContaining([
        // 19:00 in Vienna (summer time) is 17:00 UTC.
        [
          "Choir rehearsal",
          { dateTime: "2026-10-05T17:00:00.000Z", timeZone: "Europe/Vienna" },
        ],
        [
          "Choir rehearsal (later)",
          { dateTime: "2026-10-12T18:00:00.000Z", timeZone: "Europe/Vienna" },
        ],
        ["Street fair", { date: "2026-10-14" }],
      ]),
    );
    // 19 October is excluded; on 26 October winter time starts (18:00 UTC), out of range.
    expect(events.filter((e) => e.title.startsWith("Choir"))).toHaveLength(2);
    const first = events.find((event) => event.title === "Choir rehearsal");
    expect(first).toMatchObject({
      location: "Parish hall",
      organizer: { name: "Eva", address: "eva@example.org" },
      recurring: true,
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      "https://club.example.org/cal.ics",
    );
    expect(init).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("explains servers that don't allow browsers, missing calendars and other files", async () => {
    const reason = async (fetcher: typeof fetch) => {
      const error = await provider(fetcher)
        .listEvents([CALENDAR], range)
        .catch((e: unknown) => e);
      return isMailError(error) ? [error.reason, error.params] : error;
    };
    expect(
      await reason(() => Promise.reject(new TypeError("Failed to fetch"))),
    ).toEqual(["icsBlocked", { host: "club.example.org" }]);
    expect(
      await reason(() => Promise.resolve(new Response("", { status: 404 }))),
    ).toEqual(["icsNotFound", { status: "404" }]);
    expect(
      await reason(() => Promise.resolve(new Response("<html></html>"))),
    ).toEqual(["icsUnreadable", {}]);
  });
});
