import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoHash, renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

type User = ReturnType<typeof renderApp>["user"];

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const dialog = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const toastText = (text: string | RegExp) =>
  screen.findByText(text, { selector: "div[aria-live] span" });
const palette = () => dialog("Command palette");
function noPalette() {
  expect(
    screen.queryByRole("dialog", {
      name: /^(Command palette|Befehlspalette)$/,
    }),
  ).toBeNull();
}
/** The option the cursor is on. */
const selected = (box: HTMLElement) =>
  within(box)
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-selected") === "true");

async function open(user: User) {
  await user.keyboard("{Control>}k{/Control}");
  return palette();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the command palette", () => {
  it("opens with Ctrl+K and goes to a mailbox, remembering it", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const box = await open(user);
    await user.keyboard("sent");
    expect(selected(box)).toHaveTextContent(/^Sent/);
    await user.keyboard("{Enter}");
    noPalette();
    await waitFor(() => {
      expect(services.router.getRoute()?.mailboxId).toBe("sent");
    });
    expect(services.uiStore.getState().settings.paletteRecent).toEqual([
      "mailbox:demo:demo@example.com:sent",
    ]);

    // An empty field lists the recent choices first.
    const again = await open(user);
    const recent = within(again).getByRole("group", { name: "Recent" });
    expect(within(recent).getAllByRole("option")).toHaveLength(1);
    expect(selected(again)).toHaveTextContent(/^Sent/);
    await user.keyboard("{Escape}");
    noPalette();
  });

  it("runs an action that applies, with its shortcut shown", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "trip-1") });
    await subject("Trip to Lake Como");
    const box = await open(user);
    // "Archive" the action before the label "Archive 2019".
    await user.keyboard("archive");
    const groups = within(box).getAllByRole("group");
    expect(groups[0]).toHaveAccessibleName("Actions");
    expect(selected(box)).toHaveTextContent(/^Archivea$/);
    await user.keyboard("{Enter}");
    expect(await toastText("Archived 1 message")).toBeInTheDocument();
  });

  it("leaves out actions that don't apply", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    // The mail's actions are gone in the calendar.
    await user.keyboard("gc");
    await waitFor(() => {
      expect(services.router.part()).toBe("calendar");
    });
    const box = await open(user);
    await user.keyboard("reply");
    expect(within(box).queryByRole("group", { name: "Actions" })).toBeNull();
  });

  it("searches mail everywhere for what's typed", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    const box = await open(user);
    await user.keyboard("lake como");
    expect(selected(box)).toHaveTextContent("Search mail for “lake como”");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(services.router.getRoute()?.search).toEqual({
        text: "lake como",
        everywhere: true,
      });
    });
    expect(services.uiStore.getState().settings.paletteRecent).toEqual([]);
  });

  it("switches the theme and opens Settings sections", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await open(user);
    await user.keyboard("dark{Enter}");
    expect(services.uiStore.getState().theme).toBe("dark");
    await open(user);
    await user.keyboard("writing{Enter}");
    expect(await dialog("Settings")).toBeInTheDocument();
  });

  it("goes to the calendar", async () => {
    const { user, services } = renderApp();
    await subject("Welcome to the demo");
    await open(user);
    await user.keyboard("month view{Enter}");
    await waitFor(() => {
      expect(services.router.getCalendarRoute()?.view).toBe("month");
    });
  });

  it("opens from text fields, but not in the composer", async () => {
    const { user } = renderApp();
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("searchbox", { name: /Search/ }));
    await open(user);
    await user.keyboard("{Control>}k{/Control}");
    noPalette();

    await user.click(screen.getByRole("button", { name: /Compose/ }));
    await dialog("New message");
    await user.click(screen.getByRole("textbox", { name: "Subject" }));
    await user.keyboard("{Control>}k{/Control}");
    noPalette();
  });

  it("is listed in the shortcut help (its palette-only actions aren't)", async () => {
    const { user } = renderApp({ hash: demoHash("inbox", "trip-1") });
    await subject("Trip to Lake Como");
    await user.keyboard("?");
    const help = await dialog("Keyboard shortcuts");
    expect(
      within(help).getByText("Command palette: go to, do or search"),
    ).toBeInTheDocument();
    expect(within(help).queryByText("Filter mail like this")).toBeNull();
  });

  it("has a button in the column's header on phones, and works in German", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-AT", "de"]);
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-AT");
    const { user, services } = renderApp({ viewport: "narrow" });
    await screen.findByRole("option", { name: /Welcome to the demo/ });
    await user.click(screen.getByRole("button", { name: "Ordner anzeigen" }));
    await user.click(
      await screen.findByRole("button", { name: "Befehlspalette (Strg+K)" }),
    );
    const box = await dialog("Befehlspalette");
    await user.keyboard("posteing");
    expect(selected(box)).toHaveTextContent(/^Posteingang/);
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(services.router.getRoute()?.mailboxId).toBe("inbox");
    });
    noPalette();
  });
});
