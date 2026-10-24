import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import type { ProviderModule, ProviderSetup } from "../accounts/types";
import {
  validateGoogleClientId,
  validateGoogleClientSecret,
} from "../app/googleSetup";
import { StaticAuthSession } from "../auth/staticSession";
import { asAccountId } from "../core/ids";
import { createDemoData } from "../providers/fake/demoData";
import { FakeMailProvider } from "../providers/fake/FakeMailProvider";
import { createDemoModule } from "../providers/fake/module";
import { fakeDesktopPlatform } from "../test/desktopPlatform";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const composer = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });

describe("the desktop app", () => {
  it("writes a mail for mailto: links, from the account that sent last", async () => {
    const desktop = fakeDesktopPlatform();
    renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    act(() => {
      desktop.compose(
        "mailto:anna@example.org?cc=mia@example.com&subject=Lunch%3F&body=Tomorrow%20at%2012",
      );
    });
    // The composer is named after its subject.
    const dialog = await composer("Lunch?");
    expect(
      within(dialog).getByRole("button", { name: "Remove anna@example.org" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Remove mia@example.com" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue(
      "Lunch?",
    );
    expect(dialog).toHaveTextContent("Tomorrow at 12");
  });

  it("shows the unread count on its icons", async () => {
    const desktop = fakeDesktopPlatform();
    renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    await waitFor(() => {
      expect(desktop.platform.setUnreadCount).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.stringMatching(/^action0: \d+ unread$/),
      );
    });
  });

  it("saves attachments with the system's dialog", async () => {
    const desktop = fakeDesktopPlatform();
    const { user } = renderApp({
      platform: desktop.platform,
      hash: demoHash("inbox", "photos"),
    });
    await subject("Photos from the hike");
    await user.click(
      screen.getByRole("button", { name: "Download route.html" }),
    );
    await waitFor(() => {
      expect(desktop.platform.saveFile).toHaveBeenCalledWith(
        expect.any(Blob),
        "route.html",
      );
    });
  });

  it("has its own settings: the tray, autostart, the default mail app, updates", async () => {
    const desktop = fakeDesktopPlatform();
    const { user } = renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    expect(desktop.platform.desktop.configure).toHaveBeenLastCalledWith({
      closeToTray: true,
      texts: {
        show: "Show action0",
        compose: "New mail",
        quit: "Quit action0",
      },
    });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole(
      "dialog",
      { name: "Settings" },
      { timeout: 5000 },
    );
    const app = within(dialog).getByRole("region", { name: "App" });

    await user.click(within(app).getByRole("radio", { name: "Quit" }));
    expect(desktop.platform.desktop.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ closeToTray: false }),
    );
    const autostart = within(app).getByRole("checkbox", {
      name: /Start with the system/,
    });
    await waitFor(() => {
      expect(autostart).toBeEnabled();
    });
    await user.click(autostart);
    expect(desktop.platform.desktop.autostart.set).toHaveBeenCalledWith(true);

    await user.click(
      within(app).getByRole("button", {
        name: "Make action0 the default mail app",
      }),
    );
    expect(
      await within(app).findByText("action0 is now your default mail app."),
    ).toBeInTheDocument();

    expect(app).toHaveTextContent("Version 0.1.0");
    await user.click(
      within(app).getByRole("button", { name: "Check for updates" }),
    );
    expect(
      await within(app).findByText("action0 is up to date."),
    ).toBeInTheDocument();
  });

  it("says when accounts stay signed in only until quitting (no keychain)", async () => {
    const desktop = fakeDesktopPlatform({ keychain: false });
    const { user } = renderApp({ platform: desktop.platform, signedIn: false });
    await user.click(
      await screen.findByRole("button", { name: /^Demo account/ }),
    );
    expect(
      await screen.findByText("Connected demo@example.com (until you quit)", {
        selector: "div[aria-live] span",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole(
      "dialog",
      { name: "Settings" },
      { timeout: 5000 },
    );
    const app = within(dialog).getByRole("region", { name: "App" });
    expect(within(app).getByRole("note")).toHaveTextContent(
      /No system keychain was found/,
    );
  });

  it("says nothing about the keychain when there is one", async () => {
    const desktop = fakeDesktopPlatform();
    const { user } = renderApp({ platform: desktop.platform, signedIn: false });
    await user.click(
      await screen.findByRole("button", { name: /^Demo account/ }),
    );
    expect(
      await screen.findByText("Connected demo@example.com", {
        selector: "div[aria-live] span",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole(
      "dialog",
      { name: "Settings" },
      { timeout: 5000 },
    );
    expect(
      within(within(dialog).getByRole("region", { name: "App" })).queryByRole(
        "note",
      ),
    ).not.toBeInTheDocument();
  });

  it("offers a newer version and installs it on request", async () => {
    const desktop = fakeDesktopPlatform();
    const install = vi.fn(() => Promise.resolve());
    desktop.platform.desktop.checkForUpdate.mockResolvedValue({
      version: "0.2.0",
      install,
    } as never);
    const { user } = renderApp({ platform: desktop.platform });
    expect(
      await screen.findByText("action0 0.2.0 is available."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Install and restart" }),
    );
    expect(install).toHaveBeenCalled();
  });

  it("says once that closing keeps it running in the tray", async () => {
    const desktop = fakeDesktopPlatform();
    renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    act(() => {
      desktop.closeToTray();
      desktop.closeToTray();
    });
    expect(desktop.platform.notifications.show).toHaveBeenCalledTimes(1);
    expect(desktop.platform.notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "action0 is still running" }),
    );
  });

  it("quits with Ctrl+Q, and checks for mail when the tray asks", async () => {
    const desktop = fakeDesktopPlatform();
    const { user, services } = renderApp({ platform: desktop.platform });
    await subject("Welcome to the demo");
    await user.keyboard("{Control>}q{/Control}");
    expect(desktop.platform.desktop.quit).toHaveBeenCalled();

    const provider = services.registry.list()[0]?.provider;
    if (!provider) throw new Error("No account");
    const changes = vi.spyOn(provider, "changesSince");
    act(() => {
      desktop.poll();
    });
    await waitFor(() => {
      expect(changes).toHaveBeenCalled();
    });
  });
});

describe("setting Google up in the desktop app", () => {
  it("asks for the desktop client's ID and secret", async () => {
    const desktop = fakeDesktopPlatform();
    let stored: { value: string; secret: string } | undefined;
    const module: ProviderModule = {
      type: "gmail",
      label: "Google",
      connect: () =>
        Promise.resolve({
          account: {
            id: asAccountId("gmail:jane@example.com"),
            type: "gmail",
            email: "jane@example.com",
          },
          auth: new StaticAuthSession(),
        }),
      restore: () => new StaticAuthSession(),
      createProvider: () => new FakeMailProvider(createDemoData(TEST_NOW)),
    };
    const setups = (registry: AccountRegistry): ProviderSetup[] => [
      {
        type: "gmail",
        current: () => stored && { ...stored, source: "browser" },
        validate: validateGoogleClientId,
        secret: { validate: validateGoogleClientSecret },
        apply: (value, secret = "") => {
          stored = { value, secret };
          registry.registerModule(module);
        },
      },
    ];
    const { user } = renderApp({
      signedIn: false,
      platform: desktop.platform,
      modules: [
        createDemoModule({
          latencyMs: 0,
          data: () => createDemoData(TEST_NOW),
        }),
      ],
      setups,
    });
    await user.click(
      screen.getByRole("button", { name: /^Google.*One-time setup/ }),
    );
    // The desktop checklist: a "Desktop app" client, no web origin.
    expect(screen.getByText(/Desktop app/)).toBeInTheDocument();
    expect(screen.queryByText(window.location.origin)).not.toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Client ID"),
      "424727749781-abcdef.apps.googleusercontent.com",
    );
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/client secret too/);
    await user.type(
      screen.getByLabelText("Client secret"),
      "GOCSPX-a1b2c3d4e5f6",
    );
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(
      await screen.findByRole("heading", { name: "Connect Google" }),
    ).toBeInTheDocument();
    expect(stored).toEqual({
      value: "424727749781-abcdef.apps.googleusercontent.com",
      secret: "GOCSPX-a1b2c3d4e5f6",
    });
    expect(screen.getByText(/Your browser opens Google/)).toBeInTheDocument();
  });
});
