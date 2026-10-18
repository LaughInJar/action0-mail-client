import { act, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import type { AppSettings } from "../state/settings";
import { UI_STATE_KEY } from "../state/uiStore";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
// Settings and the composer load on first use.
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const option = (name: RegExp) => screen.findByRole("option", { name });
const wait = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Starts with these settings, as if chosen in an earlier visit. */
function withSettings(settings: Partial<AppSettings>) {
  window.localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({ state: { settings }, version: 1 }),
  );
}

const demoProvider = (services: ReturnType<typeof renderApp>["services"]) =>
  services.registry.list()[0]?.provider as FakeMailProvider;

/** Types into a Tiptap editor (ProseMirror can't be typed into in jsdom). */
function typeInto(element: HTMLElement, text: string) {
  const editor = "editor" in element ? (element.editor as Editor) : undefined;
  act(() => {
    editor?.commands.insertContent(text);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the settings dialog", () => {
  it("opens from the gear and closes with Esc or Back", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await dialog("Settings");
    expect(window.location.hash).toMatch(/[?&]settings$/);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.hash).not.toMatch(/settings/);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await dialog("Settings");
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("applies changes right away and remembers them", async () => {
    const { user, unmount } = renderApp();
    await subject("Welcome to the demo");
    expect(screen.getByRole("listbox", { name: /Messages/ })).toHaveAttribute(
      "data-density",
      "comfortable",
    );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    await user.click(within(settings).getByRole("radio", { name: /Compact/ }));
    expect(screen.getByRole("listbox", { name: /Messages/ })).toHaveAttribute(
      "data-density",
      "compact",
    );

    unmount();
    renderApp();
    await subject("Welcome to the demo");
    expect(screen.getByRole("listbox", { name: /Messages/ })).toHaveAttribute(
      "data-density",
      "compact",
    );
  });
});

describe("reading settings", () => {
  it("marks mail read as soon as it opens", async () => {
    withSettings({ markRead: "immediately" });
    renderApp({ hash: demoHash("inbox", "plain-text") });
    await subject("Packing list for the weekend");
    await waitFor(
      async () => {
        expect(await option(/Packing list/)).not.toHaveTextContent(/^Unread/);
      },
      { timeout: 1000 },
    );
  });

  it("leaves it unread when marking is by hand", async () => {
    withSettings({ markRead: "manual" });
    renderApp({ hash: demoHash("inbox", "plain-text") });
    await subject("Packing list for the weekend");
    await wait(1800);
    expect(await option(/Packing list/)).toHaveTextContent(/^Unread/);
  });

  it("remembers trusted senders for remote images", async () => {
    withSettings({ remoteImages: "trusted" });
    const { user } = renderApp({ hash: demoHash("inbox", "newsletter") });
    await subject("This week in web development");
    expect(
      screen.getByText("Remote images are blocked to protect your privacy."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Always from digest@news.example" }),
    );
    expect(
      screen.queryByText("Remote images are blocked to protect your privacy."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    const trusted = within(settings).getByRole("list", {
      name: "Trusted senders",
    });
    expect(trusted).toHaveTextContent("digest@news.example");
    await user.click(
      within(trusted).getByRole("button", {
        name: "Remove digest@news.example",
      }),
    );
    expect(within(settings).getByText("No trusted senders yet.")).toBeVisible();
  });

  it("can always load remote images", async () => {
    withSettings({ remoteImages: "always" });
    renderApp({ hash: demoHash("inbox", "newsletter") });
    await subject("This week in web development");
    expect(
      screen.queryByText("Remote images are blocked to protect your privacy."),
    ).not.toBeInTheDocument();
  });
});

describe("after archiving", () => {
  it("can open the message above instead", async () => {
    withSettings({ afterRemove: "above" });
    const { user } = renderApp({ hash: demoHash("inbox", "inline-image") });
    await subject("New logo draft");
    await user.keyboard("a");
    expect(await subject("This week in web development")).toBeInTheDocument();
  });

  it("can go back to the list; j continues from there", async () => {
    withSettings({ afterRemove: "list" });
    const { user } = renderApp({ hash: demoHash("inbox", "newsletter") });
    await subject("This week in web development");
    await user.keyboard("a");
    expect(await screen.findByText("No message selected")).toBeInTheDocument();
    expect(window.location.hash).toBe(demoHash("inbox"));
    await user.keyboard("j");
    expect(await subject("New logo draft")).toBeInTheDocument();
  });
});

describe("writing settings", () => {
  it("sends right away when undo send is off", async () => {
    withSettings({ undoSendSeconds: 0 });
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    await dialog("New message");
    await user.type(
      screen.getByRole("combobox", { name: "To" }),
      "anna@example.org,",
    );
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Now");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await toastText("Message sent")).toBeInTheDocument();
    expect(screen.queryByText(/Sending “Now” in/)).not.toBeInTheDocument();
  });
});

describe("notifications", () => {
  const FakeNotification = {
    permission: "default" as NotificationPermission,
    requestPermission: vi.fn(() => {
      FakeNotification.permission = "granted";
      return Promise.resolve<NotificationPermission>("granted");
    }),
  };

  it("turned off, never asks; turned on in Settings, asks the browser", async () => {
    FakeNotification.permission = "default";
    vi.stubGlobal("Notification", FakeNotification);
    withSettings({ notifications: false });
    const { user } = renderApp();
    await subject("Welcome to the demo");
    expect(
      screen.queryByRole("button", { name: "Turn on notifications" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    const checkbox = within(settings).getByRole("checkbox", {
      name: /Desktop notifications/,
    });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    await waitFor(() => {
      expect(checkbox).toBeChecked();
    });
  });
});

describe("signatures", () => {
  const signature = (name: string) =>
    screen.findByRole("textbox", { name }, { timeout: 5000 });

  it("are edited in Settings and saved to the account", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    const demo = await signature("Signature for demo@example.com");
    await signature("Signature for team@example.com");
    // Only the team signature has formatting the editor would drop.
    expect(
      within(settings).getAllByText(/formatting the editor can’t keep/),
    ).toHaveLength(1);

    typeInto(demo, "Cheers, ");
    expect(
      await within(settings).findByText("Saved", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    const [saved] = await demoProvider(services).listSenders();
    expect(saved?.signature).toContain("Cheers, Demo User");
  });

  it("offer to allow editing when the permission is missing", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const provider = demoProvider(services);
    provider.signaturesReadOnly = true;
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await dialog("Settings");
    typeInto(await signature("Signature for demo@example.com"), "Hi ");
    const problem = await within(settings).findByRole(
      "alert",
      {},
      { timeout: 3000 },
    );
    expect(problem).toHaveTextContent("Not saved");

    // The user grants it in the sign-in popup.
    provider.signaturesReadOnly = false;
    await user.click(
      within(problem).getByRole("button", { name: "Allow editing" }),
    );
    expect(
      await within(settings).findByText("Saved", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect((await provider.listSenders())[0]?.signature).toContain("Hi ");
  });

  it("go into mail, follow From, and can be removed", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("c");
    const compose = await dialog("New message");
    const frame = await within(compose).findByTitle("Signature");
    expect(frame.getAttribute("srcdoc")).toContain("Demo User");

    const from = within(compose).getByRole("combobox", { name: "From" });
    // The addresses arrive a moment after the composer opens.
    const team = await within(from).findByRole("option", {
      name: "Demo Team <team@example.com>",
    });
    await user.selectOptions(from, team);
    await waitFor(() => {
      expect(
        within(compose).getByTitle("Signature").getAttribute("srcdoc"),
      ).toContain("Questions? Just reply");
    });

    await user.click(
      within(compose).getByRole("button", { name: "Remove the signature" }),
    );
    expect(within(compose).queryByTitle("Signature")).not.toBeInTheDocument();
    await user.selectOptions(
      from,
      within(from).getByRole("option", {
        name: "Demo User <demo@example.com>",
      }),
    );
    expect(within(compose).queryByTitle("Signature")).not.toBeInTheDocument();
  });

  it("answer from the address the mail was sent to", async () => {
    withSettings({ undoSendSeconds: 0 });
    const { user } = renderApp({ hash: demoHash("inbox", "wide") });
    await subject("Client project overview");
    await user.keyboard("r");
    const compose = await dialog(/Client project overview/);
    expect(
      within(compose).getByRole("combobox", { name: "From" }),
    ).toHaveDisplayValue("Demo Team <team@example.com>");
    await user.click(within(compose).getByRole("button", { name: /^Send/ }));
    expect(await toastText("Message sent")).toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: /^Sent/ }));
    await user.click(await option(/Re: Client project overview/));
    await subject("Re: Client project overview");
    expect(screen.getByRole("article")).toHaveTextContent(
      "Demo Teamteam@example.com",
    );
  });
});
