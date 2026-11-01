import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asMessageId, type AccountId } from "../core/ids";
import { DEMO_ACCOUNT, DEMO_WORK_ACCOUNT } from "../providers/fake/module";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

type Services = ReturnType<typeof renderApp>["services"];

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const tree = () => screen.getByRole("tree", { name: "Accounts and mailboxes" });
const snoozedItem = () =>
  within(tree()).queryByRole("treeitem", { name: /^Snoozed/ });

const HOUR = 60 * 60_000;

/** Snoozes a message straight at its provider (as another device might). */
async function snoozed(
  services: Services,
  id: string,
  until: number,
  accountId: AccountId = DEMO_ACCOUNT.id,
) {
  const provider = services.registry.get(accountId)?.provider;
  await act(async () => {
    await provider?.snooze([asMessageId(id)], new Date(until));
    await services.queryClient.invalidateQueries();
  });
}

describe("Snooze", () => {
  it("snoozes the open mail with h until a preset, and Undo brings it back", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "trip-1") });
    await subject("Trip to Lake Como");
    expect(snoozedItem()).toBeNull();
    await user.keyboard("h");
    const menu = await screen.findByRole("menu", { name: "Snooze" });
    await user.click(
      within(menu).getByRole("menuitem", { name: /^Tomorrow morning/ }),
    );
    const toast = await toastText(/^Snoozed 1 message until /);
    expect(
      screen.queryByRole("option", { name: /Shall we book the train/ }),
    ).toBeNull();
    await waitFor(() => {
      expect(snoozedItem()).toHaveTextContent(/1 snoozed/);
    });

    await user.click(
      within(toast.parentElement!).getByRole("button", { name: /Undo/ }),
    );
    expect(
      await screen.findByRole("option", { name: /Shall we book the train/ }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(snoozedItem()).toBeNull();
    });
  });

  it("lists snoozed mail with its return time, and takes it back with Unsnooze", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await snoozed(services, "trip-1", Date.now() + 24 * HOUR);
    await user.click(await waitFor(() => snoozedItem() ?? fail()));
    const row = await screen.findByRole("option", {
      name: /Trip to Lake Como/,
    });
    expect(row).toHaveTextContent(/Back /);
    await user.click(row);
    const banner = (
      await screen.findByText(/^Snoozed until /, { selector: "span" })
    ).closest<HTMLElement>('[role="status"]');
    await user.click(
      within(banner ?? document.body).getByRole("button", { name: "Unsnooze" }),
    );
    await toastText("1 message back in the Inbox");
    await waitFor(() => {
      expect(snoozedItem()).toBeNull();
    });
  });

  it("brings mail back when it's due: unread, at the top of the Inbox, until it's opened", async () => {
    const { user, services } = renderApp({ hash: demoHash("inbox") });
    await screen.findByRole("option", { name: /Welcome to the demo/ });
    // Due at once: the waker brings it back.
    await snoozed(services, "trip-1", Date.now() - 1000);
    await toastText("Back from snooze: Trip to Lake Como");
    const first = await waitFor(() => {
      const [row] = screen.getAllByRole("option");
      expect(row).toHaveTextContent(/Back from snooze/);
      return row;
    });
    expect(first).toHaveTextContent(/Trip to Lake Como/);
    expect(snoozedItem()).toBeNull();

    // Opening it takes the mark off: it goes back to its place.
    if (first) await user.click(first);
    await subject("Trip to Lake Como");
    await waitFor(() => {
      expect(screen.queryByText("Back from snooze")).toBeNull();
    });
  });

  it("moves folder accounts' mail into their Snoozed folder, and combines every account's", async () => {
    const { user, services } = renderApp({ workAccount: true });
    await screen.findByRole("option", { name: /Welcome to the demo/ });
    await snoozed(services, "trip-1", Date.now() + 2 * HOUR);
    const provider = services.registry.get(DEMO_WORK_ACCOUNT.id)?.provider;
    const inbox = (await provider?.listMailboxes())?.find(
      (mailbox) => mailbox.role === "inbox",
    );
    const page = inbox
      ? await provider?.listMessages({ mailboxId: inbox.id, limit: 1 })
      : undefined;
    const workId = page?.items[0]?.id ?? "";
    await snoozed(services, workId, Date.now() + HOUR, DEMO_WORK_ACCOUNT.id);
    const work = await provider?.listMailboxes();
    expect(work?.find((mailbox) => mailbox.role === "snoozed")?.kind).toBe(
      "folder",
    );

    const combined = await waitFor(() => {
      const [item] = within(tree()).getAllByRole("treeitem", {
        name: /^Snoozed/,
      });
      if (!item) throw new Error("not yet");
      return item;
    });
    expect(combined).toHaveTextContent(/2/);
    await user.click(combined);
    await waitFor(() => {
      const rows = screen.getAllByRole("option");
      expect(rows).toHaveLength(2);
      // Back soonest first: the work mail.
      expect(rows[1]).toHaveTextContent(/Trip to Lake Como/);
    });
  });

  it("is offered in the command palette while a mail is open", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "trip-1") });
    await subject("Trip to Lake Como");
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    await user.keyboard("snooze");
    expect(
      within(palette).getByRole("option", { name: /Snooze until a time/ }),
    ).toBeInTheDocument();
  });
});

function fail(): never {
  throw new Error("Not there yet");
}
