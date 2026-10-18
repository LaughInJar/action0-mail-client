import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ACCOUNTS_KEY } from "../accounts/accountStorage";
import { demoHash, renderApp } from "../test/renderApp";
import { mailContentSecurityPolicy } from "../security/mailDocument";
import { MAIL_FRAME_SANDBOX } from "./reader/SafeHtmlFrame";

const option = (name: RegExp | string) => screen.findByRole("option", { name });
const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const mailFrame = () => screen.findByTitle(/^Message: /);

describe("welcome", () => {
  it("offers the demo without an account and connects it with one click", async () => {
    const { user } = renderApp({ signedIn: false });
    expect(
      screen.getByText(/Google sign-in isn’t configured/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try the demo" }));
    expect(await subject("Welcome to the demo")).toBeInTheDocument();
  });
});

describe("three-column view", () => {
  it("opens the inbox and shows the newest message without a click", async () => {
    renderApp();
    expect(await subject("Welcome to the demo")).toBeInTheDocument();
    expect(window.location.hash).toBe(demoHash("inbox", "welcome"));
    expect(
      screen.getByRole("heading", { level: 2, name: "Inbox" }),
    ).toBeInTheDocument();
  });

  it("shows system mailboxes first, nests labels and hides hidden ones", async () => {
    const { user } = renderApp();
    const tree = await screen.findByRole("tree");
    await within(tree).findByRole("treeitem", { name: /Inbox/ });
    const names = within(tree)
      .getAllByRole("treeitem")
      .map((item) =>
        item.textContent.replace(/\d+|,| unread| drafts/g, "").trim(),
      );
    expect(names).toEqual([
      "demo@example.com",
      "Inbox",
      "Starred",
      "Sent",
      "Drafts",
      "All Mail",
      "Spam",
      "Trash",
      "Categories",
      "Personal",
      "Receipts",
      "Work",
      "Clients",
      "Internal",
    ]);
    // Categories start collapsed; the chevron expands them.
    await user.click(
      within(tree).getByRole("treeitem", { name: "Categories" }),
    );
    expect(
      within(tree).getByRole("treeitem", { name: /Social/ }),
    ).toBeInTheDocument();
  });

  it("opens a mailbox from the tree", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("treeitem", { name: /Receipts/ }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Receipts" }),
    ).toBeInTheDocument();
    expect(await option(/Your invoice 2026-1043/)).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Receipts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The newest message of the new mailbox opens right away.
    const [newest] = screen.getAllByRole("option");
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(newest?.textContent).toContain(heading.textContent);
  });

  it("moves through messages with j and k", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("j");
    expect(await subject("This week in web development")).toBeInTheDocument();
    expect(window.location.hash).toBe(demoHash("inbox", "newsletter"));
    await user.keyboard("k");
    expect(await subject("Welcome to the demo")).toBeInTheDocument();
  });

  it("jumps to mailboxes with g-sequences and shows recipients in Sent", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("gs");
    expect(
      await screen.findByRole("heading", { level: 2, name: "Sent" }),
    ).toBeInTheDocument();
    expect(await option(/To: Lukas Hofer/)).toBeInTheDocument();
  });

  it("restores the message from the URL", async () => {
    renderApp({ hash: demoHash("inbox", "invoice") });
    expect(await subject("Your invoice 2026-1043")).toBeInTheDocument();
    const attachments = screen.getByRole("region", { name: "Attachments" });
    expect(
      within(attachments).getByText("invoice-2026-1043.pdf"),
    ).toBeInTheDocument();
  });
});

describe("multi-select", () => {
  it("selects with x and Shift+j and clears with Escape", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("x");
    await user.keyboard("{Shift>}jj{/Shift}");
    expect(await screen.findByText("3 messages selected")).toBeInTheDocument();
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // The cursor stays where the selection ended.
    expect(await subject("New logo draft")).toBeInTheDocument();
  });

  it("toggles with Ctrl-click and selects ranges with Shift-click", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("{Control>}");
    await user.click(await option(/New logo draft/));
    await user.keyboard("{/Control}");
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    await user.keyboard("{Shift>}");
    await user.click(await option(/Packing list/));
    await user.keyboard("{/Shift}");
    expect(await screen.findByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });
});

