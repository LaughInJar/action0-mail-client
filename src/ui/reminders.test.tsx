import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCalendarProvider } from "../providers/fake/FakeCalendarProvider";
import type { FakeEventTemplate } from "../providers/fake/FakeCalendarProvider";
import {
  createDemoCalendar,
  DEMO_CALENDAR,
} from "../providers/fake/demoCalendar";
import { UI_STATE_KEY } from "../state/uiStore";
import { fakeDesktopPlatform } from "../test/desktopPlatform";
import { renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 20_000 });

/**
 * The tests place events around "now": run them on a Wednesday morning,
 * whatever the clock says, so no event crosses midnight or the week's end.
 * Only `Date` is replaced, and it keeps running from there.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 21, 9, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

const pad = (n: number) => String(n).padStart(2, "0");

/** The demo's calendars with only these events, around the real "now". */
function calendarWith(
  events: readonly {
    readonly key: string;
    readonly title: string;
    /** Minutes from now. */
    readonly startsIn: number;
    readonly reminders: readonly number[];
    readonly meetingUrl?: string;
  }[],
) {
  const now = Date.now();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const templates = events.map((spec): FakeEventTemplate => {
    // Events start on a full minute (HH:MM): round up, so one due "in half
    // a minute" isn't due already when the clock's seconds are past 30.
    const start = new Date(
      Math.ceil((now + spec.startsIn * 60_000) / 60_000) * 60_000,
    );
    const end = new Date(start.getTime() + 30 * 60_000);
    const midnight = new Date(start);
    midnight.setHours(0, 0, 0, 0);
    return {
      key: spec.key,
      calendarId: DEMO_CALENDAR.work,
      title: spec.title,
      day: Math.round((midnight.getTime() - monday.getTime()) / 86_400_000),
      start: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
      end: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
      reminders: spec.reminders,
      ...(spec.meetingUrl ? { meetingUrl: spec.meetingUrl } : {}),
    };
  });
  return () => ({ ...createDemoCalendar(now), events: templates });
}

const panel = () => screen.findByRole("region", { name: "Reminders" });
const item = async (title: string) =>
  within(await panel()).findByRole("listitem", { name: title });

describe("event reminders", () => {
  it("show what's due, with Join and Open; snooze and dismiss take them away", async () => {
    const desktop = fakeDesktopPlatform();
    const { user } = renderApp({
      reminders: true,
      platform: desktop.platform,
      calendar: calendarWith([
        {
          key: "review",
          title: "Sprint review",
          startsIn: 5,
          reminders: [10],
          meetingUrl: "https://meet.example/review",
        },
        { key: "retro", title: "Retro", startsIn: 8, reminders: [15] },
        { key: "later", title: "Planning", startsIn: 90, reminders: [10] },
      ]),
    });
    const review = await item("Sprint review");
    expect(review).toHaveTextContent(/In [56] minutes/);
    expect(
      within(await panel()).queryByRole("listitem", { name: "Planning" }),
    ).not.toBeInTheDocument();

    await user.click(within(review).getByRole("button", { name: "Join" }));
    expect(desktop.platform.openExternal).toHaveBeenCalledWith(
      "https://meet.example/review",
    );
    await user.click(within(review).getByRole("button", { name: "Open" }));
    expect(window.location.hash).toMatch(/^#\/calendar\/day\//);

    await user.click(within(review).getByRole("button", { name: "Snooze" }));
    await user.click(
      within(review).getByRole("button", { name: "Snooze 5 minutes" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("listitem", { name: "Sprint review" }),
      ).not.toBeInTheDocument();
    });
    const stored = window.localStorage.getItem(UI_STATE_KEY) ?? "";
    expect(stored).toContain("snoozedUntil");
    // Ids and times only, never what the event is about.
    expect(stored).not.toContain("Sprint review");

    await user.click(
      within(await item("Retro")).getByRole("button", {
        name: "Dismiss: Retro",
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Reminders" }),
      ).not.toBeInTheDocument();
    });
  });

  it("remember a dismissal at the next start", async () => {
    const calendar = calendarWith([
      { key: "retro", title: "Retro", startsIn: 8, reminders: [15] },
    ]);
    const first = renderApp({ reminders: true, calendar });
    await first.user.click(
      within(await item("Retro")).getByRole("button", {
        name: "Dismiss: Retro",
      }),
    );
    first.unmount();
    renderApp({ reminders: true, calendar });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    // Give the calendars a moment to load.
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(
      screen.queryByRole("region", { name: "Reminders" }),
    ).not.toBeInTheDocument();
  });

  it("notify when one comes due while the app is in the background", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const desktop = fakeDesktopPlatform();
    renderApp({
      reminders: true,
      platform: desktop.platform,
      // Due in half a minute to a minute and a half.
      calendar: calendarWith([
        {
          key: "call",
          title: "Call with Anna",
          startsIn: 10.5,
          reminders: [10],
        },
      ]),
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    expect(
      screen.queryByRole("region", { name: "Reminders" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110_000);
    });
    expect(await item("Call with Anna")).toBeInTheDocument();
    expect(desktop.platform.notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Call with Anna" }),
    );
  });

  it("dismiss and snooze in Outlook too, where it keeps the reminders", async () => {
    const { user, services } = renderApp({
      reminders: true,
      syncedReminders: true,
      calendar: calendarWith([
        { key: "a", title: "Budget call", startsIn: 5, reminders: [10] },
        { key: "b", title: "1:1", startsIn: 6, reminders: [10] },
      ]),
    });
    const budget = await item("Budget call");
    await user.click(
      within(budget).getByRole("button", { name: "Dismiss: Budget call" }),
    );
    const oneOnOne = await item("1:1");
    await user.click(within(oneOnOne).getByRole("button", { name: "Snooze" }));
    await user.click(
      within(oneOnOne).getByRole("button", { name: "Snooze 10 minutes" }),
    );
    const calendar = services.registry.list()[0]
      ?.calendar as FakeCalendarProvider;
    await waitFor(() => {
      expect(calendar.writes.map((write) => write.kind)).toEqual([
        "dismiss",
        "snooze",
      ]);
    });
  });

  it("don't show with the setting off", async () => {
    renderApp({
      calendar: calendarWith([
        { key: "retro", title: "Retro", startsIn: 8, reminders: [15] },
      ]),
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(
      screen.queryByRole("region", { name: "Reminders" }),
    ).not.toBeInTheDocument();
  });
});

describe("reminders in the event editor", () => {
  it("start with the calendar's default and can be changed", async () => {
    const today = new Date();
    const hash = `#/calendar/week/${String(today.getFullYear())}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const { user } = renderApp({
      hash,
      calendar: calendarWith([]),
    });
    await screen.findByRole("main", { name: "Calendar" });
    await user.keyboard("c");
    const form = await screen.findByRole("region", { name: "New event" });
    // The Work calendar's default.
    expect(within(form).getByLabelText("Reminder 1")).toHaveDisplayValue(
      "10 minutes before",
    );
    await user.keyboard("Dentist");
    await user.click(
      within(form).getByRole("button", { name: "Add reminder" }),
    );
    await user.selectOptions(
      within(form).getByLabelText("Reminder 1"),
      "1 day before",
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: /^Dentist/ }));
    const details = await screen.findByRole("article", { name: "Dentist" });
    expect(details).toHaveTextContent("5 minutes before, 1 day before");
  });
});
