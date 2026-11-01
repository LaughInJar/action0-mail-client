import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/renderApp";

// jsdom has no canvas and loads no images: stand-ins for the cropper's helpers.
vi.mock("./contacts/photoCrop", () => ({
  loadPicture: () =>
    Promise.resolve({
      url: "blob:picture",
      width: 400,
      height: 300,
      image: {} as HTMLImageElement,
    }),
  releasePicture: () => undefined,
  cropPicture: () =>
    Promise.resolve(new Blob(["jpeg"], { type: "image/jpeg" })),
}));

vi.setConfig({ testTimeout: 15_000 });

type User = ReturnType<typeof renderApp>["user"];

const CONTACTS = "#/contacts/all";

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
const sidebar = () => screen.getByRole("navigation", { name: "Contacts" });
const section = (account: string) =>
  within(sidebar()).getByRole("region", { name: account });
const groupButton = (account: string, name: RegExp) =>
  within(section(account)).findByRole("button", { name });
const row = async (name: string | RegExp) =>
  within(await screen.findByRole("listbox")).findByRole("option", { name });
const contactHeading = (name: string) =>
  screen.findByRole("heading", { level: 2, name });

/** Opens a group and its ⋯ menu. */
async function groupMenu(user: User, account: string, name: string) {
  await user.click(await groupButton(account, new RegExp(`^${name}\\d`)));
  await user.click(
    within(section(account)).getByRole("button", { name: `More for ${name}` }),
  );
  return screen.findByRole("menu", { name: `Group ${name}` });
}

describe("contact groups", () => {
  it("renames a Google label and undoes it", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    const menu = await groupMenu(user, "demo@example.com", "Hiking club");
    await user.click(within(menu).getByRole("menuitem", { name: "Rename…" }));
    const edit = await dialog("Edit group");
    const name = within(edit).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Hiking");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await toastText("Saved the group Hiking");
    expect(
      await groupButton("demo@example.com", /^Hiking4/),
    ).toBeInTheDocument();
    await undoToast(user);
    expect(
      await groupButton("demo@example.com", /^Hiking club4/),
    ).toBeInTheDocument();
  });

  it("deletes a label, keeping its contacts, and brings it back", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    const menu = await groupMenu(user, "demo@example.com", "Family");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Delete group" }),
    );
    await toastText("Deleted the group Family (its contacts are kept)");
    await waitFor(() => {
      expect(
        within(section("demo@example.com")).queryByRole("button", {
          name: /^Family\d/,
        }),
      ).toBeNull();
    });
    expect(await row(/Felix Mayer/)).toBeInTheDocument();
    await undoToast(user);
    expect(
      await groupButton("demo@example.com", /^Family3/),
    ).toBeInTheDocument();
  });

  it("offers no menu for Starred, and makes a new group", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    await user.click(await groupButton("demo@example.com", /^Starred\d/));
    expect(
      within(section("demo@example.com")).queryByRole("button", {
        name: "More for Starred",
      }),
    ).toBeNull();
    await user.click(
      within(section("demo@example.com")).getByRole("button", {
        name: "New group",
      }),
    );
    const create = await dialog("New group");
    await user.type(within(create).getByLabelText("Name"), "Climbing");
    await user.click(within(create).getByRole("button", { name: "Save" }));
    await toastText("Created the group Climbing");
    expect(
      await groupButton("demo@example.com", /^Climbing0/),
    ).toBeInTheDocument();
  });

  it("recolours an Outlook category, which can't be renamed", async () => {
    const { user } = renderApp({ hash: CONTACTS, workAccount: true });
    await row(/Mira Hofer/);
    const menu = await groupMenu(user, "demo@work.example", "Team");
    expect(
      within(menu).getByRole("menuitem", { name: "Rename…" }),
    ).toBeDisabled();
    expect(
      within(menu).getByText("Outlook can’t rename categories."),
    ).toBeVisible();
    await user.click(within(menu).getByRole("menuitem", { name: "Colour…" }));
    const edit = await dialog("Edit group");
    expect(within(edit).getByLabelText("Name")).toBeDisabled();
    const colours = within(edit).getAllByRole("radio");
    expect(colours).toHaveLength(25);
    await user.click(colours[0]!);
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await toastText("Saved the group Team");
  });
});

describe("contact photos", () => {
  it("changes a photo through the cropper, saved and undone with the contact", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await user.click(await row(/Felix Mayer/));
    await contactHeading("Felix Mayer");
    await user.keyboard("e");
    const editor = await dialog("Edit contact");
    const input = editor.ownerDocument.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/*"]',
    );
    await user.upload(
      input!,
      new File(["png"], "me.png", { type: "image/png" }),
    );
    const cropper = await dialog("Fit the photo");
    await user.click(within(cropper).getByRole("button", { name: "Use" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Fit the photo" }),
      ).toBeNull();
    });
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText("Saved Felix Mayer");
    const header = (await contactHeading("Felix Mayer")).closest("section")!;
    await waitFor(() => {
      expect(header.querySelector("img")).not.toBeNull();
    });
    await undoToast(user);
    await waitFor(() => {
      expect(header.querySelector("img")).toBeNull();
    });
  });

  it("removes a photo where the account allows it, and not in Outlook", async () => {
    const { user } = renderApp({ hash: CONTACTS, workAccount: true });
    await user.click(await row(/Anna Berger/));
    await contactHeading("Anna Berger");
    await user.keyboard("e");
    let editor = await dialog("Edit contact");
    await user.click(
      within(editor).getByRole("button", { name: "Remove photo" }),
    );
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText("Saved Anna Berger");
    const header = (await contactHeading("Anna Berger")).closest("section")!;
    await waitFor(() => {
      expect(header.querySelector("img")).toBeNull();
    });

    await user.click(await row(/Mira Hofer/));
    await contactHeading("Mira Hofer");
    await user.keyboard("e");
    editor = await dialog("Edit contact");
    expect(
      within(editor).getAllByRole("button", { name: "Change photo" }).length,
    ).toBeGreaterThan(0);
    expect(
      within(editor).queryByRole("button", { name: "Remove photo" }),
    ).toBeNull();
  });
});
