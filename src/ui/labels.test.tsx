import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const treeItem = (name: string) =>
  screen.findByRole("treeitem", { name: new RegExp(`^${name}`) });
const menu = (name: string) =>
  screen.findByRole("menu", { name: `Label ${name}` });

/** Opens the menu of a label by right-clicking it in the tree. */
async function rightClick(
  user: ReturnType<typeof renderApp>["user"],
  name: string,
) {
  await user.pointer({ keys: "[MouseRight]", target: await treeItem(name) });
}

describe("creating labels from the pickers", () => {
  it("creates a label in the Labels picker and applies it", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: /Labels/ });
    await user.keyboard("Newsletters");
    expect(
      within(dialog).getByRole("option", {
        name: "Create label “Newsletters”",
      }),
    ).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    const created = await within(dialog).findByRole("option", {
      name: "Newsletters",
    });
    expect(created).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Enter}");
    expect(
      await toastText("Added label Newsletters to 1 message"),
    ).toBeInTheDocument();
    expect(await treeItem("Newsletters")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Labels" })).toHaveTextContent(
      "Newsletters",
    );
  });

  it("creates a nested label in the Move picker and moves there", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("v");
    const dialog = await screen.findByRole("dialog", { name: /Move to/ });
    await user.keyboard("work/2026");
    await user.click(
      within(dialog).getByRole("option", {
        name: "Create label “work / 2026”",
      }),
    );
    expect(await toastText("Moved 1 message to 2026")).toBeInTheDocument();
    const nested = await treeItem("2026");
    expect(nested).toHaveAttribute("aria-level", "3");
  });

  it("doesn't offer to create what exists", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: /Labels/ });
    await user.keyboard("work / clients");
    expect(
      within(dialog).queryByRole("option", { name: /Create label/ }),
    ).not.toBeInTheDocument();
  });
});

