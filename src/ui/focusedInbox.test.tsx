import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FAKE_FOCUSED_ID,
  FAKE_OTHER_ID,
} from "../providers/fake/FakeMailProvider";
import { WORK_MAILBOX } from "../providers/fake/demoWork";
import { DEMO_WORK_ACCOUNT } from "../providers/fake/module";
import { renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

type Rendered = ReturnType<typeof renderApp>;

/** Hash route of a mailbox of the work demo account (Outlook-like). */
const work = (mailboxId: string) =>
  `#/${encodeURIComponent(DEMO_WORK_ACCOUNT.id)}/${mailboxId}`;
/** The URL is at a mailbox of the work account (perhaps with a message open). */
const at = (mailboxId: string) => {
  const route = work(mailboxId);
  const { hash } = window.location;
  return hash === route || hash.startsWith(`${route}/`);
};
const tabs = () => screen.findByRole("tablist", { name: "Focused and Other" });
const tab = (name: string | RegExp) =>
  within(screen.getByRole("tablist")).getByRole("tab", { name });
const row = (name: RegExp) => screen.findByRole("option", { name });
const noRow = (name: RegExp) => screen.queryByRole("option", { name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const workInbox = () =>
  document.querySelector<HTMLElement>(
    `[role="treeitem"][data-account-id="${DEMO_WORK_ACCOUNT.id}"][data-role="inbox"]`,
  );
const provider = ({ services }: Rendered) => {
  const found = services.registry.get(DEMO_WORK_ACCOUNT.id)?.provider;
  if (!found) throw new Error("No work account.");
  return found;
};
/** Who sent what the provider lists on a side of the Inbox. */
const sendersIn = async (rendered: Rendered, side: string) =>
  (
    await provider(rendered).listMessages({
      mailboxId: side as typeof FAKE_OTHER_ID,
      limit: 100,
    })
  ).items.map((message) => message.from?.address);

/** The work account's Inbox: it opens on Focused. */
async function start() {
  const rendered = renderApp({
    workAccount: true,
    hash: work(WORK_MAILBOX.inbox),
  });
  await tabs();
  await waitFor(() => {
    expect(at(FAKE_FOCUSED_ID)).toBe(true);
  });
  await row(/Re: Planning for next quarter/);
  return rendered;
}

describe("Focused Inbox", () => {
  it("splits a Microsoft account's Inbox into Focused and Other", async () => {
    const { user } = await start();
    expect(tab("Focused")).toHaveAttribute("aria-selected", "true");
    // Other's unread mail shows on its tab only.
    expect(tab("Other, 2 unread")).toHaveAttribute("aria-selected", "false");
    expect(noRow(/This week at Contoso/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Inbox" }),
    ).toBeInTheDocument();
    // The Inbox stays selected in the tree, counting Focused's unread mail.
    expect(workInbox()).toHaveAttribute("aria-selected", "true");
    expect(workInbox()).toHaveTextContent("Inbox, 4 unread");

    await user.click(tab(/^Other/));
    expect(await row(/This week at Contoso/)).toBeInTheDocument();
    expect(at(FAKE_OTHER_ID)).toBe(true);
    expect(noRow(/Re: Planning for next quarter/)).not.toBeInTheDocument();
    expect(workInbox()).toHaveAttribute("aria-selected", "true");

    // g i: Focused; g o: Other.
    await user.keyboard("gi");
    await row(/Re: Planning for next quarter/);
    expect(at(FAKE_FOCUSED_ID)).toBe(true);
    await user.keyboard("go");
    await row(/This week at Contoso/);
    expect(at(FAKE_OTHER_ID)).toBe(true);

    // A search in Other covers the whole Inbox.
    await user.keyboard("/");
    await user.keyboard("planning");
    expect(await row(/Re: Planning for next quarter/)).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("moves mail to Other and back with undo", async () => {
    const rendered = await start();
    const { user } = rendered;
    await user.pointer({
      keys: "[MouseRight]",
      target: await row(/Re: Planning for next quarter/),
    });
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: /^Move to Other/ }),
    );
    expect(await toastText("Moved 1 message to Other")).toBeInTheDocument();
    await waitFor(() => {
      expect(noRow(/Re: Planning for next quarter/)).not.toBeInTheDocument();
    });
    expect(tab(/^Other/)).toHaveAccessibleName("Other, 3 unread");
    expect(await sendersIn(rendered, FAKE_OTHER_ID)).toContain(
      "mira.hofer@work.example",
    );

    await user.keyboard("z");
    expect(await row(/Re: Planning for next quarter/)).toBeInTheDocument();
    expect(tab(/^Other/)).toHaveAccessibleName("Other, 2 unread");
  });

  it("always moves a sender's mail to Other, and undo puts it all back", async () => {
    const rendered = await start();
    const { user } = rendered;
    const mira = "mira.hofer@work.example";
    expect(await sendersIn(rendered, FAKE_FOCUSED_ID)).toContain(mira);
    await user.pointer({
      keys: "[MouseRight]",
      target: await row(/Re: Planning for next quarter/),
    });
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: /^Always move to Other/,
      }),
    );
    expect(
      await toastText(`Mail from ${mira} now goes to Other`),
    ).toBeInTheDocument();
    // The rule, and Mira's other mail in the Inbox, moved along.
    await waitFor(async () => {
      expect(await sendersIn(rendered, FAKE_FOCUSED_ID)).not.toContain(mira);
    });
    expect(await provider(rendered).listFocusRules()).toContainEqual({
      address: mira,
      focus: "other",
    });

    await user.keyboard("z");
    await waitFor(async () => {
      expect(
        (await provider(rendered).listFocusRules()).map((r) => r.address),
      ).not.toContain(mira);
    });
    await waitFor(async () => {
      expect(await sendersIn(rendered, FAKE_OTHER_ID)).not.toContain(mira);
    });
    expect(await row(/Re: Planning for next quarter/)).toBeInTheDocument();
  });

  it("drops mail on the other tab", async () => {
    const { user } = await start();
    await user.click(tab(/^Other/));
    const news = await row(/This week at Contoso/);
    const data = { setData: vi.fn(), setDragImage: vi.fn() };
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragStart(news, { dataTransfer: data });
    fireEvent.dragOver(tab("Focused"), { dataTransfer: data });
    fireEvent.drop(tab("Focused"), { dataTransfer: data });
    expect(await toastText("Moved 1 message to Focused")).toBeInTheDocument();
    await waitFor(() => {
      expect(noRow(/This week at Contoso/)).not.toBeInTheDocument();
    });
  });

  it("is switched off and on in Settings, which lists the sender rules", async () => {
    const rendered = await start();
    const { user } = rendered;
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const group = within(dialog).getByRole("group", { name: "Focused Inbox" });
    const rules = await within(group).findByRole("list", {
      name: "Senders always sorted",
    });
    const side = within(rules).getByRole("combobox", {
      name: "Where mail from news@contoso.example goes",
    });
    expect(side).toHaveValue("other");
    await user.selectOptions(side, "focused");
    expect(
      await toastText("Mail from news@contoso.example now goes to Focused"),
    ).toBeInTheDocument();
    await user.click(
      within(rules).getByRole("button", {
        name: "Remove the rule for news@contoso.example",
      }),
    );
    const removed = await toastText(
      "Mail from news@contoso.example is sorted by Outlook again",
    );
    expect(await within(group).findByText(/^None yet/)).toBeInTheDocument();
    // Undo brings the rule back.
    await user.click(
      within(removed.parentElement ?? document.body).getByRole("button", {
        name: /Undo/,
      }),
    );
    expect(
      await within(group).findByRole("combobox", {
        name: "Where mail from news@contoso.example goes",
      }),
    ).toHaveValue("focused");

    // Off: one Inbox again.
    const split = within(group).getByRole("checkbox", {
      name: "demo@work.example",
    });
    expect(split).toBeChecked();
    await user.click(split);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(at(WORK_MAILBOX.inbox)).toBe(true);
    });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(await row(/This week at Contoso/)).toBeInTheDocument();
    expect(workInbox()).toHaveTextContent("Inbox, 6 unread");
  });
});
