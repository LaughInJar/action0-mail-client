import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WORK_EMAIL } from "../providers/fake/demoWork";
import { DEMO_WORK_ACCOUNT } from "../providers/fake/module";
import { renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const option = (name: RegExp) => screen.findByRole("option", { name });
const treeItem = (name: RegExp) => screen.findByRole("treeitem", { name });
/** A combined view's row in the tree (each account has its own Sent too). */
const combinedItem = async (role: string) => {
  await treeItem(/^All accounts/);
  const item = document.querySelector<HTMLElement>(
    `[data-key="combined/${role}"]`,
  );
  if (!item) throw new Error(`No combined ${role}`);
  return item;
};
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const rows = () => screen.getAllByRole("option").map((row) => row.textContent);

/** Both demo accounts, with All inboxes open. */
async function start() {
  const rendered = renderApp({ workAccount: true });
  await subject("Welcome to the demo");
  return rendered;
}

describe("combined views", () => {
  it("are grouped under All accounts, which collapses and stays so", async () => {
    const { user, services } = await start();
    const group = await treeItem(/^All accounts/);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(await treeItem(/^All inboxes/)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect((await combinedItem("flagged")).textContent).toBe("Starred");
    expect((await combinedItem("sent")).textContent).toBe("Sent");
    // The demo account has one draft, the work account none.
    expect((await combinedItem("drafts")).textContent).toBe("Drafts, 1 draft");

    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector('[data-key="combined/flagged"]')).toBeNull();
    expect(services.uiStore.getState().toggledNodes.has("combined")).toBe(true);
  });

  it("lists the starred mail of every account, and unstars across accounts with undo", async () => {
    const { user } = await start();
    await user.click(await combinedItem("flagged"));
    await waitFor(() => {
      expect(window.location.hash.startsWith("#/all/flagged/")).toBe(true);
    });
    expect(
      screen.getByRole("listbox", {
        name: "Messages in Starred in all accounts",
      }),
    ).toBeInTheDocument();
    await option(/Team offsite/);
    expect(rows().some((row) => row.includes("Welcome to the demo"))).toBe(
      true,
    );

    await user.click(await option(/Team offsite/));
    await subject("Team offsite");
    await user.keyboard("s");
    await toastText(/Removed the star|Unstarred/);
    await waitFor(() => {
      expect(rows().some((row) => row.includes("Team offsite"))).toBe(false);
    });
    await user.keyboard("z");
    expect(await option(/Team offsite/)).toBeInTheDocument();
  });

  it("lists sent mail of every account with its recipients, and searches in it", async () => {
    const { user } = await start();
    await user.click(await combinedItem("sent"));
    await waitFor(() => {
      expect(window.location.hash.startsWith("#/all/sent/")).toBe(true);
    });
    expect(
      await option(/Mira Hofer.*Re: Planning for next quarter/),
    ).toBeInTheDocument();
    expect(
      await option(/Lukas Hofer.*Re: Server migration/),
    ).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Search Sent in all accounts");
    await user.type(search, "planning");
    await waitFor(
      () => {
        expect(window.location.hash).toMatch(/^#\/all\/sent\/.*\?q=planning/);
      },
      { timeout: 3000 },
    );
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toContain("Re: Planning for next quarter");
    });
  });

  it("opens a combined draft in the composer, from its own account", async () => {
    const { user, services } = await start();
    const work = services.registry.get(DEMO_WORK_ACCOUNT.id)?.provider;
    await work?.saveDraft({
      to: [{ address: "priya.nair@work.example" }],
      cc: [],
      bcc: [],
      subject: "Agenda for Monday",
      html: "<p>First draft</p>",
      text: "First draft",
      attachments: [],
    });
    await user.keyboard("gd");
    // Inside an account g d goes to its Drafts; in a combined view it stays combined.
    await waitFor(() => {
      expect(window.location.hash.startsWith("#/all/drafts/")).toBe(true);
    });
    expect(
      await option(/priya\.nair@work\.example.*Agenda for Monday/),
    ).toBeInTheDocument();
    expect(await option(/Feedback on the proposal/)).toBeInTheDocument();
    await user.click(await option(/Agenda for Monday/));
    const composer = await screen.findByRole(
      "dialog",
      { name: "Agenda for Monday" },
      { timeout: 5000 },
    );
    expect(
      within(composer).getByRole("combobox", { name: "From" }),
    ).toHaveValue(`${DEMO_WORK_ACCOUNT.id} ${WORK_EMAIL}`);
  });
});
