import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FakeContactsProvider } from "../providers/fake/FakeContactsProvider";
import { fakeDesktopPlatform } from "../test/desktopPlatform";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

type User = ReturnType<typeof renderApp>["user"];
type Services = ReturnType<typeof renderApp>["services"];

const CONTACTS = "#/contacts/all";

const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const question = (name: string) =>
  screen.findByRole("alertdialog", { name }, { timeout: 5000 });
const undoToast = (user: User) =>
  user.click(
    within(
      screen.getByText(/./, { selector: "div[aria-live] span" }).parentElement!,
    ).getByRole("button", { name: /Undo/ }),
  );
const list = () => screen.findByRole("listbox");
const row = async (name: string | RegExp) =>
  within(await list()).findByRole("option", { name });
const names = async () =>
  within(await list())
    .getAllByRole("option")
    .map((option) => option.querySelector(".font-medium")?.textContent);
const contactHeading = (name: string) =>
  screen.findByRole("heading", { level: 2, name });
const sidebar = () => screen.getByRole("navigation", { name: "Contacts" });

const demoContacts = (services: Services) =>
  services.registry.list()[0]?.contacts as FakeContactsProvider;

describe("the contacts", () => {
  it("opens with g p, lists by name with letters, searches and shows a contact", async () => {
    const { user } = renderApp({ hash: demoHash("inbox") });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await user.keyboard("gp");
    expect(
      await screen.findByRole("button", { name: "Contacts", pressed: true }),
    ).toBeInTheDocument();
    await row(/Anna Berger/);
    expect((await names()).slice(0, 3)).toEqual([
      "Anna Berger",
      "Clara Pichler",
      "David Fischer",
    ]);
    // Names that start with something else come last, under "#"… and
    // the company-only Pizzeria sorts by its name.
    expect(await names()).toContain("Pizzeria Bella");

    await user.type(screen.getByRole("searchbox"), "hik");
    await waitFor(async () => {
      expect(await names()).toEqual(["Clara Pichler"]);
    });
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "5550101");
    await waitFor(async () => {
      expect(await names()).toEqual(["Lukas Hofer", "Lukas Hofer"]);
    });
    await user.clear(screen.getByRole("searchbox"));

    await user.click(await row(/Anna Berger/));
    await contactHeading("Anna Berger");
    expect(screen.getByText("Project lead · Berger & Partner")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "+43 664 123 4567" }),
    ).toHaveAttribute("href", "tel:+436641234567");
    expect(screen.getByText("March 14, 1988")).toBeVisible();
    // j moves to the next contact.
    await user.keyboard("j");
    await contactHeading("Clara Pichler");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { level: 2, name: "Clara Pichler" }),
      ).toBeNull();
    });
  });

  it("creates a contact with c, undoably", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    await user.keyboard("c");
    const editor = await dialog("New contact");
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Fill in a name, an address or a phone number first.",
    );
    await user.type(within(editor).getByLabelText("First name"), "Zoe");
    await user.type(within(editor).getByLabelText("Last name"), "Lechner");
    await user.click(
      within(editor).getByRole("button", { name: "+ Add email" }),
    );
    await user.type(
      within(editor).getByRole("textbox", { name: "Email" }),
      "zoe@example.com",
    );
    await user.selectOptions(within(editor).getByLabelText("Day"), "9");
    await user.selectOptions(within(editor).getByLabelText("Month"), "May");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await toastText("Added Zoe Lechner");
    await contactHeading("Zoe Lechner");
    expect(screen.getByText("May 9")).toBeVisible();
    expect(await row(/Zoe Lechner/)).toBeInTheDocument();

    await undoToast(user);
    await waitFor(async () => {
      expect(await names()).not.toContain("Zoe Lechner");
    });
  });

  it("edits a contact, asks before discarding changes, and undoes", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await user.click(await row(/Mia Steiner/));
    await contactHeading("Mia Steiner");
    await user.keyboard("e");
    let editor = await dialog("Edit contact");
    const phone = within(editor).getByRole("textbox", { name: "Phone" });
    expect(phone).toHaveValue("+43 650 777 1234");
    await user.clear(phone);
    await user.type(phone, "+43 650 000 0000");

    // Esc with changes asks; keep editing keeps them.
    await user.keyboard("{Escape}");
    const asked = await question("Discard your changes?");
    await user.click(
      within(asked).getByRole("button", { name: "Keep editing" }),
    );
    editor = await dialog("Edit contact");
    expect(within(editor).getByRole("textbox", { name: "Phone" })).toHaveValue(
      "+43 650 000 0000",
    );

    // Back with changes asks too.
    act(() => {
      window.history.back();
    });
    await question("Discard your changes?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    editor = await dialog("Edit contact");

    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText("Saved Mia Steiner");
    expect(
      await screen.findByRole("link", { name: "+43 650 000 0000" }),
    ).toBeInTheDocument();
    await undoToast(user);
    expect(
      await screen.findByRole("link", { name: "+43 650 777 1234" }),
    ).toBeInTheDocument();
  });

  it("deletes a contact and brings it back with undo", async () => {
    const { user, services } = renderApp({ hash: CONTACTS });
    await user.click(await row(/Felix Mayer/));
    await contactHeading("Felix Mayer");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await toastText("Deleted Felix Mayer");
    await waitFor(async () => {
      expect(await names()).not.toContain("Felix Mayer");
    });
    await undoToast(user);
    expect(await row(/Felix Mayer/)).toBeInTheDocument();
    const provider = demoContacts(services);
    const { contacts } = await provider.load(undefined);
    expect(
      contacts.filter((contact) => contact.displayName === "Felix Mayer"),
    ).toHaveLength(1);
  });

  it("filters by group and puts a contact into a new group", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    await user.click(
      within(sidebar()).getByRole("button", { name: /^Hiking club/ }),
    );
    await waitFor(async () => {
      expect(await names()).toEqual([
        "Clara Pichler",
        "David Fischer",
        "Lukas Hofer",
        "Sophie Wagner",
      ]);
    });
    await user.click(await row(/David Fischer/));
    await user.keyboard("e");
    const editor = await dialog("Edit contact");
    await user.type(within(editor).getByLabelText("New group"), "Climbing");
    await user.click(within(editor).getByRole("button", { name: "Add" }));
    expect(within(editor).getByLabelText("Climbing")).toBeChecked();
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText("Saved David Fischer");
    await user.click(
      await within(sidebar()).findByRole("button", { name: /^Climbing/ }),
    );
    await waitFor(async () => {
      expect(await names()).toEqual(["David Fischer"]);
    });
  });

  it("adds one of Google's Other contacts to the contacts", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    await user.click(
      within(sidebar()).getByRole("button", { name: /^Other contacts3/ }),
    );
    await user.click(await row(/Hannah Zeller/));
    await screen.findByText(/one of Google’s “Other contacts”/);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add to contacts" }));
    await toastText("Added Hannah Zeller to your contacts");
    expect(
      await within(sidebar()).findByRole("button", {
        name: /^Other contacts2/,
      }),
    ).toBeInTheDocument();
    expect(await row(/Hannah Zeller/)).toBeInTheDocument();
  });

  it("asks for access where the account hasn't allowed contacts", async () => {
    const { user } = renderApp({ hash: CONTACTS, contactsAccess: "missing" });
    await within(sidebar()).findByText(
      "This account hasn’t allowed action0 to see its contacts yet.",
    );
    await user.click(
      within(sidebar()).getByRole("button", { name: "Allow contacts" }),
    );
    expect(await row(/Anna Berger/)).toBeInTheDocument();
  });

  it("asks for permission to edit on the first change (Google read-only)", async () => {
    const { user, services } = renderApp({
      hash: CONTACTS,
      contactsAccess: "readOnly",
    });
    await user.click(await row(/Lena Huber/));
    await within(sidebar()).findByText(/Read only for now/);
    await user.keyboard("e");
    const editor = await dialog("Edit contact");
    await user.type(within(editor).getByLabelText("Nickname"), "Lenchen");
    const provider = demoContacts(services);
    const request = vi.spyOn(provider, "requestAccess");
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await toastText("Saved Lena Huber");
    expect(request).toHaveBeenCalledOnce();
    expect(provider.access()).toBe("granted");
  });

  it("finds duplicates and merges them, undoably", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    await user.click(
      within(sidebar()).getByRole("button", {
        name: "More for demo@example.com",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Find duplicates" }),
    );
    const duplicates = await dialog("Duplicates in demo@example.com");
    expect(within(duplicates).getByText("Same phone number")).toBeVisible();
    expect(within(duplicates).getByText("Same email address")).toBeVisible();
    const lukas = within(duplicates).getByRole("region", {
      name: "Lukas Hofer",
    });
    expect(
      within(lukas).getByText(
        "lukas.hofer@work.example, lukas@example.net, +43 676 5550101, Hofer Bau",
      ),
    ).toBeVisible();
    await user.click(within(lukas).getByRole("button", { name: "Merge" }));
    await toastText("Merged into Lukas Hofer");
    await waitFor(() => {
      expect(
        within(duplicates).queryByRole("region", { name: "Lukas Hofer" }),
      ).toBeNull();
    });
    await undoToast(user);
    expect(
      await within(duplicates).findByRole("region", { name: "Lukas Hofer" }),
    ).toBeInTheDocument();
  });

  it("merges selected contacts", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    const sophies = within(await list()).getAllByRole("option", {
      name: /Sophie Wagner/,
    });
    expect(sophies).toHaveLength(2);
    await user.click(sophies[0]!);
    await user.keyboard("x");
    await user.keyboard("{Shift>}j{/Shift}");
    await screen.findByText("2 selected");
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await toastText("Merged into Sophie Wagner");
    await waitFor(async () => {
      expect(
        (await names()).filter((name) => name === "Sophie Wagner"),
      ).toHaveLength(1);
    });
  });

  it("imports a vCard file, skipping contacts that are already there", async () => {
    const { user } = renderApp({ hash: CONTACTS });
    await row(/Anna Berger/);
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Anna Berger",
      "N:Berger;Anna;;;",
      "EMAIL:anna.berger@example.org",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Zeno Rauch",
      "N:Rauch;Zeno;;;",
      "EMAIL;TYPE=WORK:zeno@example.com",
      "CATEGORIES:Hiking club",
      "END:VCARD",
      "",
    ].join("\r\n");
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept*=".vcf"]',
    );
    await user.upload(
      input!,
      new File([vcf], "people.vcf", { type: "text/vcard" }),
    );
    const preview = await dialog("Import contacts");
    expect(within(preview).getByText("2 contacts in people.vcf")).toBeVisible();
    expect(
      within(preview).getByText(/1 of them is already in this address book/),
    ).toBeVisible();
    expect(within(preview).getByLabelText("Skip them")).toBeChecked();
    await user.click(within(preview).getByRole("button", { name: "Import 2" }));
    await toastText("Imported 1 contact, 1 skipped");
    expect(await row(/Zeno Rauch/)).toBeInTheDocument();
    await user.click(
      within(sidebar()).getByRole("button", { name: /^Hiking club5/ }),
    );
    expect(await row(/Zeno Rauch/)).toBeInTheDocument();
    await undoToast(user);
    await waitFor(async () => {
      expect(await names()).not.toContain("Zeno Rauch");
    });
  });

  it("exports a contact as a vCard file", async () => {
    const desktop = fakeDesktopPlatform();
    const { user } = renderApp({ hash: CONTACTS, platform: desktop.platform });
    await user.click(await row(/Anna Berger/));
    await contactHeading("Anna Berger");
    await user.click(
      screen.getByRole("button", { name: "More for Anna Berger" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Export as vCard" }),
    );
    await toastText("Exported 1 contact");
    expect(desktop.platform.saveFile).toHaveBeenCalledWith(
      expect.any(Blob),
      "Anna Berger.vcf",
    );
    const [blob] = desktop.platform.saveFile.mock.calls[0] as unknown as [Blob];
    const text = await blob.text();
    expect(text).toMatch(/FN:Anna Berger/);
    expect(text).toMatch(/CATEGORIES:Starred,Work/);
  });

  it("adds a sender to the contacts from the reader, or shows their contact", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "welcome") });
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to the demo",
    });
    await user.click(screen.getByRole("button", { name: "action0" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Add to contacts" }),
    );
    const editor = await dialog("New contact");
    expect(within(editor).getByLabelText("First name")).toHaveValue("action0");
    expect(within(editor).getByRole("textbox", { name: "Email" })).toHaveValue(
      "hello@example.com",
    );
    await user.click(
      within(editor).getAllByRole("button", { name: "Cancel" }).at(-1)!,
    );

    act(() => {
      window.history.replaceState(null, "", `/${demoHash("inbox", "trip-1")}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Trip to Lake Como",
    });
    await user.click(
      within(screen.getByRole("article")).getByRole("button", {
        name: "Anna Berger",
      }),
    );
    // Anna is among the contacts loaded meanwhile.
    await user.click(
      await screen.findByRole("menuitem", { name: "Show contact" }),
    );
    await contactHeading("Anna Berger");
  });

  it("shows one pane at a time on phones", async () => {
    const { user } = renderApp({ hash: CONTACTS, viewport: "narrow" });
    await user.click(await row(/Anna Berger/));
    await contactHeading("Anna Berger");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await row(/Anna Berger/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show address books" }),
    );
    expect(
      await screen.findByRole("button", { name: "Contacts", pressed: true }),
    ).toBeInTheDocument();
  });
});
