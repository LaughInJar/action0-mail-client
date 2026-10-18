import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { renderApp } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const option = (name: RegExp) => screen.findByRole("option", { name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const treeItem = (name: RegExp) => screen.getByRole("treeitem", { name });

/** A stand-in for DataTransfer, which jsdom doesn't implement. */
function dataTransfer() {
  return {
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: "",
    dropEffect: "",
  };
}

/** Fires a drag event with modifier keys (jsdom has no DragEvent constructor). */
function drag(
  type: "dragover" | "drop",
  element: Element,
  data: object,
  ctrlKey = false,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: data },
    ctrlKey: { value: ctrlKey },
    altKey: { value: false },
  });
  fireEvent(element, event);
}

describe("move picker", () => {
  it("moves with v, filter and Enter, and undoes with z", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("v");
    const dialog = await screen.findByRole("dialog", { name: /Move to/ });
    // The current mailbox and views aren't offered; Spam and Trash are.
    const names = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).not.toContain("Inbox");
    expect(names).not.toContain("All Mail");
    expect(names).toEqual(
      expect.arrayContaining(["Spam", "Trash", "Work / Clients"]),
    );

    await user.keyboard("rec{Enter}");
    expect(await toastText("Moved 1 message to Receipts")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Welcome to the demo/ }),
    ).not.toBeInTheDocument();
    expect(await subject("This week in web development")).toBeInTheDocument();

    await user.keyboard("z");
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
  });
});

describe("errors from closed dialogs", () => {
  it("still reports a failed move after the picker has closed", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    provider.failWrites = true;
    await user.keyboard("v");
    await screen.findByRole("dialog", { name: /Move to/ });
    await user.keyboard("rec{Enter}");
    expect(
      await toastText(/Couldn’t move: The demo server refused/),
    ).toBeInTheDocument();
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
  });
});

describe("label picker", () => {
  it("shows mixed state for a mixed selection and applies all changes as one action", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    // Welcome (Inbox only) and "New logo draft" (Inbox + Work).
    await user.keyboard("xjjx");
    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: /Labels/ });
    const work = within(dialog).getByRole("option", { name: "Work" });
    expect(work).toHaveAttribute("aria-checked", "mixed");

    await user.click(work);
    expect(work).toHaveAttribute("aria-checked", "true");
    await user.click(within(dialog).getByRole("option", { name: "Personal" }));
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await toastText("Changed labels of 2 messages")).toBeInTheDocument();
    // Rows stay: adding labels doesn't take messages out of the Inbox.
    expect(
      screen.getByRole("option", { name: /Welcome to the demo/ }),
    ).toBeInTheDocument();
  });

  it("adds a label by typing its name and pressing Enter", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("l");
    await screen.findByRole("dialog", { name: /Labels/ });
    await user.keyboard("pers{Enter}");
    expect(
      await toastText("Added label Personal to 1 message"),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Labels" })).toHaveTextContent(
      "Personal",
    );
  });

  it("discards changes on Escape", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("l");
    const dialog = await screen.findByRole("dialog", { name: /Labels/ });
    await user.click(within(dialog).getByRole("option", { name: "Receipts" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/label/i, { selector: "div[aria-live] span" }),
    ).not.toBeInTheDocument();
  });
});

describe("starring", () => {
  it("toggles the star with s and with the star in the row", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    // The welcome message starts starred.
    await user.keyboard("s");
    expect(await toastText("Unstarred 1 message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Star (s)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const row = await option(/New logo draft/);
    const star = row.querySelector("[data-star]");
    expect(star).not.toBeNull();
    await user.click(star!);
    expect(await toastText("Starred 1 message")).toBeInTheDocument();
    expect(within(row).getByText(", starred")).toBeInTheDocument();
    // Clicking the star doesn't open the message.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Welcome to the demo",
    );
  });
});

describe("drag and drop", () => {
  it("moves a message by dropping it on a label", async () => {
    renderApp();
    await subject("Welcome to the demo");
    const row = await option(/Packing list/);
    const data = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });
    expect(data.setData).toHaveBeenCalled();

    const target = treeItem(/^Receipts/);
    drag("dragover", target, data);
    expect(within(target).getByText("Move here")).toBeInTheDocument();
    drag("drop", target, data);

    expect(await toastText("Moved 1 message to Receipts")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /Packing list/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("only adds the label when Ctrl is held", async () => {
    renderApp();
    await subject("Welcome to the demo");
    const row = await option(/Packing list/);
    const data = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });
    const target = treeItem(/^Receipts/);
    drag("dragover", target, data, true);
    expect(within(target).getByText("Add label")).toBeInTheDocument();
    drag("drop", target, data, true);

    expect(
      await toastText("Added label Receipts to 1 message"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Packing list/ }),
    ).toBeInTheDocument();
  });

  it("refuses targets that can't hold messages", async () => {
    renderApp();
    await subject("Welcome to the demo");
    const row = await option(/Packing list/);
    const data = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });
    for (const name of [/^Sent/, /^Inbox/, /^Starred/, /^All Mail/]) {
      const target = treeItem(name);
      drag("dragover", target, data);
      expect(within(target).queryByText("Move here")).not.toBeInTheDocument();
      drag("drop", target, data);
    }
    expect(
      screen.queryByText(/Moved/, { selector: "div[aria-live] span" }),
    ).not.toBeInTheDocument();
  });

  it("drags the whole selection, or just the row if it isn't selected", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("x{Shift>}j{/Shift}");
    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    const unselected = await option(/Packing list/);
    const data = dataTransfer();
    fireEvent.dragStart(unselected, { dataTransfer: data });
    drag("drop", treeItem(/^Personal/), data);
    expect(await toastText("Moved 1 message to Personal")).toBeInTheDocument();
    // The selection is untouched by moving another row.
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    const selected = await option(/Welcome to the demo/);
    fireEvent.dragStart(selected, { dataTransfer: data });
    drag("drop", treeItem(/^Receipts/), data);
    expect(await toastText("Moved 2 messages to Receipts")).toBeInTheDocument();
  });
});

describe("phone", () => {
  it("opens the move picker from the selection bar", async () => {
    const { user } = renderApp({ viewport: "narrow" });
    await option(/Welcome to the demo/);
    await user.keyboard("x");
    await user.click(
      await screen.findByRole("button", { name: "Move to… (v)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Move to/ });
    await user.click(within(dialog).getByRole("option", { name: "Work" }));
    expect(await toastText("Moved 1 message to Work")).toBeInTheDocument();
  });
});
