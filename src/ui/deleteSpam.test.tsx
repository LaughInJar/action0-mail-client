import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { demoHash, renderApp } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const option = (name: RegExp) => screen.findByRole("option", { name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const toastRegion = () =>
  document.querySelector<HTMLElement>("div[aria-live]")!;

describe("trash", () => {
  it("moves to Trash with Delete, opens the next message, and undoes with z", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("{Delete}");
    expect(await toastText("Moved 1 message to Trash")).toBeInTheDocument();
    expect(await subject("This week in web development")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Welcome to the demo/ }),
    ).not.toBeInTheDocument();

    await user.keyboard("z");
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
  });

  it("hides trashed messages from label views too", async () => {
    const { user } = renderApp({ hash: demoHash("personal", "plain-text") });
    await subject("Packing list for the weekend");
    await user.keyboard("{Backspace}");
    expect(await toastText("Moved 1 message to Trash")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /Packing list/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("restores with Delete inside Trash", async () => {
    const { user } = renderApp({ hash: demoHash("trash", "trash-1") });
    await subject("Cancelled: Standup");
    expect(screen.getByRole("note")).toHaveTextContent(
      "deleted automatically after 30 days",
    );
    await user.keyboard("{Delete}");
    expect(await toastText("Restored 1 message")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /Cancelled: Standup/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("accepts drops on Trash", async () => {
    renderApp();
    await subject("Welcome to the demo");
    const data = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(await option(/Packing list/), { dataTransfer: data });
    const target = screen.getByRole("treeitem", { name: /^Trash/ });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: data },
      ctrlKey: { value: true },
      altKey: { value: false },
    });
    fireEvent(target, drop);
    // Even with Ctrl held: Trash isn't a label, so it moves.
    expect(await toastText("Moved 1 message to Trash")).toBeInTheDocument();
  });
});

describe("spam", () => {
  it("reports spam with Shift+S and marks it not spam inside Spam", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("{Shift>}s{/Shift}");
    expect(await toastText("Reported 1 message as spam")).toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: /^Spam/ }));
    await user.click(await option(/Welcome to the demo/));
    await user.keyboard("{Shift>}s{/Shift}");
    expect(
      await toastText("Not spam: moved 1 message to the Inbox"),
    ).toBeInTheDocument();
  });
});

describe("delete forever", () => {
  it("asks first, with Cancel as the default, and can't be undone", async () => {
    const { user } = renderApp({ hash: demoHash("trash", "trash-1") });
    await subject("Cancelled: Standup");

    await user.keyboard("{Shift>}{Delete}{/Shift}");
    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete 1 message forever?",
    });
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    // Enter activates the focused Cancel button.
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Cancelled: Standup/ }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Delete forever (Shift+Delete)" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Delete forever" }),
    );
    expect(await toastText("Deleted 1 message forever")).toBeInTheDocument();
    expect(
      within(toastRegion()).queryByRole("button", { name: /Undo/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /Cancelled: Standup/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("isn't available outside Trash and Spam", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("{Shift>}{Delete}{/Shift}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Delete forever/ }),
    ).not.toBeInTheDocument();
  });

  it("blocks other shortcuts while the confirmation is open", async () => {
    const { user } = renderApp({ hash: demoHash("trash", "trash-1") });
    await subject("Cancelled: Standup");
    await user.keyboard("{Shift>}{Delete}{/Shift}");
    await screen.findByRole("alertdialog");
    await user.keyboard("{Delete}z");
    expect(
      screen.queryByText(/Restored/, { selector: "div[aria-live] span" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("empties Trash after confirmation", async () => {
    const { user } = renderApp({ hash: demoHash("trash") });
    await option(/Cancelled: Standup/);
    await user.click(screen.getByRole("button", { name: "Empty Trash" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Empty Trash?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Empty Trash" }),
    );
    expect(await toastText("Emptied Trash (1 message)")).toBeInTheDocument();
    expect(await screen.findByText("No messages here.")).toBeInTheDocument();
  });
});
