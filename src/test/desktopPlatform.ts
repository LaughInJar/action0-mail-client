import { vi } from "vitest";
import type { Platform } from "../platform/types";

/**
 * A desktop {@link Platform} for UI tests: everything is a spy, and the
 * native side's events (a poll from the tray, a `mailto:` link, closing
 * into the tray) can be fired by hand.
 */
export function fakeDesktopPlatform({
  keychain = true,
  os = "linux",
  dictionaries = ["de-AT", "de-DE", "en-GB", "en-US"],
  loads = true,
}: {
  readonly keychain?: boolean;
  readonly os?: "linux" | "windows" | "macos";
  /** The Linux app's installed dictionaries. */
  readonly dictionaries?: readonly string[];
  /** Whether the dictionaries load (else none does). */
  readonly loads?: boolean;
} = {}) {
  const polls = new Set<() => void>();
  const composes = new Set<(mailto: string) => void>();
  const closings = new Set<() => void>();
  const subscribe =
    <T>(set: Set<T>) =>
    (listener: T) => {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    };
  const openExternal = vi.fn<(url: string) => void>();
  const platform = {
    kind: "desktop",
    openExternal,
    followLink: vi.fn((href: string) => {
      if (/^mailto:/i.test(href))
        for (const listener of composes) listener(href);
      else openExternal(href);
      return true;
    }),
    saveFile: vi.fn(() => Promise.resolve()),
    openFileLater: vi.fn(() => vi.fn()),
    notifications: {
      supported: () => true,
      allowed: () => true,
      mustAsk: false,
      request: vi.fn(() => Promise.resolve("granted" as const)),
      show: vi.fn(),
    },
    setUnreadCount: vi.fn(),
    onPollRequest: subscribe(polls),
    onCompose: subscribe(composes),
    desktop: {
      version: "0.1.0",
      os,
      keychain,
      configure: vi.fn(),
      onClosedToTray: subscribe(closings),
      autostart: {
        get: vi.fn(() => Promise.resolve(false)),
        set: vi.fn(() => Promise.resolve()),
      },
      makeDefaultMailApp: vi.fn(() => Promise.resolve("done" as const)),
      checkForUpdate: vi.fn(() => Promise.resolve(null)),
      quit: vi.fn(),
    },
    ...(os === "linux"
      ? {
          spelling: {
            dictionaries: vi.fn(() => Promise.resolve(dictionaries)),
            setLanguages: vi.fn((languages: readonly string[]) =>
              Promise.resolve(loads ? languages : []),
            ),
          },
        }
      : {}),
  } satisfies Platform;
  return {
    platform,
    poll: () => {
      for (const listener of polls) listener();
    },
    compose: (mailto: string) => {
      for (const listener of composes) listener(mailto);
    },
    closeToTray: () => {
      for (const listener of closings) listener();
    },
  };
}
