import { act, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { demoHash, renderApp } from "../test/renderApp";

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const composer = (name: string | RegExp) =>
  screen.findByRole("dialog", { name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const field = (name: string) => screen.getByRole("combobox", { name });
const suggestion = async (name: RegExp) =>
  within(
    await screen.findByRole("listbox", { name: "Suggestions" }),
  ).findByRole("option", { name });
const SAVE_WAIT = { timeout: 4000 };

/** Waits until the Drafts folder shows `count` drafts. */
async function draftCount(count: number): Promise<HTMLElement> {
  let item: HTMLElement | undefined;
  await waitFor(() => {
    item = screen
      .getAllByRole("treeitem")
      .find((element) => element.textContent.startsWith("Drafts"));
    expect(item?.textContent).toMatch(
      new RegExp(`^Drafts, ${String(count)} drafts?$`),
    );
  }, SAVE_WAIT);
  if (!item) throw new Error("No Drafts folder");
  return item;
}

// Drafts save 2 s after the last edit; these tests wait for that.
vi.setConfig({ testTimeout: 15_000 });

/** The Tiptap editor of the message text (ProseMirror can't be typed into in jsdom). */
function writeBody(text: string) {
  // Tiptap keeps its editor on the element.
  const element = document.getElementById("composer-body");
  const editor =
    element && "editor" in element ? (element.editor as Editor) : undefined;
  act(() => {
    editor?.commands.insertContent(text);
  });
}

describe("writing a new mail", () => {
  it("suggests recipients, saves a draft, and sends after the undo period", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const dialog = await composer("New message");
    expect(field("To")).toHaveFocus();

    await user.keyboard("ann");
    await user.click(await suggestion(/Anna Berger/));
    await user.type(field("To"), "demo@example.com,");
    expect(
      within(dialog).getByRole("button", { name: "Remove Anna Berger" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Remove demo@example.com" }),
    ).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Hello");
    writeBody("Hi there");
    expect(
      await within(dialog).findByText("Saved", {}, SAVE_WAIT),
    ).toBeVisible();
    await draftCount(2);

    // Send, take it back with z, send again and skip the wait.
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Sending “Hello” in 30 s/)).toBeInTheDocument();
    await user.keyboard("z");
    expect(await composer("Hello")).toBeInTheDocument();
    expect(screen.queryByText(/Sending “Hello”/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Send/ }));
    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(await toastText("Message sent")).toBeInTheDocument();

    // Sent to Anna and to myself: it's in Sent and in the Inbox.
    expect(
      await screen.findByRole("option", { name: /Hello — Hi there/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /^Sent/ }));
    expect(
      await screen.findByRole("option", { name: /Hello — Hi there/ }),
    ).toBeInTheDocument();
    await draftCount(1);
  });

  it("checks the recipients and asks before sending without a subject", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const dialog = await composer("New message");

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Add at least one recipient.",
    );
    await user.type(field("To"), "nobody{Tab}");
    await user.click(field("To"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "“nobody” isn’t a valid address.",
    );

    await user.click(
      within(dialog).getByRole("button", { name: "Remove nobody" }),
    );
    await user.type(field("To"), "anna@example.org{Enter}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    const question = within(dialog).getByRole("alertdialog", {
      name: "Send without a subject?",
    });
    expect(
      within(question).getByRole("button", { name: "Send anyway" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText(/Sending “\(no subject\)” in 30 s/),
    ).toBeInTheDocument();
  });

  it("discards a draft, and z brings it back", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    await composer("New message");
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Oops");
    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(await toastText("Draft discarded")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("z");
    expect(await composer("Oops")).toBeInTheDocument();
  });

  it("falls back to recent mail when contacts are unavailable, and says why", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const provider = services.registry.list()[0]?.provider as FakeMailProvider;
    provider.contactsUnavailable = true;
    await user.keyboard("c");
    await composer("New message");
    await user.keyboard("sophie");
    expect(await suggestion(/Sophie Wagner/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Demo contacts are switched off. Suggestions come from your recent mail.",
      ),
    ).toBeInTheDocument();
  });
});

describe("replies and forwards", () => {
  it("replies with the quote, keeps the draft on Esc and reopens it from Drafts", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("r");
    const dialog = await composer("Re: Welcome to the demo");
    expect(
      within(dialog).getByRole("button", { name: "Remove action0" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Quoted text")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.getElementById("composer-body")).toHaveFocus();
    });
    writeBody("Thanks!");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(await draftCount(2));
    await user.click(
      await screen.findByRole("option", { name: /Re: Welcome to the demo/ }),
    );
    const reopened = await composer("Re: Welcome to the demo");
    expect(within(reopened).getByText("Quoted text")).toBeInTheDocument();
    expect(document.getElementById("composer-body")).toHaveTextContent(
      /^Thanks!$/,
    );
  });

  it("replies to everyone, and forwards with the original's files", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "wide") });
    await subject("Client project overview");
    await user.keyboard("{Shift>}R{/Shift}");
    const replyAll = await composer("Re: Client project overview");
    expect(
      within(replyAll).getByRole("button", { name: "Remove Mia Steiner" }),
    ).toBeInTheDocument();
    expect(field("Cc")).toBeInTheDocument();
    expect(
      within(replyAll).getByRole("button", { name: "Remove Jonas Gruber" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(
      await screen.findByRole("option", { name: /Your invoice 2026-1043/ }),
    );
    await subject("Your invoice 2026-1043");
    await user.click(screen.getByRole("button", { name: "Forward (f)" }));
    const forward = await composer("Fwd: Your invoice 2026-1043");
    expect(
      within(
        within(forward).getByRole("list", { name: "Attachments" }),
      ).getByText("invoice-2026-1043.pdf"),
    ).toBeInTheDocument();
    expect(field("To")).toHaveFocus();
  });
});

describe("composer on phones", () => {
  it("opens full screen in the URL, and Back closes it", async () => {
    const { user, services } = renderApp({ viewport: "narrow" });
    await screen.findByRole("option", { name: /Welcome to the demo/ });
    await user.click(screen.getByRole("button", { name: "Compose" }));
    const dialog = await composer("New message");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => {
      expect(window.location.hash).toContain("compose=new");
    });
    act(() => {
      services.router.back();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.hash).not.toContain("compose");
  });
});
