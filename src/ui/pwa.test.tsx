import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../lib/emitter";
import type { Pwa } from "../platform/pwa";
import type { PwaControls } from "../platform/types";
import { createWebPlatform } from "../platform/web";
import { renderApp } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });

/** A web platform with the installable app, whose state the test sets. */
function installable(
  state: {
    updateReady?: boolean;
    canInstall?: boolean;
    installed?: boolean;
    steps?: "ios" | "macSafari";
  } = {},
) {
  const emitter = new Emitter();
  const current = {
    updateReady: false,
    canInstall: false,
    installed: false,
    ...state,
  };
  const controls: PwaControls = {
    installed: () => current.installed,
    canInstall: () => current.canInstall,
    install: vi.fn(() => Promise.resolve(true)),
    installSteps: () => state.steps,
    emailLinks: { supported: true, register: vi.fn() },
    updateReady: () => current.updateReady,
    reload: vi.fn(),
    subscribe: (listener) => emitter.subscribe(listener),
  };
  const pwa: Pwa = {
    controls,
    controlled: () => false,
    registration: () => new Promise(() => undefined),
    onMessage: () => () => undefined,
    takeShare: () => Promise.resolve(null),
  };
  const set = (changes: Partial<typeof current>) => {
    Object.assign(current, changes);
    act(() => {
      emitter.emit();
    });
  };
  return { platform: createWebPlatform(pwa), controls, set };
}

describe("the installable web app", () => {
  it("offers a new version with Reload", async () => {
    const app = installable();
    const { user } = renderApp({ platform: app.platform });
    await subject("Welcome to the demo");
    expect(
      screen.queryByText("A new version of action0 is ready."),
    ).not.toBeInTheDocument();
    app.set({ updateReady: true });
    const text = await screen.findByText("A new version of action0 is ready.");
    const bar = text.closest<HTMLElement>("[role=status]")!;
    await user.click(within(bar).getByRole("button", { name: "Reload" }));
    expect(app.controls.reload).toHaveBeenCalled();
  });

  it("offers installing once on phones", async () => {
    const app = installable({ canInstall: true });
    const { user } = renderApp({ platform: app.platform, viewport: "narrow" });
    const offer = await screen.findByText(
      "Install action0 for a home screen icon and notifications of new mail.",
    );
    await user.click(
      within(offer.closest("[role=status]")!).getByRole("button", {
        name: "Install",
      }),
    );
    expect(app.controls.install).toHaveBeenCalled();
    expect(
      screen.queryByText(
        "Install action0 for a home screen icon and notifications of new mail.",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows Safari's steps on iPhones, and nothing on wide screens", async () => {
    const phone = installable({ steps: "ios" });
    const first = renderApp({ platform: phone.platform, viewport: "narrow" });
    expect(
      await screen.findByText(
        "In Safari, tap Share (the square with the arrow), then “Add to Home Screen”.",
      ),
    ).toBeInTheDocument();
    await first.user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/Add to Home Screen/)).not.toBeInTheDocument();
    first.unmount();

    renderApp({ platform: installable({ canInstall: true }).platform });
    await subject("Welcome to the demo");
    expect(
      screen.queryByText(/Install action0 for a home screen icon/),
    ).not.toBeInTheDocument();
  });

  it("can be installed and handle email links from Settings → App", async () => {
    const app = installable({ canInstall: true });
    const { user } = renderApp({ platform: app.platform });
    await subject("Welcome to the demo");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole(
      "dialog",
      { name: "Settings" },
      { timeout: 5000 },
    );
    const section = within(settings).getByRole("region", { name: "App" });
    await user.click(within(section).getByRole("button", { name: "Install" }));
    expect(app.controls.install).toHaveBeenCalled();
    await user.click(
      within(section).getByRole("button", {
        name: "Use action0 for email links",
      }),
    );
    expect(app.controls.emailLinks.register).toHaveBeenCalled();
    expect(
      within(section).getByText(
        "Your browser asked whether to use action0 for email links.",
      ),
    ).toBeInTheDocument();
    app.set({ installed: true });
    expect(
      await within(section).findByText("action0 is installed on this device."),
    ).toBeInTheDocument();
  });
});
