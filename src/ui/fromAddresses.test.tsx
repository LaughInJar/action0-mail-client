import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asMessageId } from "../core/ids";
import type { Message } from "../core/model";
import { createDemoData } from "../providers/fake/demoData";
import type { FakeMailData } from "../providers/fake/FakeMailProvider";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { UI_STATE_KEY } from "../state/uiStore";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
// Settings and the composer load on first use.
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });

type Services = ReturnType<typeof renderApp>["services"];
const demoProvider = (services: Services) =>
  services.registry.list()[0]?.provider as FakeMailProvider;

/** A copy of the "Client project overview" mail, sent to `to`. */
function mailTo(data: FakeMailData, id: string, to: string): Message {
  const wide = data.messages.find((message) => message.id === "wide");
  if (!wide) throw new Error("no template");
  const { threadId, ...rest } = wide;
  return {
    ...rest,
    id: asMessageId(id),
    subject: `Mail to ${to}`,
    to: [{ address: to }],
    cc: [],
  };
}

/** The demo account, managing its addresses like an IMAP or Outlook account. */
function editableDemo(extra: Partial<FakeMailData> = {}) {
  return () => {
    const data = createDemoData(TEST_NOW);
    return {
      ...data,
      editSenders: true,
      messages: [
        ...data.messages,
        mailTo(data, "tagged", "demo+shop@example.com"),
        mailTo(data, "catchall", "info@example.com"),
      ],
      ...extra,
    };
  };
}

describe("From addresses in Settings", () => {
  it("are added, made default, edited and removed", async () => {
    const { user, services } = renderApp({ data: editableDemo() });
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    expect(
      within(settings).getByRole("heading", {
        name: "Addresses and signatures",
      }),
    ).toBeInTheDocument();
    // The account's own address can't be removed.
    await within(settings).findByRole("button", {
      name: "Edit demo@example.com",
    });
    expect(
      within(settings).queryByRole("button", {
        name: "Remove demo@example.com",
      }),
    ).not.toBeInTheDocument();

    await user.click(
      within(settings).getByRole("button", { name: "Add address" }),
    );
    const form = within(settings).getByRole("form", { name: "New address" });
    // New addresses start with the account's name.
    expect(within(form).getByLabelText("Name")).toHaveValue("Demo User");
    const address = within(form).getByLabelText("Address");
    expect(address).toHaveFocus();
    await user.type(address, "team@example.com");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "team@example.com is already in the list.",
    );
    await user.clear(address);
    await user.type(address, "shop@example.com");
    await user.type(
      within(form).getByLabelText("Reply to (optional)"),
      "desk@example.com",
    );
    await user.click(
      within(form).getByRole("checkbox", { name: /Bcc to myself/ }),
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(
      await within(settings).findByText(
        "Replies go to desk@example.com · Bcc to myself",
      ),
    ).toBeInTheDocument();
    // Focus stays in Settings, so Esc still closes it.
    expect(
      within(settings).getByRole("button", { name: "Add address" }),
    ).toHaveFocus();
    expect(
      within(settings).getByRole("textbox", {
        name: "Signature for shop@example.com",
      }),
    ).toBeInTheDocument();
    expect((await demoProvider(services).listSenders()).at(-1)).toMatchObject({
      address: "shop@example.com",
      name: "Demo User",
      replyTo: { address: "desk@example.com" },
      bccSelf: true,
    });

    await user.click(
      within(settings).getByRole("radio", {
        name: "Send from shop@example.com by default",
      }),
    );
    await waitFor(async () => {
      expect(
        (await demoProvider(services).listSenders()).find((s) => s.isDefault)
          ?.address,
      ).toBe("shop@example.com");
    });

    await user.click(
      within(settings).getByRole("button", { name: "Edit shop@example.com" }),
    );
    const edit = within(settings).getByRole("form", {
      name: "Edit shop@example.com",
    });
    expect(within(edit).getByLabelText("Address")).toBeDisabled();
    expect(within(edit).getByLabelText("Name")).toHaveFocus();
    await user.clear(within(edit).getByLabelText("Name"));
    await user.type(within(edit).getByLabelText("Name"), "Shop");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    expect(
      await within(settings).findByText("Shop <shop@example.com>"),
    ).toBeInTheDocument();

    await user.click(
      within(settings).getByRole("button", {
        name: "Remove shop@example.com",
      }),
    );
    expect(
      within(settings).getByText("Remove shop@example.com and its signature?"),
    ).toBeInTheDocument();
    // Cancel is the default.
    expect(
      within(settings).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    await user.click(within(settings).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(
        within(settings).queryByText("Shop <shop@example.com>"),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        within(settings).getByRole("button", { name: "Add address" }),
      ).toHaveFocus();
    });
  });

  it("aren't managed for accounts that list their own (Gmail)", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    await within(settings).findByRole("textbox", {
      name: "Signature for demo@example.com",
    });
    expect(
      within(settings).queryByRole("button", { name: "Add address" }),
    ).not.toBeInTheDocument();
    expect(
      within(settings).getByRole("heading", { name: "Signatures" }),
    ).toBeInTheDocument();
  });
});

