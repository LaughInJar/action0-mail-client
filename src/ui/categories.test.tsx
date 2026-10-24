import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createWorkDemoData, WORK_MAILBOX } from "../providers/fake/demoWork";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });
const option = (name: RegExp) => screen.findByRole("option", { name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const treeItem = (name: RegExp) => screen.findByRole("treeitem", { name });

/** An Outlook-like account with categories, its Inbox open on the planning reply. */
async function start(hash = demoHash(WORK_MAILBOX.inbox, "w-plan-3")) {
  const rendered = renderApp({
    data: () => createWorkDemoData(TEST_NOW),
    hash,
  });
  await subject("Re: Planning for next quarter");
  return rendered;
}

/** Opens the Categories group of the folder list. */
async function openCategories(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await treeItem(/^Categories/));
}

/** A stand-in for DataTransfer, which jsdom doesn't implement. */
function dataTransfer() {
  return {
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: "",
    dropEffect: "",
  };
}

function drag(type: "dragover" | "drop", element: Element, data: object) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: data },
    ctrlKey: { value: false },
    altKey: { value: false },
  });
  fireEvent(element, event);
}

describe("Outlook categories", () => {
  it("shows them in their group and as chips, and lists a category's mail", async () => {
    const { user } = await start();
    const chips = screen.getByRole("list", { name: "Labels" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["Important client", "Team"]);

    await openCategories(user);
    await user.click(await treeItem(/^Team/));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Team" }),
    ).toBeInTheDocument();
    // From every folder: the original sits in the Inbox, others elsewhere.
    expect(
      await option(/^Mira Hofer.*Planning for next quarter/),
    ).toBeInTheDocument();
    expect(window.location.hash).toContain(WORK_MAILBOX.team);
  });

  it("applies them with l when the picker closes, and z takes them off", async () => {
    const { user } = await start();
    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: /Categories/ });
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Follow up", "Important client", "Team"]);
    await user.click(within(dialog).getByRole("option", { name: /Follow up/ }));
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(
      await toastText("Added category Follow up to 1 message"),
    ).toBeInTheDocument();
    const chips = () =>
      within(screen.getByRole("list", { name: "Labels" }))
        .getAllByRole("listitem")
        .map((chip) => chip.textContent);
    await waitFor(() => {
      expect(chips()).toContain("Follow up");
    });

    await user.keyboard("z");
    await waitFor(() => {
      expect(chips()).not.toContain("Follow up");
    });
    // The message stays where it was.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Re: Planning for next quarter",
    );
  });

  it("creates a category from the picker", async () => {
    const { user, services } = await start();
    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: /Categories/ });
    await user.keyboard("Urgent");
    expect(
      within(dialog).getByRole("option", {
        name: "Create category “Urgent”",
      }),
    ).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    const created = await within(dialog).findByRole("option", {
      name: "Urgent",
    });
    expect(created).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Enter}");
    expect(
      await toastText("Added category Urgent to 1 message"),
    ).toBeInTheDocument();
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    const mailboxes = await provider.listMailboxes();
    expect(mailboxes.find((m) => m.name === "Urgent")).toMatchObject({
      kind: "label",
      parentId: WORK_MAILBOX.categories,
    });
  });

  it("moves only between folders: v offers no categories", async () => {
    const { user } = await start();
    await user.keyboard("v");
    const dialog = await screen.findByRole("dialog", { name: /Move to/ });
    const names = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(["Projects", "Archive"]));
    expect(names).not.toContain("Team");
    expect(names).not.toContain("Follow up");
  });

  it("adds a category dropped on, and the message stays in its folder", async () => {
    const { user } = await start();
    await openCategories(user);
    const row = await option(/Re: Planning for next quarter/);
    const data = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });
    const target = await treeItem(/^Follow up/);
    drag("dragover", target, data);
    expect(within(target).getByText("Add category")).toBeInTheDocument();
    drag("drop", target, data);
    expect(
      await toastText("Added category Follow up to 1 message"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Re: Planning for next quarter/ }),
    ).toBeInTheDocument();
  });

  it("changes a category's colour (undoable), can't rename it, and asks before deleting", async () => {
    const { user } = await start();
    await openCategories(user);
    await user.pointer({
      keys: "[MouseRight]",
      target: await treeItem(/^Team/),
    });
    const menu = await screen.findByRole("menu", { name: "Category Team" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Colour…", "Delete…"]);
    expect(menu).toHaveTextContent("Outlook can’t rename categories.");

    await user.click(within(menu).getByRole("menuitem", { name: "Colour…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Category “Team”",
    });
    expect(
      within(dialog).getByRole("textbox", { name: "Name" }),
    ).toHaveAttribute("readonly");
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    const swatches = within(dialog).getAllByRole("radio");
    // No colour, then Outlook's 25.
    expect(swatches).toHaveLength(26);
    const [, red] = swatches;
    if (!red) throw new Error("no swatch");
    await user.click(red);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await toastText("Changed the colour of “Team”")).toBeInTheDocument();
    await user.keyboard("z");

    await user.pointer({
      keys: "[MouseRight]",
      target: await treeItem(/^Team/),
    });
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Delete…",
      }),
    );
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete category “Team”?",
    });
    expect(confirm).toHaveTextContent(/keeps the name in Outlook/);
    await user.click(
      within(confirm).getByRole("button", { name: "Delete category" }),
    );
    expect(await toastText("Deleted category “Team”")).toBeInTheDocument();
  });

  it("manages folders and categories in one list, each with its own New button", async () => {
    const { user } = await start();
    await user.click(screen.getByRole("button", { name: /Manage folders/ }));
    const dialog = await screen.findByRole("dialog", {
      name: /Manage folders/,
    });
    const categories = within(dialog).getByRole("region", {
      name: "Categories",
    });
    expect(
      within(categories)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Follow up"),
      expect.stringContaining("Important client"),
      expect.stringContaining("Team"),
    ]);
    await user.click(
      within(categories).getByRole("button", { name: "New category" }),
    );
    const create = await screen.findByRole("dialog", { name: "New category" });
    expect(within(create).queryByRole("combobox")).not.toBeInTheDocument();
    await user.type(
      within(create).getByRole("textbox", { name: "Name" }),
      "Later",
    );
    await user.click(within(create).getByRole("button", { name: "Create" }));
    expect(await toastText("Created category “Later”")).toBeInTheDocument();
  });

  it("tags every message of a conversation in conversation view", async () => {
    const { user, services } = await start();
    services.uiStore.getState().updateSettings({ conversations: true });
    await subject(/^Planning for next quarter/);
    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: /Categories/ });
    await user.click(within(dialog).getByRole("option", { name: /Follow up/ }));
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(
      await toastText("Added category Follow up to 1 conversation"),
    ).toBeInTheDocument();
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    await waitFor(async () => {
      const { items } = await provider.listMessages({
        mailboxId: WORK_MAILBOX.followUp,
        limit: 50,
      });
      // Both received messages and your sent reply.
      expect(
        items
          .filter((m) => m.subject.includes("Planning for next quarter"))
          .map((m) => m.id)
          .sort(),
      ).toEqual(["w-plan-1", "w-plan-2", "w-plan-3"]);
    });
  });
});
