import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDemoData, DEMO_MAILBOX } from "../providers/fake/demoData";
import { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const listTitle = (name: string) =>
  screen.findByRole("heading", { level: 2, name });
const option = (name: RegExp) => screen.findByRole("option", { name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const searchField = () =>
  screen.getByRole("searchbox", { name: "Search mail" });
const folderFilter = () =>
  screen.getByRole("searchbox", { name: "Filter folders" });

describe("folder filter", () => {
  it("narrows the tree as you type and opens the first match with Enter", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("gf");
    expect(folderFilter()).toHaveFocus();

    await user.keyboard("RECE");
    const tree = screen.getByRole("tree");
    expect(
      within(tree).getByRole("treeitem", { name: /Receipts/ }),
    ).toHaveAttribute("data-match", "true");
    expect(
      within(tree).queryByRole("treeitem", { name: /Inbox/ }),
    ).not.toBeInTheDocument();
    expect(within(tree).getByText("Rece", { selector: "mark" })).toBeVisible();

    await user.keyboard("{Enter}");
    expect(await listTitle("Receipts")).toBeInTheDocument();
    expect(folderFilter()).toHaveValue("");
    await waitFor(() => {
      expect(
        screen.getByRole("listbox", { name: "Messages in Receipts" }),
      ).toHaveFocus();
    });
    expect(
      within(tree).getByRole("treeitem", { name: /Inbox/ }),
    ).toBeInTheDocument();
  });

  it("shows the parents of matches, moves into them with ↓ and clears with Esc", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(folderFilter());
    await user.keyboard("client");
    expect(screen.getByRole("treeitem", { name: /^Work/ })).toHaveAttribute(
      "data-match",
      "false",
    );
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("treeitem", { name: /Clients/ })).toHaveFocus();
    // Up from the top of the tree goes back to the field.
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(folderFilter()).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(folderFilter()).toHaveValue("");
    expect(screen.getByRole("treeitem", { name: /Inbox/ })).toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.type(folderFilter(), "zzz");
    expect(screen.getByText("No matching folders.")).toBeInTheDocument();
  });

  it("opens the drawer for g f on tablets", async () => {
    const { user } = renderApp({ viewport: "medium" });
    await subject("Welcome to the demo");
    await user.keyboard("gf");
    const drawer = await screen.findByRole("dialog", { name: "Folders" });
    await waitFor(() => {
      expect(
        within(drawer).getByRole("searchbox", { name: "Filter folders" }),
      ).toHaveFocus();
    });
  });
});

describe("mail search", () => {
  it("searches the folder as you type, keeps it in the URL, and Esc ends it", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("/");
    expect(searchField()).toHaveFocus();

    await user.keyboard("logo draft");
    expect(await listTitle("Results for “logo draft”")).toBeInTheDocument();
    const results = await screen.findByRole("listbox", {
      name: "Results for “logo draft”",
    });
    expect(within(results).getAllByRole("option")).toHaveLength(1);
    expect(window.location.hash).toMatch(/\/inbox(\/[^?]*)?\?q=logo\+draft$/);
    // The first result opens, like in any list.
    expect(await subject("New logo draft")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(await listTitle("Inbox")).toBeInTheDocument();
    expect(searchField()).toHaveValue("");
    expect(window.location.hash).not.toContain("?q=");
  });

  it("switches to Everywhere with one click, also from the empty result", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.type(searchField(), "old times");
    expect(
      await screen.findByText(/No messages match “old times” in Inbox\./),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search everywhere" }));
    expect(await option(/Old times/)).toBeInTheDocument();
    const scope = screen.getByRole("group", { name: "Search in" });
    expect(
      within(scope).getByRole("button", { name: "Everywhere" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(window.location.hash).toContain("&in=all");
    expect(searchField()).toHaveAttribute("placeholder", "Search all mail");

    await user.click(within(scope).getByRole("button", { name: "Inbox" }));
    expect(
      await screen.findByText(/No messages match “old times” in Inbox\./),
    ).toBeInTheDocument();
  });

  it("moves to the results with Enter, where actions and undo work", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.type(searchField(), "logo draft{Enter}");
    const results = await screen.findByRole("listbox", {
      name: "Results for “logo draft”",
    });
    await waitFor(() => {
      expect(results).toHaveFocus();
    });
    await subject("New logo draft");

    await user.keyboard("a");
    expect(await toastText("Archived 1 message")).toBeInTheDocument();
    expect(
      await screen.findByText(/No messages match “logo draft” in Inbox\./),
    ).toBeInTheDocument();

    await user.keyboard("z");
    expect(await option(/New logo draft/)).toBeInTheDocument();
  });

  it("follows Back and Forward, and a folder click ends the search", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await user.type(searchField(), "logo");
    await listTitle("Results for “logo”");

    act(() => {
      services.router.back();
    });
    expect(await listTitle("Inbox")).toBeInTheDocument();
    expect(searchField()).toHaveValue("");

    act(() => {
      window.history.forward();
    });
    expect(await listTitle("Results for “logo”")).toBeInTheDocument();
    expect(searchField()).toHaveValue("logo");

    await user.click(screen.getByRole("treeitem", { name: /Inbox/ }));
    expect(await listTitle("Inbox")).toBeInTheDocument();
    expect(searchField()).toHaveValue("");
  });

  it("keeps the search while reading on a phone; Back returns to the results", async () => {
    const { user } = renderApp({
      viewport: "narrow",
      hash: `${demoHash("inbox")}?q=logo`,
    });
    await user.click(await option(/New logo draft/));
    expect(await subject("New logo draft")).toBeInTheDocument();
    expect(window.location.hash).toMatch(/\/inline-image\?q=logo$/);

    await user.click(screen.getByRole("button", { name: "Back to messages" }));
    expect(await listTitle("Results for “logo”")).toBeInTheDocument();
  });
});

describe("sort order", () => {
  it("shows the oldest first on request and remembers it", async () => {
    const oldest = await new FakeMailProvider(
      createDemoData(TEST_NOW),
    ).listMessages({
      mailboxId: DEMO_MAILBOX.inbox,
      order: "oldest",
      limit: 1,
    });
    const oldestSubject = oldest.items[0]?.subject ?? "";

    const { user, unmount } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Newest first" }));
    expect(
      screen.getByRole("button", { name: "Oldest first" }),
    ).toBeInTheDocument();
    const [first] = await screen.findAllByRole("option");
    expect(first).toHaveTextContent(oldestSubject);
    // The cursor starts at the top of the re-sorted list.
    expect(await subject(oldestSubject)).toBeInTheDocument();
    unmount();

    renderApp();
    expect(
      await screen.findByRole("button", { name: "Oldest first" }),
    ).toBeInTheDocument();
  });
});
