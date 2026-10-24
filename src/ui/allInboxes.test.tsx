import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StaticAuthSession } from "../auth/staticSession";
import { asMailboxId } from "../core/ids";
import { createDemoData } from "../providers/fake/demoData";
import {
  createWorkDemoData,
  WORK_EMAIL,
  WORK_MAILBOX,
} from "../providers/fake/demoWork";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import {
  createDemoModule,
  DEMO_ACCOUNT,
  DEMO_WORK_ACCOUNT,
} from "../providers/fake/module";
import { demoHash, renderApp, TEST_NOW, unifiedHash } from "../test/renderApp";

// Some tests wait for the composer's autosave.
vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const option = (name: RegExp) => screen.findByRole("option", { name });
const allInboxes = () =>
  screen.findByRole("treeitem", { name: /^All inboxes/ });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const treeItem = (name: RegExp) => screen.getByRole("treeitem", { name });
const work = encodeURIComponent(DEMO_WORK_ACCOUNT.id);

/** A stand-in for DataTransfer, which jsdom doesn't implement. */
function dataTransfer() {
  return {
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: "",
    dropEffect: "",
  };
}

/** Fires a drag event (jsdom has no DragEvent constructor). */
function drag(type: "dragover" | "drop", element: Element, data: object) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: data },
    ctrlKey: { value: false },
    altKey: { value: false },
  });
  fireEvent(element, event);
}

/** Both demo accounts, with All inboxes open on the newest message ("Welcome"). */
async function start(options: Parameters<typeof renderApp>[0] = {}) {
  const rendered = renderApp({ workAccount: true, ...options });
  await subject("Welcome to the demo");
  return rendered;
}

