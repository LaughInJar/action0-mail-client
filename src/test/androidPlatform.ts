import { vi } from "vitest";
import type {
  AvailableRelease,
  OpenTarget,
  Platform,
  SharedContent,
} from "../platform/types";

/**
 * An Android {@link Platform} for UI tests: everything is a spy, and what
 * the Kotlin side reports (a share, a notification's tap, a `mailto:` link)
 * can be fired by hand.
 */
export function fakeAndroidPlatform({
  release = null,
  notificationsAllowed = true,
}: {
  readonly release?: AvailableRelease | null;
  readonly notificationsAllowed?: boolean;
} = {}) {
  const shares = new Set<(shared: SharedContent) => void>();
  const opens = new Set<(target: OpenTarget) => void>();
  const composes = new Set<(mailto: string) => void>();
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
    kind: "android",
    openExternal,
    followLink: vi.fn(() => true),
    saveFile: vi.fn(() => Promise.resolve()),
    openFileLater: vi.fn(() => vi.fn()),
    notifications: {
      supported: () => true,
      allowed: () => notificationsAllowed,
      mustAsk: true,
      request: vi.fn(() => Promise.resolve("granted" as const)),
      show: vi.fn(),
    },
    setUnreadCount: vi.fn(),
    onPollRequest: () => () => undefined,
    onCompose: subscribe(composes),
    onShare: subscribe(shares),
    onOpen: subscribe(opens),
    mobile: {
      version: "0.1.0",
      os: "android",
      package: "app.action0.mail",
      signatureHash: "ga0RGNYHvNM5d0SLGQfpQWAPGJ8=",
      microsoftRedirect:
        "msauth://app.action0.mail/ga0RGNYHvNM5d0SLGQfpQWAPGJ8%3D",
      share: vi.fn(() => Promise.resolve()),
      checkForUpdate: vi.fn(() => Promise.resolve(release)),
      setTheme: vi.fn(),
      configureBackground: vi.fn(() => Promise.resolve()),
    },
  } satisfies Platform;
  return {
    platform,
    share: (shared: SharedContent) => {
      for (const listener of shares) listener(shared);
    },
    open: (target: OpenTarget) => {
      for (const listener of opens) listener(target);
    },
    compose: (mailto: string) => {
      for (const listener of composes) listener(mailto);
    },
  };
}
