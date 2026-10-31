import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pwa } from "./pwa";
import type { PwaControls } from "./types";
import { createWebPlatform } from "./web";

function fakePwa(options: { controlled?: boolean } = {}) {
  const listeners = new Set<(data: unknown) => void>();
  const showNotification = vi.fn(() => Promise.resolve());
  const controls: PwaControls = {
    installed: () => false,
    canInstall: () => false,
    install: () => Promise.resolve(false),
    installSteps: () => undefined,
    emailLinks: { supported: true, register: vi.fn() },
    updateReady: () => false,
    reload: vi.fn(),
    subscribe: () => () => undefined,
  };
  const pwa: Pwa = {
    controls,
    controlled: () => options.controlled ?? true,
    registration: () =>
      Promise.resolve({
        showNotification,
      } as unknown as ServiceWorkerRegistration),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    takeShare: vi.fn((id: string) =>
      Promise.resolve(
        id === "s1"
          ? {
              title: "Trip",
              text: "See this",
              url: "https://example.org/x",
              files: [new File(["pdf"], "plan.pdf")],
            }
          : null,
      ),
    ),
  };
  const post = (data: unknown) => {
    for (const listener of listeners) listener(data);
  };
  return { pwa, showNotification, post };
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("the web platform with the installable app", () => {
  it("writes a mail for an email link once, and takes it out of the address", async () => {
    window.history.replaceState(
      null,
      "",
      "/?mailto=mailto%3Aanna%40example.org#/x",
    );
    const platform = createWebPlatform(fakePwa().pwa);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/x");
    const listener = vi.fn();
    platform.onCompose(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith("mailto:anna@example.org");
    const again = vi.fn();
    platform.onCompose(again);
    await Promise.resolve();
    expect(again).not.toHaveBeenCalled();
  });

  it("starts an empty mail for the New mail shortcut", async () => {
    window.history.replaceState(null, "", "/?compose");
    const listener = vi.fn();
    createWebPlatform(fakePwa().pwa).onCompose(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith("");
  });

  it("hands shared content to whoever listens when it arrives", async () => {
    window.history.replaceState(null, "", "/?share=s1");
    const { pwa } = fakePwa();
    const platform = createWebPlatform(pwa);
    const first = vi.fn();
    // Like React's development double mount: subscribe, leave, subscribe.
    platform.onShare?.(first)();
    const second = vi.fn();
    platform.onShare?.(second);
    await vi.waitFor(() => {
      expect(second).toHaveBeenCalledTimes(1);
    });
    expect(first).not.toHaveBeenCalled();
    const shared = second.mock.calls[0]?.[0] as {
      subject?: string;
      text?: string;
      files: File[];
    };
    expect(shared).toMatchObject({
      subject: "Trip",
      text: "See this\nhttps://example.org/x",
      to: [],
    });
    expect(shared.files.map((file) => file.name)).toEqual(["plan.pdf"]);
  });

  it("notifies through the service worker and runs the click it reports", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    const { pwa, showNotification, post } = fakePwa();
    const platform = createWebPlatform(pwa);
    expect(platform.notifications.supported()).toBe(true);
    const onClick = vi.fn();
    platform.notifications.show({
      title: "Anna",
      body: "Plans",
      tag: "a0-m1",
      onClick,
      url: "/#/acct/inbox/m1",
    });
    await vi.waitFor(() => {
      expect(showNotification).toHaveBeenCalledWith(
        "Anna",
        expect.objectContaining({
          tag: "a0-m1",
          data: { tag: "a0-m1", url: "/#/acct/inbox/m1" },
        }),
      );
    });
    post({ type: "notification-click", tag: "a0-m1" });
    expect(onClick).toHaveBeenCalledTimes(1);
    post({ type: "notification-click", tag: "a0-m1" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("puts the unread count on the app's icon", () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    const platform = createWebPlatform(fakePwa().pwa);
    platform.setUnreadCount(4, "4 unread");
    expect(setAppBadge).toHaveBeenCalledWith(4);
    platform.setUnreadCount(0, "");
    expect(clearAppBadge).toHaveBeenCalled();
    Object.assign(navigator, {
      setAppBadge: undefined,
      clearAppBadge: undefined,
    });
  });

  it("stays the plain web app without the service worker", async () => {
    window.history.replaceState(null, "", "/?mailto=mailto%3Ax%40y");
    const platform = createWebPlatform();
    // Nothing is taken from the address, nothing is shared.
    expect(window.location.search).toBe("?mailto=mailto%3Ax%40y");
    expect(platform.onShare).toBeUndefined();
    expect(platform.pwa).toBeUndefined();
    const listener = vi.fn();
    platform.onCompose(listener);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});
