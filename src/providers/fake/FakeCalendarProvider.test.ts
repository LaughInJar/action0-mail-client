import { describe, expect, it } from "vitest";
import { asCalendarId, type CalendarEvent } from "../../core/calendar";
import { FakeCalendarProvider } from "./FakeCalendarProvider";

const work = asCalendarId("work");
/** Thursday 22 October 2026 (local time). */
const NOW = new Date(2026, 9, 22, 12).getTime();
const week = (from: number, days = 7) => ({
  from: new Date(2026, 9, from).toISOString(),
  to: new Date(2026, 9, from + days).toISOString(),
});

function setup() {
  return new FakeCalendarProvider({
    me: { address: "me@example.com" },
    now: NOW,
    calendars: [
      {
        id: work,
        name: "Work",
        color: "#039be5",
        primary: true,
        shownByDefault: true,
        readOnly: false,
      },
    ],
    events: [
      {
        key: "standup",
        calendarId: work,
        title: "Stand-up",
        weekdays: [1, 2, 3, 4, 5],
        start: "09:30",
        end: "09:45",
      },
    ],
  });
}

/** "Title@day of month" of timed events, in order. */
const titles = (events: readonly CalendarEvent[]) =>
  events.map((event) => {
    const start = "dateTime" in event.start ? event.start.dateTime : "";
    return `${event.title}@${String(new Date(start).getDate())}`;
  });

describe("FakeCalendarProvider", () => {
  it("changes one occurrence, or the series from one on, and undoes it", async () => {
    const provider = setup();
    const events = await provider.listEvents([work], week(19));
    expect(events).toHaveLength(5);
    const wednesday = events[2];
    if (!wednesday) throw new Error("No Wednesday");
    expect(wednesday).toMatchObject({
      seriesId: "standup",
      organizedByMe: true,
    });

    const one = await provider.updateEvent(
      wednesday,
      { title: "Long stand-up" },
      "this",
      { notify: false },
    );
    expect(titles(await provider.listEvents([work], week(19)))).toEqual([
      "Stand-up@19",
      "Stand-up@20",
      "Long stand-up@21",
      "Stand-up@22",
      "Stand-up@23",
    ]);
    await one.undo({ notify: false });

    const rest = await provider.updateEvent(
      wednesday,
      { title: "Sync" },
      "following",
      { notify: false },
    );
    expect(titles(await provider.listEvents([work], week(19)))).toEqual([
      "Stand-up@19",
      "Stand-up@20",
      "Sync@21",
      "Sync@22",
      "Sync@23",
    ]);
    // The new series goes on after this week too.
    expect(
      (await provider.listEvents([work], week(26))).every(
        (event) => event.title === "Sync",
      ),
    ).toBe(true);
    await rest.undo({ notify: false });
    expect(
      (await provider.listEvents([work], week(19))).map((event) => event.title),
    ).toEqual(Array(5).fill("Stand-up"));
  });

  it("creates repeating events and deletes the rest of a series", async () => {
    const provider = setup();
    const { event } = await provider.createEvent(
      {
        calendarId: work,
        title: "Gym",
        start: { dateTime: new Date(2026, 9, 20, 18).toISOString() },
        end: { dateTime: new Date(2026, 9, 20, 19).toISOString() },
        location: "",
        descriptionHtml: "",
        guests: [],
        videoCall: false,
        repeat: { kind: "weekly", until: "2026-11-10" },
      },
      { notify: false },
    );
    const gyms = async () =>
      (await provider.listEvents([work], week(19, 28))).filter(
        (e) => e.title === "Gym",
      );
    // 20 and 27 October, 3 and 10 November.
    expect(await gyms()).toHaveLength(4);
    const [, second] = await gyms();
    if (!second) throw new Error("No second");
    expect(event.seriesId).toBe(second.seriesId);
    await provider.deleteEvent(second, "following", { notify: false });
    expect(await gyms()).toHaveLength(1);
    expect(provider.writes.map((write) => write.kind)).toEqual([
      "create",
      "delete",
    ]);
  });
});
