import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asMessageId } from "../core/ids";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { UI_STATE_KEY } from "../state/uiStore";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const option = (name: RegExp) => screen.findByRole("option", { name });
const menu = (name: string | RegExp) => screen.findByRole("menu", { name });
const entries = (scope: HTMLElement) =>
  Array.from(scope.querySelectorAll('[role^="menuitem"]')).map(
    (item) => item.textContent,
  );
const entry = (scope: HTMLElement, name: string | RegExp) =>
  within(scope).getByRole("menuitem", { name });

type User = ReturnType<typeof renderApp>["user"];

async function rightClick(user: User, target: Element) {
  await user.pointer({ keys: "[MouseRight]", target });
}

/** A long press by touch; the lifting finger's click lands on `target`. */
async function longPress(target: Element) {
  fireEvent.pointerDown(target, {
    pointerType: "touch",
    pointerId: 1,
    clientX: 20,
    clientY: 20,
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
  fireEvent.pointerUp(target, { pointerType: "touch", pointerId: 1 });
  fireEvent.click(target, { detail: 1 });
}

/** Chooses a menu entry by touch (a fresh press, then its click). */
function tap(target: Element) {
  fireEvent.pointerDown(target, { pointerType: "touch" });
  fireEvent.click(target, { detail: 1 });
}

function inboxUnread(): number {
  const item = screen.getByRole("treeitem", { name: /^Inbox/ });
  return Number(/(\d+) unread/.exec(item.textContent)?.[1] ?? 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the menu of list rows", () => {
  it("acts on the selection when its row is part of it", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("x{Shift>}jj{/Shift}");
    expect(await screen.findByText("3 selected")).toBeInTheDocument();

    await rightClick(user, await option(/New logo draft/));
    const opened = await menu("3 messages");
    // Opening, answering and the sender are for one message only.
    expect(entries(opened)).not.toContain("Open");
    await user.click(entry(opened, "Archive (a)"));
    expect(await toastText("Archived 3 messages")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Welcome to the demo/ }),
    ).not.toBeInTheDocument();
  });

  it("acts on that row only when it isn't selected", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("x{Shift>}j{/Shift}");
    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    await rightClick(user, await option(/Packing list/));
    const opened = await menu(/Packing list/);
    expect(entries(opened).slice(0, 2)).toEqual(["Open", "Open in a new tab"]);
    await user.click(entry(opened, "Archive (a)"));
    expect(await toastText("Archived 1 message")).toBeInTheDocument();
    // The selection stays as it was.
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(await option(/New logo draft/)).toBeInTheDocument();
  });

  it("opens with Shift+F10 and is used with the keyboard", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await option(/Welcome to the demo/);
    screen.getByRole("listbox").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const opened = await menu("Welcome to the demo");
    expect(entry(opened, "Open")).toHaveFocus();
    await user.keyboard("{End}");
    expect(entry(opened, "Show original (Ctrl+U)")).toHaveFocus();
    // The app's shortcuts wait while the menu is open.
    await user.keyboard("a");
    expect(screen.queryByText(/^Archived/)).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens a mail in a new tab, finds mail from its sender and copies the address", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    // user-event puts a clipboard stub in place.
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const row = await option(/New logo draft/);

    await rightClick(user, row);
    await user.click(entry(await menu("New logo draft"), "Open in a new tab"));
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/localhost(:\d+)?\/#\/.+\/inbox\/.+/),
      "_blank",
      "noopener,noreferrer",
    );

    await rightClick(user, row);
    await user.click(
      entry(await menu("New logo draft"), "Copy sender address"),
    );
    expect(await navigator.clipboard.readText()).toBe(
      "anna.berger@example.org",
    );
    expect(
      await toastText("Copied anna.berger@example.org"),
    ).toBeInTheDocument();

    await rightClick(user, row);
    await user.click(entry(await menu("New logo draft"), /^Mail from/));
    await waitFor(() => {
      expect(window.location.hash).toContain(
        "q=from%3Aanna.berger%40example.org",
      );
    });
    expect(window.location.hash).toContain("in=all");
  });

  it("keeps the browser's menu on Shift+right-click", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("{Shift>}");
    await rightClick(user, await option(/New logo draft/));
    await user.keyboard("{/Shift}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("is a sheet on phones, opened with a long press that offers Select", async () => {
    renderApp({ viewport: "narrow" });
    const row = await option(/New logo draft/);
    const hash = window.location.hash;
    await longPress(row);
    const sheet = await screen.findByRole("dialog", { name: "New logo draft" });
    const opened = within(sheet).getByRole("menu");
    expect(entries(opened)[0]).toBe("Select");
    // The lifting finger neither opened the mail nor chose anything.
    expect(window.location.hash).toBe(hash);
    tap(entry(opened, "Open"));
    await waitFor(() => {
      expect(window.location.hash).not.toBe(hash);
    });
    expect(await subject("New logo draft")).toBeInTheDocument();
  });
});

