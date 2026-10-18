import { describe, expect, it, vi } from "vitest";
import { StaticAuthSession } from "./staticSession";
import {
  installRefreshOnInteraction,
  isExpiringSoon,
} from "./refreshOnInteraction";
import type { AuthSession } from "./types";

/** A signed-in session whose token expires at `expiresAt`. */
function sessionExpiringAt(expiresAt: number | undefined) {
  const session = new StaticAuthSession();
  const signIn = vi.spyOn(session, "signIn");
  Object.defineProperty(session, "expiresAt", { get: () => expiresAt });
  return { session: session as AuthSession, signIn };
}

describe("isExpiringSoon", () => {
  it("is true only for signed-in sessions inside the window", () => {
    expect(isExpiringSoon(sessionExpiringAt(1000 + 60_000).session, 1000)).toBe(
      true,
    );
    expect(
      isExpiringSoon(sessionExpiringAt(1000 + 3_600_000).session, 1000),
    ).toBe(false);
    expect(isExpiringSoon(sessionExpiringAt(undefined).session, 1000)).toBe(
      false,
    );
    expect(isExpiringSoon(new StaticAuthSession("expired"), 1000)).toBe(false);
  });
});

describe("installRefreshOnInteraction", () => {
  it("refreshes one expiring session per gesture, with a cooldown", () => {
    let now = 0;
    const soon = sessionExpiringAt(60_000);
    const later = sessionExpiringAt(3_600_000);
    const target = new EventTarget();
    const uninstall = installRefreshOnInteraction(
      () => [later.session, soon.session],
      {
        target,
        now: () => now,
        cooldownMs: 10_000,
      },
    );

    target.dispatchEvent(new Event("keydown"));
    target.dispatchEvent(new Event("pointerdown"));
    expect(soon.signIn).toHaveBeenCalledTimes(1);
    expect(later.signIn).not.toHaveBeenCalled();

    now = 10_000;
    target.dispatchEvent(new Event("pointerdown"));
    expect(soon.signIn).toHaveBeenCalledTimes(2);

    uninstall();
    now = 30_000;
    target.dispatchEvent(new Event("keydown"));
    expect(soon.signIn).toHaveBeenCalledTimes(2);
  });

  it("leaves expired sessions to the reconnect bar", () => {
    const expired = new StaticAuthSession("expired");
    const signIn = vi.spyOn(expired, "signIn");
    const target = new EventTarget();
    installRefreshOnInteraction(() => [expired], { target });
    target.dispatchEvent(new Event("keydown"));
    expect(signIn).not.toHaveBeenCalled();
  });
});
