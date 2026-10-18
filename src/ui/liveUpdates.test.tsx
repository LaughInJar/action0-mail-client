import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoArrival, createDemoData } from "../providers/fake/demoData";
import { createDemoModule } from "../providers/fake/module";
import { renderApp, TEST_NOW } from "../test/renderApp";

vi.setConfig({ testTimeout: 15_000 });

let clock = TEST_NOW;

/** The demo with mail arriving every minute of the test clock. */
function renderLive(options: Parameters<typeof renderApp>[0] = {}) {
  clock = TEST_NOW;
  return renderApp({
    ...options,
    modules: [
      createDemoModule({
        latencyMs: 0,
        data: () => createDemoData(TEST_NOW),
        arrivalEveryMs: 60_000,
        now: () => clock,
      }),
    ],
  });
}

/** Lets a minute pass and checks right away (as when the network returns). */
function nextArrival() {
  clock += 61_000;
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  return createDemoArrival(clock, 0);
}

const subject = (name: string) =>
  screen.findByRole("heading", { level: 1, name });

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(() =>
    Promise.resolve<NotificationPermission>("granted"),
  );
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  readonly title: string;
  readonly options: NotificationOptions | undefined;
  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.shown.push(this);
  }
  close() {
    return undefined;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeNotification.shown = [];
  FakeNotification.permission = "granted";
  delete (document as { hidden?: boolean }).hidden;
});

describe("live updates", () => {
  it("shows new mail and keeps the unread count in the title", async () => {
    renderLive();
    await subject("Welcome to the demo");
    // 17 once the welcome mail has been on screen long enough to count as read.
    await waitFor(
      () => {
        expect(document.title).toBe("(17) action0");
      },
      { timeout: 3000 },
    );
    nextArrival();
    await waitFor(() => {
      expect(document.title).toBe("(18) action0");
    });
    const [first] = screen.getAllByRole("option");
    expect(first).toHaveTextContent(/^Unread/);
    // The cursor stays where it was.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Welcome to the demo",
    );
  });

  it("notifies while the app is in the background; a click opens the mail", async () => {
    vi.stubGlobal("Notification", FakeNotification);
    renderLive();
    await subject("Welcome to the demo");
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    nextArrival();
    await waitFor(() => {
      expect(FakeNotification.shown).toHaveLength(1);
    });
    const [shown] = FakeNotification.shown;
    expect(shown?.options?.tag).toMatch(/^a0-arrival-/);
    act(() => {
      shown?.onclick?.();
    });
    await waitFor(() => {
      expect(window.location.hash).toMatch(/\/inbox\/arrival-/);
    });
  });

  it("doesn't notify while the app is in front", async () => {
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    renderLive();
    await subject("Welcome to the demo");
    nextArrival();
    await waitFor(() => {
      expect(screen.getAllByRole("option")[0]).toHaveTextContent(/^Unread/);
    });
    expect(FakeNotification.shown).toEqual([]);
  });

  it("asks once about notifications", async () => {
    FakeNotification.permission = "default";
    vi.stubGlobal("Notification", FakeNotification);
    const { user, unmount } = renderLive();
    await subject("Welcome to the demo");
    await user.click(
      screen.getByRole("button", { name: "Turn on notifications" }),
    );
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Turn on notifications" }),
    ).not.toBeInTheDocument();
    unmount();
    renderLive();
    await subject("Welcome to the demo");
    expect(
      screen.queryByRole("button", { name: "Turn on notifications" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the view still when scrolled down, and offers the new mail", async () => {
    // jsdom has no layout: rows are 60px each.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.messageId ? 60 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
      function (this: HTMLElement) {
        if (!this.dataset.messageId || !this.parentElement) return 0;
        return Array.from(this.parentElement.children).indexOf(this) * 60;
      },
    );
    const { user } = renderLive();
    await subject("Welcome to the demo");
    const list = screen.getByRole("listbox");
    act(() => {
      list.scrollTop = 600;
      list.dispatchEvent(new Event("scroll"));
    });
    nextArrival();
    const button = await screen.findByRole("button", {
      name: "↑ 1 new message",
    });
    // One row came in above: the visible rows didn't move.
    expect(list.scrollTop).toBe(660);
    await user.click(button);
    expect(list.scrollTop).toBe(0);
    expect(
      screen.queryByRole("button", { name: /new message/ }),
    ).not.toBeInTheDocument();
  });
});
