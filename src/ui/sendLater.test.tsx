import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountId } from "../core/ids";
import { DEMO_ACCOUNT, DEMO_WORK_ACCOUNT } from "../providers/fake/module";
import { deviceIdOf } from "../state/device";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

type Services = ReturnType<typeof renderApp>["services"];
type User = ReturnType<typeof renderApp>["user"];

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const tree = () => screen.getByRole("tree", { name: "Accounts and mailboxes" });
const scheduledItem = () =>
  within(tree()).queryByRole("treeitem", { name: /^Scheduled/ });

const HOUR = 60 * 60_000;

/** Schedules a new mail in an account straight at its provider (as another device might). */
async function scheduled(
  services: Services,
  title: string,
  sendAt: number,
  {
    accountId = DEMO_ACCOUNT.id,
    by = "elsewhere",
  }: { accountId?: AccountId; by?: string } = {},
) {
  const provider = services.registry.get(accountId)?.provider;
  if (!provider) throw new Error("No such account");
  const draft = {
    to: [{ name: "Anna Berger", address: "anna@example.org" }],
    cc: [],
    bcc: [],
    subject: title,
    html: "<p>Hi</p>",
    text: "Hi",
    attachments: [],
  };
  await act(async () => {
    const { id } = await provider.saveDraft(draft);
    await provider.scheduleDraft(
      { ...draft, id },
      { sendAt: new Date(sendAt), by },
    );
    await services.queryClient.invalidateQueries();
  });
}

async function openScheduled(user: User, title: string) {
  const item = await waitFor(() => {
    const found = scheduledItem();
    if (!found) throw new Error("No Scheduled yet");
    return found;
  });
  await user.click(item);
  await user.click(
    await screen.findByRole("option", { name: new RegExp(title) }),
  );
  return subject(title);
}

describe("Send later", () => {
  it("schedules a reply from Send's menu, and Undo brings it back", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "trip-1") });
    await subject("Trip to Lake Como");
    expect(scheduledItem()).toBeNull();
    await user.keyboard("r");
    const composer = await dialog("Re: Trip to Lake Como");
    await user.click(
      within(composer).getByRole("button", { name: /^More send options/ }),
    );
    const menu = await screen.findByRole("menu", { name: "Send later" });
    await user.click(
      within(menu).getByRole("menuitem", { name: /^Tomorrow morning/ }),
    );
    const toast = await toastText(/^Scheduled for /);
    expect(screen.queryByRole("dialog", { name: /Re: Trip/ })).toBeNull();
    await waitFor(() => {
      expect(scheduledItem()).toHaveTextContent(/1 scheduled/);
    });

    await user.click(
      within(toast.parentElement!).getByRole("button", { name: /Undo/ }),
    );
    await dialog("Re: Trip to Lake Como");
    await waitFor(() => {
      expect(scheduledItem()).toBeNull();
    });
  });

  it("shows a scheduled mail's time and takes it back into Drafts, undoably", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await scheduled(services, "See you Monday", Date.now() + 24 * HOUR);
    await openScheduled(user, "See you Monday");
    expect(
      screen.getByText(/^This mail goes out /, { selector: "span" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/action0 sends it if it’s running then/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel send" }));
    const toast = await toastText("Back in Drafts");
    await waitFor(() => {
      expect(scheduledItem()).toBeNull();
    });
    await user.click(
      within(toast.parentElement!).getByRole("button", { name: /Undo/ }),
    );
    await waitFor(() => {
      expect(scheduledItem()).toHaveTextContent(/1 scheduled/);
    });
  });

  it("changes the time, edits it still scheduled, and sends it now", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    act(() => {
      services.uiStore.getState().updateSettings({ undoSendSeconds: 0 });
    });
    await scheduled(services, "Report", Date.now() + 24 * HOUR);
    await openScheduled(user, "Report");

    await user.click(screen.getByRole("button", { name: "Change time" }));
    const menu = await screen.findByRole("menu", { name: "Send later" });
    await user.click(
      within(menu).getByRole("menuitem", { name: /^Tomorrow afternoon/ }),
    );
    await toastText(/^Rescheduled for /);

    await user.click(await screen.findByRole("option", { name: /Report/ }));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const composer = await dialog("Report");
    expect(within(composer).getByText(/^Scheduled for /)).toBeInTheDocument();
    expect(
      within(composer).getByRole("button", { name: /^Schedule/ }),
    ).toBeInTheDocument();
    await user.click(
      within(composer).getByRole("button", { name: /^Close \(Esc/ }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Report" })).toBeNull();
    });

    await user.click(await screen.findByRole("option", { name: /Report/ }));
    await user.click(await screen.findByRole("button", { name: "Send now" }));
    await toastText("Message sent");
    await waitFor(() => {
      expect(scheduledItem()).toBeNull();
    });
  });

  it("sends what's due, and asks about mail more than 30 minutes late", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const me = deviceIdOf(services.uiStore);
    await scheduled(services, "Due now", Date.now() - 60_000, { by: me });
    await toastText("Sent your scheduled mail “Due now”");

    await scheduled(services, "Too late", Date.now() - HOUR);
    const bar = await screen.findByText(
      /^1 scheduled mail wasn’t sent \(/,
      {},
      { timeout: 5000 },
    );
    // It stays scheduled until then.
    expect(scheduledItem()).toHaveTextContent(/1 scheduled/);
    await user.click(
      within(bar.parentElement!).getByRole("button", { name: "Send now" }),
    );
    await toastText("Sent your scheduled mail “Too late”");
    expect(screen.queryByText(/scheduled mail wasn’t sent/)).toBeNull();
  });

  it("says when the server holds it, and lists every account's in All accounts", async () => {
    const { user, services } = renderApp({ workAccount: true });
    await screen.findByRole("option", { name: /Welcome to the demo/ });
    await scheduled(services, "Later at home", Date.now() + 2 * HOUR);
    await scheduled(services, "Sooner at work", Date.now() + HOUR, {
      accountId: DEMO_WORK_ACCOUNT.id,
    });
    const combined = await waitFor(() => {
      const item = within(tree()).getAllByRole("treeitem", {
        name: /^Scheduled/,
      })[0];
      if (!item) throw new Error("not yet");
      return item;
    });
    expect(combined).toHaveTextContent(/2/);
    await user.click(combined);
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("option")
          .map((option) => /Sooner|Later/.exec(option.textContent)?.[0]),
      ).toEqual(["Sooner", "Later"]);
    });
    await user.click(screen.getByRole("option", { name: /Sooner at work/ }));
    await subject("Sooner at work");
    expect(
      screen.getByText("Outlook sends it, even with action0 closed."),
    ).toBeInTheDocument();
  });

  it("offers a scheduled mail's actions in the command palette", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await scheduled(services, "Plans", Date.now() + 24 * HOUR);
    await openScheduled(user, "Plans");
    await user.keyboard("{Control>}k{/Control}");
    const palette = await dialog("Command palette");
    await user.keyboard("scheduled");
    expect(
      within(palette).getByRole("option", {
        name: /Send the scheduled mail now/,
      }),
    ).toBeInTheDocument();
    expect(
      within(palette).getByRole("option", {
        name: /Cancel the scheduled send/,
      }),
    ).toBeInTheDocument();
  });
});
