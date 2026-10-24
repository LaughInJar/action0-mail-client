import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IcsSubscription } from "../core/calendar";
import type { FakeCalendarProvider } from "../providers/fake/FakeCalendarProvider";
import { IcsCalendarProvider } from "../providers/ical/IcsCalendarProvider";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

/** The demo calendar's week (Thursday 15 October 2026 has the invitation). */
const WEEK = "#/calendar/week/2026-10-15";

const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const chip = (name: RegExp) => screen.findByRole("button", { name });
const details = (name: string) => screen.findByRole("article", { name });
const going = (scope: HTMLElement) =>
  within(scope).getByRole("group", { name: "Going?" });

describe("the Mail | Calendar switch", () => {
  it("opens the calendar and goes back to the mail where it was", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const mailHash = window.location.hash;
    await user.click(screen.getByRole("button", { name: "Calendar" }));
    expect(window.location.hash).toMatch(
      /^#\/calendar\/week\/\d{4}-\d{2}-\d{2}$/,
    );
    expect(
      await screen.findByRole("main", { name: "Calendar" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Calendar", pressed: true }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mail" }));
    expect(window.location.hash).toBe(mailHash);
    expect(await subject("Welcome to the demo")).toBeInTheDocument();
  });

  it("goes there with g c and back with g i", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("gc");
    expect(
      await screen.findByRole("main", { name: "Calendar" }),
    ).toBeInTheDocument();
    await user.keyboard("gi");
    await waitFor(() => {
      expect(window.location.hash).toContain("/inbox");
    });
  });
});

describe("the calendar", () => {
  it("shows the week's events from every ticked calendar", async () => {
    const { user } = renderApp({ hash: WEEK });
    expect(await chip(/^Design review/)).toBeInTheDocument();
    expect(await chip(/^Lunch with Sophie/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /Oct 11\s–\s17, 2026/ }),
    ).toBeInTheDocument();

    // Unticking Personal hides its events; it stays unticked.
    await user.click(screen.getByRole("checkbox", { name: "Personal" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /^Lunch with Sophie/ }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("checkbox", { name: "Personal" }),
    ).not.toBeChecked();
  });

  it("pages with the arrows and switches views with keys", async () => {
    const { user } = renderApp({ hash: WEEK });
    await chip(/^Design review/);
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(window.location.hash).toBe("#/calendar/week/2026-10-22");
    });
    await user.keyboard("m");
    expect(
      await screen.findByRole("heading", { level: 2, name: "October 2026" }),
    ).toBeInTheDocument();
    await user.keyboard("a");
    await waitFor(() => {
      expect(window.location.hash).toBe("#/calendar/agenda/2026-10-22");
    });
    await user.keyboard("t");
    await waitFor(() => {
      expect(window.location.hash).not.toContain("2026-10-22");
    });
  });

  it("opens an event, answers it and undoes a changed answer", async () => {
    const { user } = renderApp({ hash: WEEK });
    await user.click(await chip(/^Team meeting/));
    const event = await details("Team meeting");
    expect(event).toHaveTextContent("Meeting room 1");
    expect(
      within(going(event)).getByRole("button", { name: "Yes" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(within(going(event)).getByRole("button", { name: "No" }));
    expect(await toastText("Declined “Team meeting”")).toBeInTheDocument();
    expect(
      within(going(event)).getByRole("button", { name: "No" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("z");
    await waitFor(() => {
      expect(
        within(going(event)).getByRole("button", { name: "Yes" }),
      ).toHaveAttribute("aria-pressed", "true");
    });

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("article")).not.toBeInTheDocument();
    });
  });

  it("asks accounts without calendar access to allow it", async () => {
    const { user } = renderApp({ hash: WEEK, calendarAccess: "missing" });
    await user.click(
      await screen.findByRole("button", { name: "Allow calendar" }),
    );
    expect(await screen.findByRole("checkbox", { name: "Work" })).toBeChecked();
    expect(await chip(/^Design review/)).toBeInTheDocument();
  });
});

describe("invitations in mail", () => {
  it("shows the event, what it clashes with, and the answer buttons", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "invite-design") });
    await subject("Invitation: Design review");
    const bar = await screen.findByRole("region", { name: "Invitation" });
    await waitFor(() => {
      expect(bar).toHaveTextContent("Design review");
    });
    await waitFor(() => {
      expect(bar).toHaveTextContent(/Clashes with: 1:1 with Mia/);
    });
    await user.click(within(going(bar)).getByRole("button", { name: "Yes" }));
    expect(await toastText("Accepted “Design review”")).toBeInTheDocument();
    expect(
      within(going(bar)).getByRole("button", { name: "Yes" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:club-1@example.org",
  "DTSTART:20261014T170000Z",
  "DTEND:20261014T180000Z",
  "SUMMARY:Choir rehearsal",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("calendars by address", () => {
  const factory = (fetcher: typeof fetch) => (subscription: IcsSubscription) =>
    new IcsCalendarProvider(subscription, { fetch: fetcher });

  it("explains when the server doesn't let the browser read it", async () => {
    const { user } = renderApp({
      hash: WEEK,
      icsFactory: factory(() =>
        Promise.reject(new TypeError("Failed to fetch")),
      ),
    });
    await user.click(
      await screen.findByRole("button", { name: /Add calendar by address/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Add calendar by address",
    });
    await user.type(
      within(dialog).getByLabelText("Address (iCal)"),
      "webcal://calendar.example.org/secret/basic.ics",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "calendar.example.org doesn’t let browser apps read this calendar",
    );
  });

  it("adds a readable one, shows its events and removes it", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(ICS, { status: 200 })),
    );
    const { user } = renderApp({ hash: WEEK, icsFactory: factory(fetcher) });
    await user.click(
      await screen.findByRole("button", { name: /Add calendar by address/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Add calendar by address",
    });
    await user.type(
      within(dialog).getByLabelText("Address (iCal)"),
      "webcal://club.example.org/calendar.ics",
    );
    await user.type(within(dialog).getByLabelText("Name"), "Choir");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await toastText("Added “Choir”")).toBeInTheDocument();
    expect(await chip(/^Choir rehearsal/)).toBeInTheDocument();
    // webcal:// is read over https.
    const [url] = fetcher.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      "https://club.example.org/calendar.ics",
    );

    await user.click(screen.getByRole("button", { name: "Remove Choir" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Remove “Choir”?",
    });
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /^Choir rehearsal/ }),
      ).not.toBeInTheDocument();
    });
  });
});

