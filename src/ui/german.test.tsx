import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFolderData } from "../test/folderData";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
// Settings and the composer load on first use.
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });

/** A browser set to Austrian German. */
beforeEach(() => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-AT", "de"]);
  vi.spyOn(navigator, "language", "get").mockReturnValue("de-AT");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the German interface", () => {
  it("follows the browser: tree, buttons and the page language", async () => {
    renderApp();
    await subject("Welcome to the demo");
    const tree = screen.getByRole("tree", { name: "Konten und Postfächer" });
    for (const name of ["Posteingang", "Gesendet", "Entwürfe", "Papierkorb"])
      expect(
        within(tree).getByRole("treeitem", { name: new RegExp(`^${name}`) }),
      ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Schreiben/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Archivieren (a)" }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("de");
  });

  it("says what happened in German, and undoes it", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("a");
    expect(await toastText("1 Nachricht archiviert")).toBeInTheDocument();
    await user.keyboard("z");
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Welcome to the demo/ }),
      ).toBeInTheDocument();
    });
  });

  it("names keys the German way in the shortcut help", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.keyboard("?");
    const help = await dialog("Tastenkürzel");
    expect(help).toHaveTextContent("Umschalt+Entf");
    expect(help).toHaveTextContent("g dann i");
    expect(help).toHaveTextContent("Eingabe");
    expect(help).toHaveTextContent("Archivieren");
  });

  it("quotes replies with a German line", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "welcome") });
    await subject("Welcome to the demo");
    await user.keyboard("r");
    const composer = await dialog(/Re: Welcome to the demo/);
    await user.click(
      within(composer).getByRole("button", {
        name: "Zitierten Text einblenden",
      }),
    );
    const quote = within(composer).getByTitle("Der zitierte Text");
    expect(quote.getAttribute("srcdoc")).toMatch(
      /Am 18\.10\.2026 um \d\d:\d\d schrieb action0 &lt;hello@example\.com&gt;:/,
    );
  });

  it("switches to English in Settings", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Einstellungen" }));
    const settings = await dialog("Einstellungen");
    const language = within(settings).getByRole("group", { name: "Sprache" });
    expect(
      within(language).getByRole("radio", { name: /Automatisch/ }),
    ).toBeChecked();
    expect(language).toHaveTextContent("Wie dein Browser: Deutsch");

    await user.click(within(language).getByRole("radio", { name: "English" }));
    expect(await dialog("Settings")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(
      screen.getByRole("tree", { name: "Accounts and mailboxes" }),
    ).toBeInTheDocument();
  });
});

describe("the German interface with an Outlook account", () => {
  it("uses Outlook's German folder names and folder wording", async () => {
    renderApp({ data: () => createFolderData(TEST_NOW) });
    await subject("Quarterly numbers");
    const tree = screen.getByRole("tree", { name: "Konten und Postfächer" });
    for (const name of [
      "Posteingang",
      "Gesendete Elemente",
      "Junk-E-Mail",
      "Gelöschte Elemente",
      "Gekennzeichnet",
    ])
      expect(
        within(tree).getByRole("treeitem", { name: new RegExp(`^${name}`) }),
      ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Neuer Ordner" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Ordner verwalten" }),
    ).toBeInTheDocument();
  });
});

describe("the German calendar", () => {
  it("speaks German: switch, views, week number, answers", async () => {
    const { user } = renderApp({ hash: "#/calendar/week/2026-10-15" });
    expect(
      await screen.findByRole("main", { name: "Kalender" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Woche", pressed: true }),
    ).toBeInTheDocument();
    // Austrian weeks start on Monday.
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /12\.\s*–\s*18\. Okt\. 2026\s*KW 42/,
      }),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: /^Team meeting/ }),
    );
    const event = await screen.findByRole("article", { name: "Team meeting" });
    const answers = within(event).getByRole("group", { name: "Teilnehmen?" });
    await user.click(within(answers).getByRole("button", { name: "Nein" }));
    expect(await toastText("„Team meeting“ abgesagt")).toBeInTheDocument();
  });

  it("writes new events in German", async () => {
    const { user } = renderApp({ hash: "#/calendar/week/2026-10-15" });
    await user.click(
      await screen.findByRole("button", { name: /^Neuer Termin/ }),
    );
    const form = await screen.findByRole("region", { name: "Neuer Termin" });
    expect(within(form).getByLabelText("Anfangsdatum")).toHaveValue(
      "2026-10-15",
    );
    expect(within(form).getByLabelText("Wiederholen")).toHaveDisplayValue(
      "Keine Wiederholung",
    );
    expect(
      within(form).getByRole("option", { name: "Wöchentlich am Donnerstag" }),
    ).toBeInTheDocument();
    expect(
      within(form).getByRole("checkbox", {
        name: "Google-Meet-Videokonferenz hinzufügen",
      }),
    ).toBeInTheDocument();
    await user.keyboard("Zahnarzt{Control>}{Enter}{/Control}");
    expect(await toastText("„Zahnarzt“ erstellt")).toBeInTheDocument();
  });
});
