import { describe, expect, it } from "vitest";
import { asCalendarId, asEventId, type CalendarEvent } from "./calendar";
import { dueReminders, liveMarks, upcomingRange } from "./reminders";

const NOW = Date.parse("2026-10-22T09:00:00Z");
const MIN = 60_000;

function event(
  id: string,
  startsIn: number,
  more: Partial<CalendarEvent> = {},
) {
  return {
    source: "acct",
    event: {
      id: asEventId(id),
      calendarId: asCalendarId("cal"),
      title: id,
      start: { dateTime: new Date(NOW + startsIn * MIN).toISOString() },
      end: { dateTime: new Date(NOW + (startsIn + 30) * MIN).toISOString() },
      attendees: [],
      status: "confirmed",
      recurring: false,
      organizedByMe: true,
      ...more,
    } satisfies CalendarEvent,
  };
}

const due = (
  items: ReturnType<typeof event>[],
  marks = {},
  synced = new Map<string, Map<string, number>>(),
) =>
  dueReminders(items, (item) => item.source, synced, marks, NOW).map(
    (reminder) => reminder.key,
  );

describe("due reminders", () => {
  it("are the reminders whose time came, of events not over", () => {
    expect(
      due([
        event("soon", 5, { reminders: [10, 1] }),
        event("later", 60, { reminders: [10] }),
        event("over", -40, { reminders: [10] }),
        event("none", 5),
      ]),
    ).toEqual(["acct|soon|10"]);
  });

  it("leave out declined and cancelled events", () => {
    expect(
      due([
        event("declined", 5, { reminders: [10], myResponse: "declined" }),
        event("cancelled", 5, { reminders: [10], status: "cancelled" }),
        event("maybe", 5, { reminders: [10], myResponse: "tentative" }),
      ]),
    ).toEqual(["acct|maybe|10"]);
  });

  it("leave out dismissed ones, and snoozed ones until their time", () => {
    const items = [
      event("a", 5, { reminders: [10] }),
      event("b", 5, { reminders: [10] }),
      event("c", 5, { reminders: [10] }),
    ];
    const ends = NOW + 35 * MIN;
    expect(
      due(items, {
        "acct|a|10": { dismissed: true, ends },
        "acct|b|10": { snoozedUntil: NOW + MIN, ends },
        "acct|c|10": { snoozedUntil: NOW - MIN, ends },
      }),
    ).toEqual(["acct|c|10"]);
  });

  it("use the provider's own list where it keeps reminders (Outlook)", () => {
    const synced = new Map([["acct", new Map([["a", NOW - MIN]])]]);
    expect(
      due(
        [
          // The provider's list wins over the event's own reminders.
          event("a", 30, { reminders: [10] }),
          event("b", 5, { reminders: [10] }),
        ],
        {},
        synced,
      ),
    ).toEqual(["acct|a"]);
  });

  it("forget marks of events that are over", () => {
    expect(
      liveMarks(
        {
          old: { dismissed: true, ends: NOW - 1 },
          live: { dismissed: true, ends: NOW + 1 },
        },
        NOW,
      ),
    ).toEqual({ live: { dismissed: true, ends: NOW + 1 } });
  });

  it("look from yesterday to nine days ahead, in whole days", () => {
    const range = upcomingRange(NOW);
    const days =
      (Date.parse(range.to) - Date.parse(range.from)) / (24 * 60 * MIN);
    expect(Math.round(days)).toBe(10);
    expect(Date.parse(range.from)).toBeLessThan(NOW - 24 * 60 * MIN + 1);
    expect(upcomingRange(NOW + 60 * MIN)).toEqual(range);
  });
});