/**
 * Lays out the week's time grid for pointer tests (jsdom has no layout):
 * the hour labels take 56px, then a 100px column per day, 48px an hour,
 * starting 100px from the top. Chips sit where their style puts them.
 */
function layOutWeek() {
  const GRID_TOP = 100;
  const HEIGHT = 24 * 48;
  const rect = (left: number, top: number, width: number, height: number) =>
    DOMRect.fromRect({ x: left, y: top, width, height });
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const element = this as HTMLElement;
      if (element.style.height === `${String(HEIGHT)}px`)
        return rect(0, GRID_TOP, 756, HEIGHT);
      const parent = element.parentElement;
      if (parent?.style.height === `${String(HEIGHT)}px`) {
        const index = Array.from(parent.children).indexOf(element) - 1;
        return rect(56 + index * 100, GRID_TOP, 100, HEIGHT);
      }
      // The scroller shows the whole day.
      if (
        element.firstElementChild instanceof HTMLElement &&
        element.firstElementChild.style.height === `${String(HEIGHT)}px`
      )
        return rect(0, GRID_TOP, 756, HEIGHT);
      if (element.dataset.eventKey !== undefined && parent) {
        const top = parseFloat(parent.style.top) / 100;
        const height = parseFloat(parent.style.height) / 100;
        return rect(0, GRID_TOP + top * HEIGHT, 100, height * HEIGHT);
      }
      return rect(0, 0, 0, 0);
    });
}

/** Where a time of a day of the shown week is (Sunday 11 October = 0). */
const at = (day: number, hours: number) => ({
  clientX: 56 + day * 100 + 50,
  clientY: 100 + hours * 48,
});

const pointer = (
  type: "Down" | "Move" | "Up",
  target: Element | Window,
  where: { clientX: number; clientY: number },
  pointerType = "mouse",
) => {
  const init = { ...where, pointerId: 1, pointerType, button: 0 };
  if (type === "Down") fireEvent.pointerDown(target, init);
  else if (type === "Move") fireEvent.pointerMove(target, init);
  else fireEvent.pointerUp(target, init);
};

