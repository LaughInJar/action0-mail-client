import { act, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import type { MailTemplate } from "../compose/templates";
import { asAccountId } from "../core/ids";
import { DEMO_WORK_ACCOUNT } from "../providers/fake/module";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

type User = ReturnType<typeof renderApp>["user"];
type Services = ReturnType<typeof renderApp>["services"];

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const body = () => document.getElementById("composer-body");

/** Writes into a Tiptap editor (jsdom can't type into it). */
function write(element: Element | null, text: string) {
  const editor =
    element && "editor" in element ? (element.editor as Editor) : undefined;
  act(() => {
    editor?.commands.insertContent(text);
  });
}

const THANKS: MailTemplate = {
  id: "t1",
  name: "Thanks",
  subject: "Thank you",
  html: "<p>Hi {first name}, thanks!</p>",
};
const OFFER: MailTemplate = {
  id: "t2",
  name: "Work offer",
  subject: "",
  html: "<p>Our offer, {name}</p>",
  accountId: asAccountId(DEMO_WORK_ACCOUNT.id),
};

function useTemplates(services: Services, templates: MailTemplate[]) {
  act(() => {
    services.uiStore.getState().updateSettings({ templates });
  });
}

async function openPicker(user: User) {
  await user.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
  return dialog("Templates");
}

describe("templates", () => {
  it("are made in Settings, and deleted with undo", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    await user.click(
      within(settings).getByRole("button", { name: "New template" }),
    );
    const editor = await dialog("New template");
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Give the template a name.",
    );
    await user.type(within(editor).getByLabelText("Name"), "Thanks");
    await user.type(within(editor).getByLabelText("Subject"), "Thank you");
    write(
      within(editor).getByRole("textbox", { name: "Text" }),
      "Hi {first name}",
    );
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New template" })).toBeNull();
    });
    expect(services.uiStore.getState().settings.templates).toMatchObject([
      { name: "Thanks", subject: "Thank you" },
    ]);
    const row = within(settings).getByRole("listitem", { name: "Thanks" });
    await user.click(
      within(row).getByRole("button", { name: "Delete: Thanks" }),
    );
    const toast = await toastText("Deleted the template “Thanks”");
    expect(services.uiStore.getState().settings.templates).toEqual([]);
    await user.click(
      within(toast.parentElement!).getByRole("button", { name: /Undo/ }),
    );
    await waitFor(() => {
      expect(services.uiStore.getState().settings.templates).toHaveLength(1);
    });
  });

  it("go into a reply at the cursor with the recipient's first name, keeping its subject", async () => {
    const { user, services } = renderApp({ hash: demoHash("inbox", "trip-1") });
    await subject("Trip to Lake Como");
    useTemplates(services, [THANKS]);
    await user.keyboard("r");
    await dialog("Re: Trip to Lake Como");
    // jsdom puts no focus into the editor: from the subject field.
    await user.click(screen.getByRole("textbox", { name: "Subject" }));
    const picker = await openPicker(user);
    await user.keyboard("thank");
    expect(
      within(picker).getByRole("option", { name: /Thanks/ }),
    ).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(body()?.textContent).toContain("Hi Anna, thanks!");
    });
    expect(screen.queryByRole("dialog", { name: "Templates" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue(
      "Re: Trip to Lake Como",
    );
  });

  it("fill an empty subject, and are saved from what's written", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    useTemplates(services, [THANKS]);
    await user.keyboard("c");
    const composer = await dialog("New message");
    await user.click(
      within(composer).getByRole("button", {
        name: "Insert a template (Ctrl+Shift+T)",
      }),
    );
    const picker = await dialog("Templates");
    await user.click(within(picker).getByRole("option", { name: /Thanks/ }));
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue(
      "Thank you",
    );
    // No recipient: the placeholder stays empty.
    expect(body()?.textContent).toContain("Hi , thanks!");

    write(body(), " See you soon.");
    await openPicker(user);
    await user.click(screen.getByRole("button", { name: "Save as template…" }));
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "See you");
    await user.keyboard("{Enter}");
    await toastText("Saved the template “See you”");
    expect(services.uiStore.getState().settings.templates).toMatchObject([
      { name: "Thanks" },
      { name: "See you", subject: "Thank you" },
    ]);
  });

  it("offer an account's own templates only in its mail", async () => {
    const { user, services } = renderApp({ workAccount: true });
    await subject("Welcome to the demo");
    useTemplates(services, [THANKS, OFFER]);
    act(() => {
      services.uiStore
        .getState()
        .updateSettings({ lastSendAccount: "demo:demo@example.com" });
    });
    await user.keyboard("c");
    await dialog("New message");
    const picker = await openPicker(user);
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["ThanksThank you"]);
  });
});
