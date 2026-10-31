import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FakeFilterProvider } from "../providers/fake/FakeFilterProvider";
import { fakeImapBridge } from "../test/imapBridge";
import { demoHash, renderApp } from "../test/renderApp";
import { fakeSieveBridge } from "../test/sieveBridge";

vi.setConfig({ testTimeout: 15_000 });

type User = ReturnType<typeof renderApp>["user"];
type Services = ReturnType<typeof renderApp>["services"];

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const undoToast = (user: User) =>
  user.click(
    within(
      screen.getByText(/./, { selector: "div[aria-live] span" }).parentElement!,
    ).getByRole("button", { name: /Undo/ }),
  );

/** Settings → Filters. */
async function openFilters(user: User) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const settings = await dialog("Settings");
  return within(settings).getByRole("region", { name: "Filters" });
}

/** The filter rows, as their text. */
const rows = (section: HTMLElement) =>
  within(section)
    .queryAllByRole("listitem")
    .map((row) => row.textContent);

const demoFilters = (services: Services) =>
  services.registry.list()[0]?.filters as FakeFilterProvider;

describe("filters in Settings", () => {
  it("lists the account's filters and creates one, undoably", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const section = await openFilters(user);
    await waitFor(() => {
      expect(rows(section)).toEqual([
        "From billing@shop.example → : skip the Inbox, label Receipts",
        "From news@hiking-club.example or digest@news.example → : mark as read, and more",
      ]);
    });

    await user.click(
      within(section).getByRole("button", { name: "New filter" }),
    );
    const editor = await dialog("New filter");
    // Gmail's words: no names, labels, Skip the Inbox.
    expect(within(editor).queryByLabelText("Name")).not.toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Add at least one condition.",
    );
    await user.type(
      within(editor).getByLabelText("Subject"),
      "Weekly report, status",
    );
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Choose what the filter does.",
    );
    await user.selectOptions(
      within(editor).getByRole("combobox", { name: "Add a label…" }),
      "Work",
    );
    await user.click(within(editor).getByLabelText("Mark as read"));
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText("Filter created");
    expect(screen.queryByRole("dialog", { name: "New filter" })).toBeNull();
    await waitFor(() => {
      expect(rows(section)).toContain(
        "Subject “Weekly report” or “status” → : label Work, mark as read",
      );
    });

    await undoToast(user);
    await waitFor(() => {
      expect(rows(section)).toHaveLength(2);
    });
  });

  it("deletes undoably, but asks for filters with settings it doesn't show", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const section = await openFilters(user);
    const first = (await within(section).findAllByRole("listitem"))[0];
    if (!first) throw new Error("no filter");
    await user.click(within(first).getByRole("button", { name: "Delete" }));
    await toastText("Filter deleted");
    await waitFor(() => {
      expect(rows(section)).toHaveLength(1);
    });
    await undoToast(user);
    await waitFor(() => {
      expect(rows(section)).toHaveLength(2);
    });

    const hiking = within(section)
      .getAllByRole("listitem")
      .find((row) => row.textContent.includes("hiking"));
    if (!hiking) throw new Error("no hiking filter");
    await user.click(within(hiking).getByRole("button", { name: "Delete" }));
    const question = await screen.findByRole("alertdialog", {
      name: "Delete this filter?",
    });
    await user.click(within(question).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(rows(section).join()).not.toContain("hiking");
    });
  });

  it("asks before Back or Escape throw changes away", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const section = await openFilters(user);
    await user.click(
      await within(section).findByRole("button", { name: "New filter" }),
    );
    const editor = await dialog("New filter");
    expect(window.location.hash).toContain("settings=filter");
    await user.type(within(editor).getByLabelText("From"), "boss@example.com");

    act(() => {
      window.history.back();
    });
    const question = await screen.findByRole("alertdialog", {
      name: "Discard changes?",
    });
    await user.click(
      within(question).getByRole("button", { name: "Keep editing" }),
    );
    expect(
      within(await dialog("New filter")).getByLabelText("From"),
    ).toHaveValue("boss@example.com");

    await user.keyboard("{Escape}");
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Discard changes?" }),
      ).getByRole("button", { name: "Discard" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New filter" })).toBeNull();
    });
    // Settings stays open.
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).not.toContain("settings=filter");
    });
  });

  it("are read-only without Gmail's settings permission", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    demoFilters(services).readOnly = true;
    const section = await openFilters(user);
    expect(
      await within(section).findByText(/Gmail settings can only be read/),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Allow editing" }),
    ).toBeInTheDocument();
    expect(
      within(section).queryByRole("button", { name: "New filter" }),
    ).toBeNull();
    expect(
      within(section).queryByRole("button", { name: "Delete" }),
    ).toBeNull();
  });

  it("switches and reorders Outlook rules, undoably", async () => {
    const { user } = renderApp({ workAccount: true });
    await subject("Welcome to the demo");
    const section = await openFilters(user);
    await user.selectOptions(
      within(section).getByRole("combobox", { name: "Account" }),
      "demo@work.example",
    );
    await waitFor(() => {
      expect(
        rows(section).map((row) => row.split(/From|To|Subject/)[0]),
      ).toEqual(["Website notifications", "Team mail"]);
    });

    await user.click(
      within(section).getByRole("switch", { name: /^On: Team mail/ }),
    );
    await toastText("Filter switched on");
    expect(
      within(section).getByRole("switch", { name: /^On: Team mail/ }),
    ).toBeChecked();

    const website = within(section).getAllByRole("listitem")[0];
    if (!website) throw new Error("no rule");
    await user.click(
      within(website).getByRole("button", { name: "Move down" }),
    );
    await toastText("Filter moved");
    await waitFor(() => {
      expect(rows(section)[0]).toMatch(/^Team mail/);
    });
    await undoToast(user);
    await waitFor(() => {
      expect(rows(section)[0]).toMatch(/^Website notifications/);
    });

    // Rules have names and folders.
    await user.click(
      within(section).getAllByRole("button", {
        name: "Edit",
      })[1]!,
    );
    const editor = await dialog("Edit rule");
    expect(within(editor).getByLabelText("Name")).toHaveValue("Team mail");
    expect(within(editor).getByLabelText("Move to folder")).toBeInTheDocument();
    expect(within(editor).queryByLabelText("Star it")).toBeNull();
  });
});