describe("From addresses in the composer", () => {
  it("bring their Reply-To and Bcc copy, and take them along when changed", async () => {
    const data = createDemoData(TEST_NOW);
    const { user } = renderApp({
      data: editableDemo({
        senders: [
          ...(data.senders ?? []),
          {
            address: "shop@example.com",
            name: "Shop",
            isDefault: false,
            signature: "",
            replyTo: { address: "desk@example.com" },
            bccSelf: true,
          },
        ],
      }),
    });
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const compose = await dialog("New message");
    const from = within(compose).getByRole("combobox", { name: "From" });
    await user.selectOptions(
      from,
      await within(from).findByRole("option", {
        name: "Shop <shop@example.com>",
      }),
    );
    expect(within(compose).getByText("desk@example.com")).toBeInTheDocument();
    // The Bcc copy.
    expect(within(compose).getByTitle("shop@example.com")).toBeInTheDocument();

    await user.selectOptions(
      from,
      within(from).getByRole("option", {
        name: "Demo User <demo@example.com>",
      }),
    );
    expect(
      within(compose).queryByText("desk@example.com"),
    ).not.toBeInTheDocument();
    expect(
      within(compose).queryByTitle("shop@example.com"),
    ).not.toBeInTheDocument();

    // Reply-To can be dropped for one mail.
    await user.selectOptions(
      from,
      within(from).getByRole("option", { name: "Shop <shop@example.com>" }),
    );
    await user.click(
      within(compose).getByRole("button", {
        name: "Remove Reply to from this mail",
      }),
    );
    expect(
      within(compose).queryByText("desk@example.com"),
    ).not.toBeInTheDocument();
  });

  it("answer a +tag address from it, offering to add it", async () => {
    window.localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        state: { settings: { undoSendSeconds: 0 } },
        version: 1,
      }),
    );
    const { user, services } = renderApp({
      data: editableDemo(),
      hash: demoHash("inbox", "tagged"),
    });
    await subject("Mail to demo+shop@example.com");
    await user.keyboard("r");
    const compose = await dialog(/Mail to demo\+shop/);
    const from = within(compose).getByRole("combobox", { name: "From" });
    await waitFor(() => {
      expect(from).toHaveDisplayValue("demo+shop@example.com (not set up)");
    });
    await user.click(
      within(compose).getByRole("button", { name: "Add this address" }),
    );
    expect(
      await toastText("demo+shop@example.com is now one of your addresses."),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(from).toHaveDisplayValue("Demo User <demo+shop@example.com>");
    });
    expect(
      within(compose).queryByRole("button", { name: "Add this address" }),
    ).not.toBeInTheDocument();
    expect(
      (await demoProvider(services).listSenders()).map((s) => s.address),
    ).toContain("demo+shop@example.com");

    await user.click(within(compose).getByRole("button", { name: /^Send/ }));
    expect(await toastText("Message sent")).toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /^Sent/ }));
    await user.click(
      await screen.findByRole("option", { name: /Re: Mail to demo\+shop/ }),
    );
    expect(await screen.findByRole("article")).toHaveTextContent(
      "Demo Userdemo+shop@example.com",
    );
  });

  it("answer from an address at a catch-all domain only once it's ticked", async () => {
    const { user } = renderApp({
      data: editableDemo(),
      hash: demoHash("inbox", "catchall"),
    });
    await subject("Mail to info@example.com");
    await user.keyboard("r");
    let compose = await dialog(/Mail to info@example.com/);
    expect(
      await within(compose).findByRole("option", {
        name: "Demo User <demo@example.com>",
        selected: true,
      }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    await user.click(
      await within(settings).findByRole("checkbox", {
        name: "Every address at example.com is mine",
      }),
    );
    await waitFor(() => {
      expect(
        within(settings).getByRole("checkbox", {
          name: "Every address at example.com is mine",
        }),
      ).toBeChecked();
    });
    await user.click(
      within(settings).getByRole("button", { name: /^Close settings/ }),
    );

    await user.keyboard("r");
    compose = await dialog(/Mail to info@example.com/);
    await waitFor(() => {
      expect(
        within(compose).getByRole("combobox", { name: "From" }),
      ).toHaveDisplayValue("info@example.com (not set up)");
    });
  });

  it("lead to Settings with “Add an address…”", async () => {
    const { user } = renderApp({ data: editableDemo() });
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const compose = await dialog("New message");
    const from = within(compose).getByRole("combobox", { name: "From" });
    await user.selectOptions(
      from,
      await within(from).findByRole("option", { name: "Add an address…" }),
    );
    const settings = await dialog("Settings");
    const form = await within(settings).findByRole("form", {
      name: "New address",
    });
    expect(within(form).getByLabelText("Address")).toHaveFocus();
    // The composer stays as it was.
    expect(from).toHaveDisplayValue("Demo User <demo@example.com>");
  });
});
