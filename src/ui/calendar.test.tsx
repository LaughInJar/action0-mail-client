import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IcsSubscription } from "../core/calendar";
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