describe("the label menu", () => {
  it("opens from the ⋯ button, a right-click and Shift+F10", async () => {
    const { user } = renderApp({ hash: demoHash("receipts") });
    const receipts = await treeItem("Receipts");
    const button = receipts.querySelector<HTMLElement>("[data-label-menu]");
    expect(button).not.toBeNull();
    if (!button) return;
    await user.click(button);
    expect(await menu("Receipts")).toBeInTheDocument();
    expect(
      within(await menu("Receipts"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Open in a new tab",
      "Mark all as read",
      "Rename…",
      "Colour…",
      "Move under…",
      "Add sublabel…",
      "Hide from folder list",
      "Delete…",
    ]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await rightClick(user, "Personal");
    expect(await menu("Personal")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    (await treeItem("Work")).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const workMenu = await menu("Work");
    expect(
      within(workMenu).getByRole("menuitem", { name: "Open in a new tab" }),
    ).toHaveFocus();
    await user.keyboard("{End}");
    expect(
      within(workMenu).getByRole("menuitem", { name: "Delete…" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(
      within(workMenu).getByRole("menuitem", { name: "Open in a new tab" }),
    ).toHaveFocus();
  });

  it("opens with a long press; the lifting finger doesn't choose", async () => {
    const { user } = renderApp({ viewport: "narrow" });
    await screen.findByRole("option", { name: /Welcome to the demo/ });
    await user.click(screen.getByRole("button", { name: "Show folders" }));
    const personal = await treeItem("Personal");
    const hash = window.location.hash;
    fireEvent.pointerDown(personal, {
      pointerType: "touch",
      clientX: 40,
      clientY: 10,
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    const opened = await menu("Personal");
    // The click of the lifted finger lands on whatever is under it now.
    fireEvent.pointerUp(personal, { pointerType: "touch" });
    fireEvent.click(within(opened).getByRole("menuitem", { name: "Delete…" }), {
      detail: 1,
    });
    fireEvent.click(personal, { detail: 1 });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(await menu("Personal")).toBeInTheDocument();
    expect(window.location.hash).toBe(hash);
  });

  it("opens a system mailbox's menu with a long press", async () => {
    const { user } = renderApp({ viewport: "narrow" });
    await screen.findByRole("option", { name: /Welcome to the demo/ });
    await user.click(screen.getByRole("button", { name: "Show folders" }));
    const sent = await treeItem("Sent");
    const hash = window.location.hash;
    fireEvent.pointerDown(sent, {
      pointerType: "touch",
      clientX: 4,
      clientY: 4,
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    fireEvent.pointerUp(sent, { pointerType: "touch" });
    fireEvent.click(sent, { detail: 1 });
    const opened = await menu("Sent");
    expect(
      within(opened)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in a new tab"]);
    expect(window.location.hash).toBe(hash);
  });

  it("offers system mailboxes what fits them", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const entries = async (name: string) =>
      within(await menu(name))
        .getAllByRole("menuitem")
        .map((item) => item.textContent);

    await rightClick(user, "Inbox");
    expect(await entries("Inbox")).toEqual([
      "Open in a new tab",
      "Mark all as read",
    ]);
    await user.keyboard("{Escape}");

    (await treeItem("Sent")).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await entries("Sent")).toEqual(["Open in a new tab"]);
    await user.keyboard("{Escape}");

    await rightClick(user, "Trash");
    expect(await entries("Trash")).toEqual([
      "Open in a new tab",
      "Mark all as read",
      "Empty Trash",
    ]);
  });
});

describe("editing labels", () => {
  it("renames a label, and z undoes it", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await rightClick(user, "Receipts");
    await user.click(
      within(await menu("Receipts")).getByRole("menuitem", { name: "Rename…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Edit label “Receipts”",
    });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.keyboard("Bills{Enter}");
    expect(
      await toastText("Renamed “Receipts” to “Bills”"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await treeItem("Bills")).toBeInTheDocument();

    await user.keyboard("z");
    expect(await treeItem("Receipts")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /^Bills/ })).toBeNull();
  });

  it("shows what the provider refuses inline", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await rightClick(user, "Receipts");
    await user.click(
      within(await menu("Receipts")).getByRole("menuitem", { name: "Rename…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Edit label “Receipts”",
    });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.keyboard("personal{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "There’s already a label called “personal”.",
    );
    // The optimistic rename was rolled back.
    expect(await treeItem("Receipts")).toBeInTheDocument();
  });

  it("changes the colour and moves a label under another", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await rightClick(user, "Receipts");
    await user.click(
      within(await menu("Receipts")).getByRole("menuitem", { name: "Colour…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Edit label “Receipts”",
    });
    // Receipts is orange: that swatch has focus.
    expect(
      within(dialog).getByRole("radio", { name: "light orange" }),
    ).toHaveFocus();
    await user.click(within(dialog).getByRole("radio", { name: "dark blue" }));
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Inside" }),
      "Personal",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await toastText("Saved label “Receipts”")).toBeInTheDocument();
    const receipts = await treeItem("Receipts");
    expect(receipts).toHaveAttribute("aria-level", "3");
    expect(receipts.querySelector("svg")).toHaveStyle({ color: "#285bac" });
  });

  it("hides a label, and Manage labels shows it again", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await rightClick(user, "Personal");
    await user.click(
      within(await menu("Personal")).getByRole("menuitem", {
        name: "Hide from folder list",
      }),
    );
    expect(
      await toastText("Hid “Personal” from the folder list"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /^Personal/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Manage labels" }));
    const manage = await screen.findByRole("dialog", { name: /Manage labels/ });
    const rows = within(manage).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Archive 2019hidden"),
        expect.stringContaining("Personalhidden"),
      ]),
    );
    await user.click(
      within(manage).getByRole("button", { name: "Show Personal" }),
    );
    await user.keyboard("{Escape}");
    expect(await treeItem("Personal")).toBeInTheDocument();
  });

  it("creates a label with New label; z takes it back", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "New label" }));
    const dialog = await screen.findByRole("dialog", { name: "New label" });
    await user.keyboard("Travel");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Inside" }),
      "Personal",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await toastText("Created label “Travel”")).toBeInTheDocument();
    expect(await treeItem("Travel")).toHaveAttribute("aria-level", "3");
    await user.keyboard("z");
    await waitFor(() => {
      expect(screen.queryByRole("treeitem", { name: /^Travel/ })).toBeNull();
    });
  });
});

describe("deleting labels", () => {
  it("asks first, then deletes and leaves the deleted label", async () => {
    const { user, services } = renderApp({
      hash: demoHash("receipts", "invoice"),
    });
    await subject("Your invoice 2026-1043");
    await rightClick(user, "Receipts");
    await user.click(
      within(await menu("Receipts")).getByRole("menuitem", { name: "Delete…" }),
    );
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete label “Receipts”?",
    });
    expect(confirm).toHaveTextContent(
      "Messages keep their other labels. This can’t be undone.",
    );
    expect(
      within(confirm).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    await user.click(
      within(confirm).getByRole("button", { name: "Delete label" }),
    );
    expect(await toastText("Deleted label “Receipts”")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /^Receipts/ })).toBeNull();
    // The Inbox (which opens its newest message).
    expect(window.location.hash.startsWith(demoHash("inbox"))).toBe(true);
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    const invoice = await provider.getMessage(
      "invoice" as Parameters<FakeMailProvider["getMessage"]>[0],
    );
    expect(invoice.mailboxIds).toEqual(["inbox"]);
  });

  it("puts the label back if the provider refuses", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    provider.failWrites = true;
    await rightClick(user, "Receipts");
    await user.click(
      within(await menu("Receipts")).getByRole("menuitem", { name: "Delete…" }),
    );
    await user.click(
      within(
        await screen.findByRole("alertdialog", {
          name: "Delete label “Receipts”?",
        }),
      ).getByRole("button", { name: "Delete label" }),
    );
    expect(
      await toastText(/Couldn’t delete “Receipts”: The demo server refused/),
    ).toBeInTheDocument();
    expect(await treeItem("Receipts")).toBeInTheDocument();
  });
});