describe("Filter mail like this", () => {
  it("opens a filter for the sender and applies it to existing mail, undoably", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "invoice") });
    await subject("Your invoice 2026-1043");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      within(screen.getByRole("menu", { name: "More actions" })).getByRole(
        "menuitem",
        { name: "Filter mail like this" },
      ),
    );
    const editor = await dialog("New filter");
    expect(within(editor).getByLabelText("From")).toHaveValue(
      "billing@shop.example",
    );
    await user.click(within(editor).getByLabelText("Star it"));
    // The demo has more mail from this sender than the one open.
    const apply = await within(editor).findByLabelText(
      /^Also apply to the \d+ matching messages$/,
    );
    await user.click(apply);
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText(/^Filter created and applied to \d+ messages$/);
    // Settings shows it, the message has its star.
    const settings = await dialog("Settings");
    await user.click(
      within(settings).getByRole("button", { name: "Close settings (Esc)" }),
    );
    const invoice = () =>
      screen.getByRole("option", { name: /Your invoice 2026-1043/ });
    await waitFor(() => {
      expect(invoice()).toHaveAccessibleName(/starred/);
    });

    await undoToast(user);
    await waitFor(() => {
      expect(invoice()).not.toHaveAccessibleName(/starred/);
    });
  });
});

describe("automatic replies", () => {
  it("are switched on in Settings, noticed above the list and turned off there", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    const section = await openFilters(user);
    expect(await within(section).findByText("Off")).toBeInTheDocument();
    await user.click(
      within(section).getByRole("button", { name: "Edit: Automatic replies" }),
    );
    const editor = await dialog("Automatic replies");
    expect(
      within(editor).getByRole("switch", { name: "Send automatic replies" }),
    ).toBeChecked();
    expect(within(editor).getByLabelText("Subject")).toHaveValue(
      "Out of office",
    );
    await user.click(
      within(editor).getByLabelText("Only reply to people in my contacts"),
    );
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText("Automatic replies are on");
    expect(await within(section).findByText("On")).toBeInTheDocument();

    await user.click(
      within(await dialog("Settings")).getByRole("button", {
        name: "Close settings (Esc)",
      }),
    );
    const notice = await screen.findByText(
      "Automatic replies are on for demo@example.com.",
    );
    await user.click(
      within(notice.parentElement!).getByRole("button", {
        name: "Turn off",
      }),
    );
    await toastText("Automatic replies are off");
    await waitFor(() => {
      expect(
        screen.queryByText("Automatic replies are on for demo@example.com."),
      ).toBeNull();
    });
    await user.keyboard("z");
    expect(
      await screen.findByText("Automatic replies are on for demo@example.com."),
    ).toBeInTheDocument();
  });
});

describe("filters of a mail server (Sieve)", () => {
  /** Adds the mail server account me@home.example. */
  async function addMailServer(user: User) {
    await user.click(screen.getByText("Accounts"));
    await user.click(screen.getByRole("button", { name: "Add account" }));
    const wizard = await screen.findByRole("dialog", { name: "Add account" });
    await user.click(
      within(wizard).getByRole("button", { name: /^Other mail server/ }),
    );
    await user.type(screen.getByLabelText("Email address"), "me@home.example");
    await user.type(screen.getByLabelText("Your name"), "Me Myself");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await toastText("Connected me@home.example");
  }

  it("uses another server when none is found, and edits the script", async () => {
    const sieve = fakeSieveBridge({
      server: null,
      script: [
        'require ["fileinto"];',
        "# rule:[Lists]",
        'if header :contains "subject" "[list]"',
        "{",
        '\tfileinto "Lists";',
        "}",
        "",
      ].join("\r\n"),
    });
    const { user } = renderApp({
      imap: fakeImapBridge({
        folders: [{ name: "Lists" }, { name: "Trash", role: "trash" }],
      }).bridge,
      sieve: sieve.bridge,
    });
    await subject("Welcome to the demo");
    await addMailServer(user);
    const section = await openFilters(user);
    await user.selectOptions(
      within(section).getByRole("combobox", { name: "Account" }),
      "me@home.example",
    );
    expect(
      await within(section).findByText(/offers no filters to mail programs/),
    ).toBeInTheDocument();
    await user.clear(within(section).getByLabelText("Filter server"));
    await user.type(
      within(section).getByLabelText("Filter server"),
      "sieve.home.example",
    );
    await user.click(within(section).getByRole("button", { name: "Connect" }));
    await waitFor(() => {
      expect(rows(section)).toEqual([
        "ListsSubject “[list]” → : move to Lists",
      ]);
    });
    expect(
      within(section).getByText("Filter server: sieve.home.example"),
    ).toBeInTheDocument();

    await user.click(
      within(section).getByRole("switch", { name: /^On: Lists/ }),
    );
    await toastText("Filter switched off");
    expect(sieve.state.script).toContain("if false # ");
    expect(sieve.state.writes.at(-1)?.expected).toContain(
      'if header :contains "subject" "[list]"',
    );
  });
});