describe("safe mail rendering", () => {
  it("renders HTML mail in a script-less sandbox with remote content blocked until allowed", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "newsletter") });
    await subject("This week in web development");
    const frame = await mailFrame();
    expect(frame).toHaveAttribute("sandbox", MAIL_FRAME_SANDBOX);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain(
      `content="${mailContentSecurityPolicy(false)}"`,
    );
    expect(frame.getAttribute("srcdoc")).not.toContain("<script");

    await user.click(screen.getByRole("button", { name: "Load images" }));
    await waitFor(() => {
      expect(frame.getAttribute("srcdoc")).toContain(
        "img-src data: https: http:",
      );
    });
    expect(
      screen.queryByRole("button", { name: "Load images" }),
    ).not.toBeInTheDocument();
  });

  it("embeds inline images as data URLs", async () => {
    renderApp({ hash: demoHash("inbox", "inline-image") });
    const frame = await mailFrame();
    await waitFor(() => {
      expect(frame.getAttribute("srcdoc")).toContain(
        "data:image/svg+xml;base64,",
      );
    });
    expect(
      screen.queryByRole("region", { name: "Attachments" }),
    ).not.toBeInTheDocument();
  });

  it("renders plain text without an iframe", async () => {
    renderApp({ hash: demoHash("inbox", "plain-text") });
    expect(
      await screen.findByText(/Plain text mail, rendered without an iframe/, {
        selector: "div",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/^Message: /)).not.toBeInTheDocument();
  });
});

describe("keyboard help", () => {
  it("opens with ? and closes with Escape", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("?");
    const dialog = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    expect(within(dialog).getByText("Next message")).toBeInTheDocument();
    expect(within(dialog).getByText("g then i")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).not.toBeInTheDocument();
  });
});

describe("phone layout", () => {
  it("shows one pane at a time and Back returns to the list", async () => {
    const { user } = renderApp({ viewport: "narrow" });
    await option(/Welcome to the demo/);
    // The newest message is focused but not opened on phones.
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();

    await user.click(await option(/New logo draft/));
    expect(await subject("New logo draft")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to messages" }));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("reaches the folders from the list", async () => {
    const { user } = renderApp({ viewport: "narrow" });
    await option(/Welcome to the demo/);
    await user.click(screen.getByRole("button", { name: "Show folders" }));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /Drafts/ }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Drafts" }),
    ).toBeInTheDocument();
  });

  it("starts selection mode with a long press, then taps toggle", async () => {
    renderApp({ viewport: "narrow" });
    const first = await option(/Welcome to the demo/);
    const second = await option(/New logo draft/);

    fireEvent.pointerDown(first, {
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    fireEvent.pointerUp(first, { pointerType: "touch" });
    fireEvent.click(first);
    expect(await screen.findByText("1 selected")).toBeInTheDocument();

    fireEvent.pointerDown(second, { pointerType: "touch" });
    fireEvent.pointerUp(second, { pointerType: "touch" });
    fireEvent.click(second);
    expect(await screen.findByText("2 selected")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
});

describe("tablet layout", () => {
  it("shows list and reader, with the folders in a drawer", async () => {
    const { user } = renderApp({ viewport: "medium" });
    expect(await subject("Welcome to the demo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show folders" }));
    const drawer = await screen.findByRole("dialog", { name: "Folders" });
    await user.click(
      within(drawer).getByRole("treeitem", { name: /Personal/ }),
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "Personal" }),
    ).toBeInTheDocument();
    expect(drawer.closest("[inert]")).not.toBeNull();
  });
});

describe("accounts", () => {
  it("signs out and returns to the welcome screen", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByText("Accounts"));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("button", { name: "Try the demo" }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(ACCOUNTS_KEY)).toBe("[]");
  });

  it("keeps mail out of localStorage", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("jj");
    await subject("New logo draft");
    const stored = Object.keys(window.localStorage)
      .map((key) => `${key}=${window.localStorage.getItem(key) ?? ""}`)
      .join("\n");
    expect(stored).not.toMatch(/Welcome to the demo|logo draft|Anna/);
  });
});