describe("the menu of a mailbox", () => {
  it("marks everything read, and Undo brings the unread ones back", async () => {
    const { user } = renderApp({ hash: demoHash("work") });
    await screen.findByRole("heading", { level: 2, name: "Work" });
    await waitFor(() => {
      expect(inboxUnread()).toBeGreaterThan(0);
    });
    const before = inboxUnread();

    await rightClick(user, screen.getByRole("treeitem", { name: /^Inbox/ }));
    await user.click(entry(await menu("Label Inbox"), "Mark all as read"));
    expect(
      await toastText(`Marked ${String(before)} messages in Inbox as read`),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(inboxUnread()).toBe(0);
    });

    await user.keyboard("z");
    await waitFor(() => {
      expect(inboxUnread()).toBe(before);
    });

    // Nothing unread: the entry is there but can't be chosen.
    await rightClick(user, screen.getByRole("treeitem", { name: /^Inbox/ }));
    await user.click(entry(await menu("Label Inbox"), "Mark all as read"));
    await waitFor(() => {
      expect(inboxUnread()).toBe(0);
    });
    await rightClick(user, screen.getByRole("treeitem", { name: /^Inbox/ }));
    expect(entry(await menu("Label Inbox"), "Mark all as read")).toBeDisabled();
  });
});

describe("the menu of a message in the reader", () => {
  it("acts on that message only, also inside a conversation", async () => {
    window.localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        state: { settings: { conversations: true } },
        version: 1,
      }),
    );
    const { user, services } = renderApp({ hash: demoHash("inbox", "trip-1") });
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    await subject(/Trip to Lake Como/);
    const messages = screen.getByRole("list", { name: "Messages" });
    const older = within(messages).getByRole("button", {
      name: /^Anna Berger.*Shall we/,
    });

    await rightClick(user, older);
    const opened = await menu(/Trip to Lake Como/);
    expect(entries(opened)).toContain("Reply (r)");
    await user.click(entry(opened, "Star (s)"));
    expect(await toastText("Starred 1 message")).toBeInTheDocument();
    const flagged = await Promise.all(
      ["trip-1", "trip-2", "trip-3"].map(async (id) => {
        const message = await provider.getMessage(asMessageId(id));
        return message.flags.flagged;
      }),
    );
    expect(flagged).toEqual([true, false, false]);
  });
});

describe("the menu of a calendar event", () => {
  const WEEK = "#/calendar/week/2026-10-15";
  const chip = (name: RegExp) => screen.findByRole("button", { name });

  it("opens, edits and answers from a right-click", async () => {
    const { user } = renderApp({ hash: WEEK });
    await rightClick(user, await chip(/^Lunch with Sophie/));
    const own = await menu("Lunch with Sophie");
    expect(entries(own)).toEqual(["Open", "Edit", "Delete"]);
    await user.click(entry(own, "Edit"));
    expect(
      await screen.findByRole("region", { name: "Edit event" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await rightClick(user, await chip(/^Design review/));
    const invitation = await menu("Design review");
    expect(entries(invitation)).toEqual(["Open", "Accept", "Maybe", "Decline"]);
    await user.click(
      within(invitation).getByRole("menuitemradio", { name: "Accept" }),
    );
    expect(await toastText("Accepted “Design review”")).toBeInTheDocument();
    await rightClick(user, await chip(/^Design review/));
    expect(
      within(await menu("Design review")).getByRole("menuitemradio", {
        name: "Accept",
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("offers joining a meeting and copying its link", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { user } = renderApp({ hash: WEEK });
    const [standup] = await screen.findAllByRole("button", {
      name: /^Stand-up/,
    });
    if (!standup) throw new Error("No stand-up");
    standup.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const opened = await menu("Stand-up");
    expect(entries(opened)).toContain("Copy meeting link");
    await user.click(entry(opened, "Join meeting"));
    expect(open).toHaveBeenCalledWith(
      "https://meet.example/standup",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens with a long press on events that can't be dragged", async () => {
    renderApp({ hash: "#/calendar/agenda/2026-10-15" });
    const review = await chip(/^Design review/);
    await longPress(review);
    expect(await menu("Design review")).toBeInTheDocument();
    // The lifting finger didn't open the event.
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
