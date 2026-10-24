import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSetup } from "../accounts/types";
import { createGoogleAndroidSetup } from "../app/googleSetup";
import { validateMicrosoftClientId } from "../app/microsoftSetup";
import { createDemoData } from "../providers/fake/demoData";
import { createDemoModule } from "../providers/fake/module";
import { fakeAndroidPlatform } from "../test/androidPlatform";
import { demoHash, renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const composer = (name: string | RegExp) =>
  screen.findByRole("dialog", { name }, { timeout: 5000 });
const settings = async (user: ReturnType<typeof renderApp>["user"]) => {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  return screen.findByRole("dialog", { name: "Settings" }, { timeout: 5000 });
};

describe("the Android app", () => {
  it("writes a mail with what another app shares", async () => {
    const android = fakeAndroidPlatform();
    renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    act(() => {
      android.share({
        to: ["anna@example.org"],
        subject: "Photos",
        text: "From the weekend",
        files: [new File(["jpeg"], "lake.jpg", { type: "image/jpeg" })],
      });
    });
    const dialog = await composer("Photos");
    expect(
      within(dialog).getByRole("button", { name: "Remove anna@example.org" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("From the weekend");
    expect(await within(dialog).findByText("lake.jpg")).toBeInTheDocument();
  });

  it("opens the message a notification is about", async () => {
    const android = fakeAndroidPlatform();
    renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    act(() => {
      android.open({
        accountId: "demo:demo@example.com",
        messageId: "invoice",
      });
    });
    expect(await subject("Your invoice 2026-1043")).toBeInTheDocument();
  });

  it("turns the background check on and off with the notifications setting", async () => {
    const android = fakeAndroidPlatform();
    const { user } = renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    const configure = android.platform.mobile.configureBackground;
    await waitFor(() => {
      expect(configure).toHaveBeenLastCalledWith({
        enabled: true,
        texts: {
          newMessages: "{count} new messages",
          noSubject: "(no subject)",
        },
      });
    });
    const dialog = await settings(user);
    const checkbox = within(dialog).getByRole("checkbox", {
      name: /^Notifications for new mail/,
    });
    expect(checkbox).toHaveAccessibleName(/about every 15 minutes/);
    await user.click(checkbox);
    expect(configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("asks once to turn on notifications, in its own words", async () => {
    const android = fakeAndroidPlatform({ notificationsAllowed: false });
    const { user } = renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    expect(
      screen.getByText(
        "Get a notification when new mail arrives while action0 isn't open?",
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Turn on notifications" }),
    );
    expect(android.platform.notifications.request).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Turn on notifications" }),
    ).not.toBeInTheDocument();
  });

  it("says when a newer release is out, and links to it", async () => {
    const url =
      "https://github.com/LaughInJar/action0-mail-client/releases/tag/v0.2.0";
    const android = fakeAndroidPlatform({ release: { version: "0.2.0", url } });
    const { user } = renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    const bar = await screen.findByText(
      "action0 0.2.0 is available for Android.",
    );
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(android.platform.openExternal).toHaveBeenCalledWith(url);
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(bar).not.toBeInTheDocument();
  });

  it("has an App section with the version and update check", async () => {
    const android = fakeAndroidPlatform();
    const { user } = renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    const dialog = await settings(user);
    const app = within(dialog).getByRole("region", { name: "App" });
    expect(app).toHaveTextContent("Version 0.1.0");
    expect(
      within(app).queryByRole("radio", { name: "Quit" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(app).getByRole("button", { name: "Check for updates" }),
    );
    expect(
      await within(app).findByText("action0 is up to date."),
    ).toBeInTheDocument();
  });

  it("shares attachments with other apps", async () => {
    const android = fakeAndroidPlatform();
    const { user } = renderApp({
      platform: android.platform,
      hash: demoHash("inbox", "invoice"),
    });
    await subject("Your invoice 2026-1043");
    await user.click(
      screen.getByRole("button", { name: "Share invoice-2026-1043.pdf" }),
    );
    await waitFor(() => {
      expect(android.platform.mobile.share).toHaveBeenCalledWith(
        expect.any(Blob),
        "invoice-2026-1043.pdf",
      );
    });
  });

  it("lets the system bars follow the theme", async () => {
    const android = fakeAndroidPlatform();
    const { user } = renderApp({ platform: android.platform });
    await subject("Welcome to the demo");
    const setTheme = android.platform.mobile.setTheme;
    await waitFor(() => {
      expect(setTheme).toHaveBeenLastCalledWith(false, expect.any(String));
    });
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => {
      expect(setTheme).toHaveBeenLastCalledWith(true, expect.any(String));
    });
  });

  it("shows the Android checklist for Microsoft", async () => {
    const android = fakeAndroidPlatform();
    const setups = (): ProviderSetup[] => [
      createGoogleAndroidSetup(),
      {
        type: "microsoft",
        current: () => undefined,
        validate: validateMicrosoftClientId,
        apply: () => undefined,
      },
    ];
    const { user } = renderApp({
      signedIn: false,
      platform: android.platform,
      modules: [
        createDemoModule({
          latencyMs: 0,
          data: () => createDemoData(TEST_NOW),
        }),
      ],
      setups,
    });
    await user.click(
      screen.getByRole("button", { name: /^Microsoft.*One-time setup/ }),
    );
    // Entra's Android platform: the package and the signature hash, and the
    // redirect it makes of them.
    expect(screen.getByText("app.action0.mail")).toBeInTheDocument();
    expect(
      screen.getByText("ga0RGNYHvNM5d0SLGQfpQWAPGJ8="),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "msauth://app.action0.mail/ga0RGNYHvNM5d0SLGQfpQWAPGJ8%3D",
      ),
    ).toBeInTheDocument();
  });
});
