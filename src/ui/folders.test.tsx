import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { UI_STATE_KEY } from "../state/uiStore";
import { createFolderData, FOLDER } from "../test/folderData";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const data = () => createFolderData(TEST_NOW);
const subject = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const treeItem = (name: string) =>
  screen.findByRole("treeitem", { name: new RegExp(`^${name}`) });
const row = (name: RegExp) => screen.findByRole("option", { name });

function provider(services: ReturnType<typeof renderApp>["services"]) {
  return services.registry.list()[0]?.provider as FakeMailProvider;
}

describe("an account with folders (Outlook)", () => {
  it("shows Outlook's folder names and folder wording", async () => {
    renderApp({ data });
    await subject("Quarterly numbers");
    for (const name of [
      "Inbox",
      "Sent Items",
      "Junk Email",
      "Deleted Items",
      "Flagged",
      "Projects",
    ])
      expect(await treeItem(name)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New folder" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage folders" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /label/i }),
    ).not.toBeInTheDocument();
  });

  it("archives into the Archive folder, and z brings it back", async () => {
    const { user, services } = renderApp({ data });
    await subject("Quarterly numbers");
    await user.keyboard("a");
    expect(await toastText("Archived 1 message")).toBeInTheDocument();
    await waitFor(async () => {
      expect(
        (await provider(services).getMessage(asId("quarterly"))).mailboxIds,
      ).toEqual([FOLDER.archive]);
    });

    await user.keyboard("z");
    await waitFor(async () => {
      expect(
        (await provider(services).getMessage(asId("quarterly"))).mailboxIds,
      ).toEqual([FOLDER.inbox]);
    });
    expect(await row(/Quarterly numbers/)).toBeInTheDocument();
  });

  it("puts deleted mail back into its own folder on undo", async () => {
    const { user, services } = renderApp({
      data,
      hash: demoHash(FOLDER.projects),
    });
    await subject("Project kickoff");
    await user.keyboard("{Delete}");
    expect(await toastText("Moved 1 message to Trash")).toBeInTheDocument();
    await waitFor(async () => {
      expect(
        (await provider(services).getMessage(asId("kickoff"))).mailboxIds,
      ).toEqual([FOLDER.trash]);
    });

    await user.keyboard("z");
    await waitFor(async () => {
      expect(
        (await provider(services).getMessage(asId("kickoff"))).mailboxIds,
      ).toEqual([FOLDER.projects]);
    });
  });

  it("moves with v, offers to create a folder there, and has no Labels picker", async () => {
    const { user } = renderApp({ data });
    await subject("Quarterly numbers");
    await user.keyboard("l");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("v");
    const dialog = await screen.findByRole("dialog", { name: /Move to/ });
    await user.keyboard("Clients");
    await user.click(
      within(dialog).getByRole("option", { name: "Create folder “Clients”" }),
    );
    expect(await toastText("Moved 1 message to Clients")).toBeInTheDocument();
    expect(await treeItem("Clients")).toBeInTheDocument();
  });

  it("has a folder menu without colours or hiding, and deleting goes to Deleted Items", async () => {
    const { user, services } = renderApp({
      data,
      hash: demoHash(FOLDER.projects),
    });
    await subject("Project kickoff");
    await user.pointer({
      keys: "[MouseRight]",
      target: await treeItem("Projects"),
    });
    const menu = await screen.findByRole("menu", { name: "Folder Projects" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename…", "Move into…", "Add subfolder…", "Delete…"]);

    await user.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete folder “Projects”?",
    });
    expect(confirm).toHaveTextContent(/move to Deleted Items/);
    await user.click(
      within(confirm).getByRole("button", { name: "Delete folder" }),
    );
    expect(await toastText("Deleted folder “Projects”")).toBeInTheDocument();
    const mailboxes = await provider(services).listMailboxes();
    expect(mailboxes.find((m) => m.id === FOLDER.projects)?.parentId).toBe(
      FOLDER.trash,
    );
  });

  it("creates folders without the hide option, also inside the Inbox", async () => {
    const { user } = renderApp({ data });
    await subject("Quarterly numbers");
    await user.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(
      within(dialog).queryByRole("checkbox", {
        name: "Show in the folder list",
      }),
    ).not.toBeInTheDocument();
    const inside = within(dialog).getByRole("combobox", { name: "Inside" });
    expect(
      within(inside)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(expect.arrayContaining(["Inbox", "Projects"]));
  });
});