const editor = (name: string) => screen.findByRole("region", { name });

describe("creating and editing events", () => {
  it("creates an event with c, and undoes it", async () => {
    const { user } = renderApp({ hash: WEEK });
    await chip(/^Design review/);
    await user.keyboard("c");
    const form = await editor("New event");
    // The shown day at 9:00, in the calendar used last (or the primary one).
    expect(within(form).getByLabelText("Start date")).toHaveValue("2026-10-15");
    expect(within(form).getByLabelText("Start time")).toHaveValue("09:00");
    expect(within(form).getByLabelText("Calendar")).toHaveDisplayValue("Work");
    await user.keyboard("Dentist");
    expect(
      screen.getByText("Dentist", { selector: "span" }),
    ).toBeInTheDocument();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await toastText("Created “Dentist”")).toBeInTheDocument();
    expect(await chip(/^Dentist/)).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "New event" }),
    ).not.toBeInTheDocument();

    await user.keyboard("z");
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /^Dentist/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("suggests the clicked time, and a range dragged across", async () => {
    layOutWeek();
    renderApp({ hash: WEEK });
    await chip(/^Design review/);
    const sunday = screen.getByRole("main", { name: "Calendar" });
    const column = (await chip(/^Design review/)).closest(
      "[class*='border-l']",
    );
    expect(column).not.toBeNull();
    pointer("Down", column ?? sunday, at(0, 10.2));
    pointer("Up", window, at(0, 10.2));
    await waitFor(() => {
      expect(window.location.hash).toBe(
        "#/calendar/week/2026-10-15/new/2026-10-11T10%3A00/2026-10-11T11%3A00",
      );
    });
    const form = await editor("New event");
    expect(within(form).getByLabelText("Start time")).toHaveValue("10:00");
    expect(within(form).getByLabelText("End time")).toHaveValue("11:00");

    // Dragging across 14:00–15:30 on Saturday picks that instead.
    pointer("Down", column ?? sunday, at(6, 14.1));
    pointer("Move", window, at(6, 14.6));
    pointer("Move", window, at(6, 15.4));
    pointer("Up", window, at(6, 15.4));
    await waitFor(() => {
      expect(within(form).getByLabelText("Start date")).toHaveValue(
        "2026-10-17",
      );
    });
    expect(within(form).getByLabelText("Start time")).toHaveValue("14:00");
    expect(within(form).getByLabelText("End time")).toHaveValue("15:30");
  });

  it("moves an event by dragging, and undoes it", async () => {
    layOutWeek();
    const { user } = renderApp({ hash: WEEK });
    const lunch = await chip(/^Lunch with Sophie/);
    // Wednesday 12:30–13:30, grabbed at 12:45 and dropped two hours later.
    pointer("Down", lunch, at(3, 12.75));
    pointer("Move", window, at(3, 13.5));
    pointer("Move", window, at(3, 14.75));
    pointer("Up", window, at(3, 14.75));
    fireEvent.click(lunch);
    expect(await toastText("Moved “Lunch with Sophie”")).toBeInTheDocument();
    expect(await chip(/^Lunch with Sophie, 2:30/)).toBeInTheDocument();
    // The click that ended the drag didn't open it.
    expect(screen.queryByRole("article")).not.toBeInTheDocument();

    await user.keyboard("z");
    expect(await chip(/^Lunch with Sophie, 12:30/)).toBeInTheDocument();
  });

  it("lifts an event with a long press on touch, and changes its length at the bottom", async () => {
    layOutWeek();
    renderApp({ hash: WEEK });
    const lunch = await chip(/^Lunch with Sophie/);
    // Near the bottom edge: that changes the length.
    pointer("Down", lunch, at(3, 13.45), "touch");
    await new Promise((resolve) => setTimeout(resolve, 450));
    pointer("Move", window, at(3, 14.5), "touch");
    pointer("Up", window, at(3, 14.5), "touch");
    expect(await toastText("Moved “Lunch with Sophie”")).toBeInTheDocument();
    expect(
      await chip(/^Lunch with Sophie, 12:30\s*–\s*2:30/),
    ).toBeInTheDocument();
  });

  it("opens an event's menu when it's lifted and let go in place", async () => {
    layOutWeek();
    renderApp({ hash: WEEK });
    const lunch = await chip(/^Lunch with Sophie/);
    pointer("Down", lunch, at(3, 13), "touch");
    await new Promise((resolve) => setTimeout(resolve, 450));
    pointer("Up", window, at(3, 13), "touch");
    // The lifting finger's click doesn't open the event.
    fireEvent.click(lunch, { detail: 1 });
    const menu = await screen.findByRole("menu", { name: "Lunch with Sophie" });
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toHaveFocus();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Moved/)).not.toBeInTheDocument();
  });

  it("edits a repeating meeting: which events, and whether the guests hear about it (again on undo)", async () => {
    const { user, services } = renderApp({ hash: WEEK });
    const [standup] = await screen.findAllByRole("button", {
      name: /^Stand-up/,
    });
    if (!standup) throw new Error("No stand-up");
    await user.click(standup);
    const details = await screen.findByRole("article", { name: "Stand-up" });
    await user.click(within(details).getByRole("button", { name: "Edit" }));
    const form = await editor("Edit event");
    const title = await within(form).findByDisplayValue("Stand-up");
    await user.clear(title);
    await user.type(title, "Daily");
    expect(within(form).getByLabelText("Repeat")).toHaveDisplayValue(
      "Every weekday (Monday to Friday)",
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));

    const scope = await screen.findByRole("alertdialog", {
      name: "Change a repeating event",
    });
    await user.click(within(scope).getByRole("button", { name: "All events" }));
    const notify = await screen.findByRole("alertdialog", {
      name: "Send an update to the guests?",
    });
    await user.click(within(notify).getByRole("button", { name: "Send" }));
    expect(await toastText("Saved “Daily”")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: /^Stand-up/ }),
      ).toHaveLength(0);
    });
    expect(
      screen.getAllByRole("button", { name: /^Daily/ }).length,
    ).toBeGreaterThan(1);

    await user.keyboard("z");
    const again = await screen.findByRole("alertdialog", {
      name: "Send an update to the guests?",
    });
    await user.click(within(again).getByRole("button", { name: "Don’t send" }));
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: /^Daily/ })).toHaveLength(
        0,
      );
    });
    const calendar = services.registry.list()[0]
      ?.calendar as FakeCalendarProvider;
    expect(calendar.writes).toEqual([
      { kind: "update", scope: "all", notify: true },
      { kind: "undo", notify: false },
    ]);
  });

  it("asks before deleting a meeting whose guests always hear about it, without undo", async () => {
    const { user } = renderApp({ hash: WEEK, guestNotices: "always" });
    const standups = await screen.findAllByRole("button", {
      name: /^Stand-up/,
    });
    await user.click(standups[0] ?? document.body);
    const details = await screen.findByRole("article", { name: "Stand-up" });
    await user.click(within(details).getByRole("button", { name: "Delete" }));
    const scope = await screen.findByRole("alertdialog", {
      name: "Delete a repeating event",
    });
    await user.click(within(scope).getByRole("button", { name: "This event" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete “Stand-up”?",
    });
    expect(confirm).toHaveTextContent("can’t be undone");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(await toastText("Deleted “Stand-up”")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: /^Stand-up/ }),
      ).toHaveLength(standups.length - 1);
    });
  });

  it("asks before throwing away changes, also on Back", async () => {
    const { user } = renderApp({ hash: WEEK });
    await chip(/^Design review/);
    await user.keyboard("c");
    await editor("New event");
    await user.keyboard("Gym");
    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("alertdialog", {
      name: "Discard changes?",
    });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByDisplayValue("Gym")).toBeInTheDocument();

    window.history.back();
    const again = await screen.findByRole("alertdialog", {
      name: "Discard changes?",
    });
    // Back to the editor, with what was typed.
    expect(screen.getByDisplayValue("Gym")).toBeInTheDocument();
    await user.click(within(again).getByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "New event" }),
      ).not.toBeInTheDocument();
    });
    expect(window.location.hash).toBe(WEEK);
  });

  it("can't change invitations from others or read-only calendars", async () => {
    const { user } = renderApp({ hash: WEEK });
    await user.click(await chip(/^Team meeting/));
    const details = await screen.findByRole("article", {
      name: "Team meeting",
    });
    expect(
      within(details).queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    await user.keyboard("e");
    expect(
      screen.queryByRole("region", { name: "Edit event" }),
    ).not.toBeInTheDocument();
  });
});