describe("All inboxes", () => {
  it("isn't offered with one account", async () => {
    renderApp();
    await subject("Welcome to the demo");
    expect(
      screen.queryByRole("treeitem", { name: /^All inboxes/ }),
    ).not.toBeInTheDocument();
    expect(window.location.hash.startsWith("#/all/")).toBe(false);
  });

  it("opens first with several accounts, with their unread mail together", async () => {
    await start();
    expect(window.location.hash.startsWith("#/all/")).toBe(true);
    const item = await allInboxes();
    expect(item).toHaveAttribute("aria-selected", "true");
    // 18 unread in the demo Inbox, 4 in the work Inbox.
    await waitFor(() => {
      expect(item).toHaveTextContent("22");
    });
    expect(
      screen.getByRole("heading", { level: 2, name: "All inboxes" }),
    ).toBeInTheDocument();
  });

  it("merges both Inboxes by date, each row with its account", async () => {
    await start();
    await option(/Re: Planning for next quarter/);
    const times = screen
      .getAllByRole("option")
      .map((row) => row.querySelector("time")?.getAttribute("datetime") ?? "");
    expect(times.length).toBeGreaterThan(10);
    expect([...times].sort().reverse()).toEqual(times);
    expect(
      await option(/Re: Planning for next quarter.*, in demo@work\.example/),
    ).toBeInTheDocument();
    expect(
      await option(/Welcome to the demo.*, in demo@example\.com/),
    ).toBeInTheDocument();
    // Only Inbox mail: the work account's Archive stays out.
    expect(
      screen.queryByRole("option", { name: /Last year's report/ }),
    ).not.toBeInTheDocument();
  });

  it("opens a message of the other account, naming the account, and stays All inboxes", async () => {
    const { user } = await start();
    expect(screen.getByText("In demo@example.com")).toBeInTheDocument();
    await user.click(await option(/Re: Planning for next quarter/));
    expect(await subject("Re: Planning for next quarter")).toBeInTheDocument();
    expect(screen.getByText("In demo@work.example")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe(
        unifiedHash(DEMO_WORK_ACCOUNT.id, WORK_MAILBOX.inbox, "w-plan-3"),
      );
    });
    expect(await allInboxes()).toHaveAttribute("aria-selected", "true");
    // j/k carry on through both accounts.
    await user.keyboard("k");
    expect(await subject("Welcome to the demo")).toBeInTheDocument();
  });

  it("archives a selection of both accounts as one action, and z brings both back", async () => {
    const { user } = await start();
    await user.keyboard("x");
    const planning = await option(/Re: Planning for next quarter/);
    await user.keyboard("{Control>}");
    await user.click(planning);
    await user.keyboard("{/Control}");
    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    await user.keyboard("a");
    expect(await toastText("Archived 2 messages")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /Re: Planning for next quarter/ }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("option", { name: /Welcome to the demo/ }),
    ).not.toBeInTheDocument();

    await user.keyboard("z");
    expect(await option(/Re: Planning for next quarter/)).toBeInTheDocument();
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
  });

  it("moves and labels only within one account", async () => {
    const { user } = await start();
    await user.keyboard("x");
    await user.keyboard("{Control>}");
    await user.click(await option(/Re: Planning for next quarter/));
    await user.keyboard("{/Control}");
    await user.keyboard("v");
    expect(
      await toastText(
        "Moving and labels work within one account: select messages of one account.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // A message of the work account: its folders.
    await user.keyboard("{Escape}");
    await user.click(await option(/Re: Planning for next quarter/));
    await subject("Re: Planning for next quarter");
    await user.keyboard("v");
    const dialog = await screen.findByRole("dialog", { name: /Move to/ });
    const names = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(["Projects", "Clients"]));
    expect(names).not.toContain("Receipts");
    expect(names).not.toContain("Inbox");
    await user.keyboard("proj{Enter}");
    expect(await toastText("Moved 1 message to Projects")).toBeInTheDocument();
  });

  it("doesn't drop messages on another account's mailbox", async () => {
    await start();
    const row = await option(/Re: Planning for next quarter/);
    const data = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });

    const receipts = treeItem(/^Receipts/);
    drag("dragover", receipts, data);
    expect(within(receipts).getByText("Other account")).toBeInTheDocument();
    drag("drop", receipts, data);
    expect(
      screen.queryByText(/Moved 1 message/, {
        selector: "div[aria-live] span",
      }),
    ).not.toBeInTheDocument();

    const projects = treeItem(/^Projects/);
    drag("dragover", projects, data);
    expect(within(projects).getByText("Move here")).toBeInTheDocument();
    drag("drop", projects, data);
    expect(await toastText("Moved 1 message to Projects")).toBeInTheDocument();
  });

  it("searches every Inbox, or everywhere", async () => {
    const { user } = await start();
    await user.type(
      screen.getByRole("searchbox", { name: "Search mail" }),
      "planning{Enter}",
    );
    expect(
      await option(/Re: Planning for next quarter.*demo@work\.example/),
    ).toBeInTheDocument();
    const scope = screen.getByRole("group", { name: "Search in" });
    expect(
      within(scope).getByRole("button", { name: "All inboxes" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(window.location.hash).toMatch(/^#\/all\/.*\?q=planning$/);

    await user.click(within(scope).getByRole("button", { name: "Everywhere" }));
    await waitFor(() => {
      expect(window.location.hash).toMatch(/&in=all$/);
    });
    expect(await allInboxes()).toHaveAttribute("aria-selected", "true");
  });

  it("goes there with g u, and g i to the Inbox of the open message's account", async () => {
    const { user } = await start({ hash: demoHash("inbox") });
    expect(window.location.hash.startsWith("#/all/")).toBe(false);
    await user.keyboard("gu");
    await waitFor(() => {
      expect(window.location.hash.startsWith("#/all/")).toBe(true);
    });
    await user.click(await option(/Re: Planning for next quarter/));
    await subject("Re: Planning for next quarter");
    await user.keyboard("gi");
    await waitFor(() => {
      expect(window.location.hash.startsWith(`#/${work}/w-inbox`)).toBe(true);
    });
  });

  it("answers from the message's account, and writes new mail from the account used last", async () => {
    const { user, services } = await start();
    await user.click(await option(/Re: Planning for next quarter/));
    await subject("Re: Planning for next quarter");
    await user.keyboard("r");
    const reply = await screen.findByRole(
      "dialog",
      { name: "Re: Planning for next quarter" },
      { timeout: 5000 },
    );
    expect(within(reply).getByRole("combobox", { name: "From" })).toHaveValue(
      `${DEMO_WORK_ACCOUNT.id} ${WORK_EMAIL}`,
    );
    await user.click(within(reply).getByRole("button", { name: /Discard/ }));

    act(() => {
      services.uiStore
        .getState()
        .updateSettings({ lastSendAccount: DEMO_WORK_ACCOUNT.id });
    });
    await user.keyboard("c");
    const fresh = await screen.findByRole(
      "dialog",
      { name: "New message" },
      { timeout: 5000 },
    );
    expect(within(fresh).getByRole("combobox", { name: "From" })).toHaveValue(
      `${DEMO_WORK_ACCOUNT.id} ${WORK_EMAIL}`,
    );
  });

  it("moves a draft with its files to the account chosen in From", async () => {
    const { user, services } = await start();
    await user.keyboard("c");
    const dialog = await screen.findByRole(
      "dialog",
      { name: "New message" },
      { timeout: 5000 },
    );
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Moving");
    const input = document.querySelector<HTMLInputElement>(
      '[data-own-keys] input[type="file"]',
    );
    if (!input) throw new Error("No file input");
    await user.upload(
      input,
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    );
    expect(await within(dialog).findByText("Saved", {}, { timeout: 4000 }));

    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "From" }),
      `${DEMO_WORK_ACCOUNT.id} ${WORK_EMAIL}`,
    );
    const providerOf = (id: typeof DEMO_ACCOUNT.id) =>
      services.registry.get(id)?.provider as FakeMailProvider;
    const draftsIn = async (
      id: typeof DEMO_ACCOUNT.id,
      drafts: ReturnType<typeof asMailboxId>,
    ) =>
      (await providerOf(id).listMessages({ mailboxId: drafts, limit: 50 }))
        .items;
    await waitFor(
      async () => {
        const moved = (
          await draftsIn(DEMO_WORK_ACCOUNT.id, WORK_MAILBOX.drafts)
        ).find((message) => message.subject === "Moving");
        expect(moved?.hasAttachments).toBe(true);
      },
      { timeout: 5000 },
    );
    const left = await draftsIn(DEMO_ACCOUNT.id, asMailboxId("drafts"));
    expect(left.some((message) => message.subject === "Moving")).toBe(false);
  });

  it("notes an account that needs reconnecting and still lists the other", async () => {
    const { services } = await start();
    await option(/Re: Planning for next quarter/);
    act(() => {
      (
        services.registry.get(DEMO_WORK_ACCOUNT.id)?.auth as StaticAuthSession
      ).markExpired();
    });
    expect(
      await screen.findByText(
        "demo@work.example needs reconnecting, so its messages aren’t shown.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /Re: Planning for next quarter/ }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: /Welcome to the demo/ }));
  });

  it("leaves for the Inbox of the account that's left when the other is removed", async () => {
    const { services } = await start();
    await act(() => services.registry.remove(DEMO_WORK_ACCOUNT.id));
    await waitFor(() => {
      expect(window.location.hash.startsWith(demoHash("inbox"))).toBe(true);
    });
    expect(
      screen.queryByRole("treeitem", { name: /^All inboxes/ }),
    ).not.toBeInTheDocument();
  });

  it("loads more from the account that is behind", async () => {
    const { user } = await start();
    const before = screen.getAllByRole("option").length;
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBeGreaterThan(before);
    });
  });

  it("shows new mail of every account as it arrives", async () => {
    let clock = TEST_NOW;
    renderApp({
      workAccount: true,
      modules: [
        createDemoModule({
          latencyMs: 0,
          data: () => createDemoData(TEST_NOW),
          workData: () => createWorkDemoData(TEST_NOW),
          arrivalEveryMs: 60_000,
          now: () => clock,
        }),
      ],
    });
    await subject("Welcome to the demo");
    // Both accounts have new mail once 90 s have passed.
    clock += 91_000;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    const arrived = new Date(clock).toISOString();
    await waitFor(() => {
      const newest = screen
        .getAllByRole("option")
        .slice(0, 2)
        .filter(
          (row) =>
            row.querySelector("time")?.getAttribute("datetime") === arrived,
        )
        .map((row) => row.textContent);
      expect(newest).toHaveLength(2);
      expect(newest.some((text) => text.includes("in demo@work.example"))).toBe(
        true,
      );
    });
  });

  it("lists conversations of both accounts in conversation view", async () => {
    const { user, services } = await start();
    act(() => {
      services.uiStore.getState().updateSettings({ conversations: true });
    });
    const planning = await option(/Planning for next quarter/);
    await user.click(planning);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: /^Planning for next quarter/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("In demo@work.example")).toBeInTheDocument();
    expect(await option(/Welcome to the demo/)).toBeInTheDocument();
  });
});
