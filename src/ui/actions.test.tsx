import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { demoHash, renderApp } from "../test/renderApp";
import { MARK_READ_DELAY_MS } from "./reader/useMarkReadOnView";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const option = (name: RegExp) => screen.findByRole("option", { name });
const wait = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Unread count shown next to "Inbox" in the tree. */
function inboxUnread(): number {
  const item = screen.getByRole("treeitem", { name: /^Inbox/ });
  return Number(/(\d+) unread/.exec(item.textContent)?.[1] ?? 0);
}

/** The toast's text, once one is shown. */
async function toastText(text: string | RegExp) {
  return screen.findByText(text, { selector: "div[aria-live] span" });
}

describe("archive", () => {
  it("archives the focused message with `a`, opens the next one, and undoes with `z`", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await waitFor(() => {
      expect(inboxUnread()).toBe(18);
    });

    await user.keyboard("a");
    expect(await subject("This week in web development")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Welcome to the demo/ }),
    ).not.toBeInTheDocument();
    expect(await toastText("Archived 1 message")).toBeInTheDocument();
    expect(inboxUnread()).toBe(17);

    await user.keyboard("z");
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
    expect(await subject("Welcome to the demo")).toBeInTheDocument();
    expect(screen.queryByText("Archived 1 message")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(inboxUnread()).toBe(18);
    });
  });

  it("archives a selection from the selection bar and offers Undo in the toast", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("x{Shift>}j{/Shift}");
    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive (a)" }));
    expect(await toastText("Archived 2 messages")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Welcome to the demo/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /This week in web development/ }),
    ).not.toBeInTheDocument();
    expect(await subject("New logo draft")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Undo/ }));
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
    expect(await option(/This week in web development/)).toBeInTheDocument();
  });

  it("explains when there is nothing to archive", async () => {
    const { user } = renderApp({ hash: demoHash("spam", "spam-1") });
    await subject("You have won!!!");
    expect(
      screen.getByRole("button", { name: "Not in the Inbox" }),
    ).toBeDisabled();
    await user.keyboard("a");
    expect(
      await toastText("Not in the Inbox, nothing to archive."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /You have won/ }),
    ).toBeInTheDocument();
  });

  it("rolls back and reports a failed write", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    provider.failWrites = true;

    await user.keyboard("a");
    expect(
      await toastText(/Couldn’t archive: The demo server refused the change/),
    ).toBeInTheDocument();
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
    expect(inboxUnread()).toBe(18);
  });

  it("follows to the next message in the phone reader", async () => {
    const { user } = renderApp({ viewport: "narrow" });
    await user.click(await option(/New logo draft/));
    await subject("New logo draft");
    await user.click(screen.getByRole("button", { name: "Archive (a)" }));
    expect(await subject("Packing list for the weekend")).toBeInTheDocument();
    expect(window.location.hash).toBe(demoHash("inbox", "plain-text"));
  });
});

describe("read state", () => {
  it("marks unread and read with Shift+U and Shift+I", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "inline-image") });
    await subject("New logo draft");
    const row = await option(/New logo draft/);
    expect(within(row).queryByText("Unread,")).not.toBeInTheDocument();

    await user.keyboard("{Shift>}u{/Shift}");
    expect(within(row).getByText("Unread,")).toBeInTheDocument();
    expect(await toastText("Marked 1 message as unread")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mark as read (Shift+I)" }),
    ).toBeInTheDocument();

    // Marking it unread by hand isn't undone by the automatic mark-as-read.
    await wait(MARK_READ_DELAY_MS + 200);
    expect(within(row).getByText("Unread,")).toBeInTheDocument();

    await user.keyboard("{Shift>}i{/Shift}");
    expect(within(row).queryByText("Unread,")).not.toBeInTheDocument();
    expect(await toastText("Marked 1 message as read")).toBeInTheDocument();
  });

  it("marks a message read after it was shown for a while, but not while skimming", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("j");
    await subject("This week in web development");

    await wait(MARK_READ_DELAY_MS + 300);
    const welcome = await option(/Welcome to the demo/);
    const newsletter = await option(/This week in web development/);
    expect(within(welcome).getByText("Unread,")).toBeInTheDocument();
    expect(within(newsletter).queryByText("Unread,")).not.toBeInTheDocument();
    // Silent: no toast for automatic changes.
    expect(screen.queryByText(/Marked .* as read/)).not.toBeInTheDocument();
  });
});