function asId(id: string) {
  return id as Parameters<FakeMailProvider["getMessage"]>[0];
}

describe("conversations in an account with folders", () => {
  /** Conversation view, opened on the trip conversation (rows go by their oldest message). */
  function openTrip(mailboxId: string = FOLDER.inbox) {
    window.localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        state: { settings: { conversations: true } },
        version: 1,
      }),
    );
    const app = renderApp({ data, hash: demoHash(mailboxId, "plan-1") });
    return { ...app, fake: provider(app.services) };
  }
  const folders = async (fake: FakeMailProvider) =>
    Promise.all(
      ["plan-1", "plan-2", "plan-3"].map(
        async (m) => (await fake.getMessage(asId(m))).mailboxIds,
      ),
    );

  it("archives only the conversation's Inbox messages; the sent reply stays", async () => {
    const { user, fake } = openTrip();
    await subject(/^Trip plan/);
    await user.keyboard("a");
    expect(await toastText("Archived 1 conversation")).toBeInTheDocument();
    await waitFor(async () => {
      expect(await folders(fake)).toEqual([
        [FOLDER.archive],
        [FOLDER.sent],
        [FOLDER.archive],
      ]);
    });
    await user.keyboard("z");
    await waitFor(async () => {
      expect(await folders(fake)).toEqual([
        [FOLDER.inbox],
        [FOLDER.sent],
        [FOLDER.inbox],
      ]);
    });
  });

  it("deletes and moves only the messages in the current folder", async () => {
    const { user, fake } = openTrip();
    await subject(/^Trip plan/);
    await user.keyboard("{Delete}");
    expect(
      await toastText("Moved 1 conversation to Trash"),
    ).toBeInTheDocument();
    await waitFor(async () => {
      expect(await folders(fake)).toEqual([
        [FOLDER.trash],
        [FOLDER.sent],
        [FOLDER.trash],
      ]);
    });
    await user.keyboard("z");
    await waitFor(async () => {
      expect(await folders(fake)).toEqual([
        [FOLDER.inbox],
        [FOLDER.sent],
        [FOLDER.inbox],
      ]);
    });

    await user.keyboard("v");
    const dialog = await screen.findByRole("dialog", { name: /Move to/ });
    await user.keyboard("Projects{Enter}");
    expect(dialog).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(await folders(fake)).toEqual([
        [FOLDER.projects],
        [FOLDER.sent],
        [FOLDER.projects],
      ]);
    });
  });

  it("marks the whole conversation read", async () => {
    const { user, fake } = openTrip();
    await subject(/^Trip plan/);
    await user.keyboard("{Shift>}U{/Shift}");
    await waitFor(async () => {
      expect((await fake.getMessage(asId("plan-2"))).flags.seen).toBe(false);
    });
    await user.keyboard("{Shift>}I{/Shift}");
    await waitFor(async () => {
      for (const m of ["plan-1", "plan-2", "plan-3"])
        expect((await fake.getMessage(asId(m))).flags.seen).toBe(true);
    });
  });

  it("deletes all of it from a view like Flagged", async () => {
    const { user, fake } = openTrip(FOLDER.flagged);
    await subject(/^Trip plan/);
    await user.keyboard("{Delete}");
    await waitFor(async () => {
      expect(await folders(fake)).toEqual([
        [FOLDER.trash],
        [FOLDER.trash],
        [FOLDER.trash],
      ]);
    });
  });
});
