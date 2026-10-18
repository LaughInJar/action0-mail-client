import type { AuthSession } from "./types";

/** Options of {@link installRefreshOnInteraction}. */
export interface RefreshOnInteractionOptions {
  /** Refresh tokens that expire within this many milliseconds. */
  readonly windowMs?: number;
  /** Minimum time between two attempts for the same session. */
  readonly cooldownMs?: number;
  readonly target?: EventTarget;
  readonly now?: () => number;
}

/** Default lead time before expiry in which a token counts as "expiring soon". */
export const REFRESH_WINDOW_MS = 5 * 60_000;

/** True if the session is signed in but its token expires within `windowMs`. */
export function isExpiringSoon(
  session: AuthSession,
  now: number,
  windowMs = REFRESH_WINDOW_MS,
): boolean {
  return (
    session.status === "signed-in" &&
    session.expiresAt !== undefined &&
    session.expiresAt - now < windowMs
  );
}

/**
 * Refreshes tokens that are about to expire on the user's next click or key
 * press, because only a user gesture may open the sign-in popup. With an
 * active Google session the popup closes by itself.
 *
 * At most one session is refreshed per gesture (browsers allow one popup per
 * activation). Already expired sessions are left alone: the UI shows a
 * reconnect bar for them instead of popping up unexpectedly.
 *
 * @returns A function that removes the listeners.
 */
export function installRefreshOnInteraction(
  getSessions: () => readonly AuthSession[],
  options: RefreshOnInteractionOptions = {},
): () => void {
  const {
    windowMs = REFRESH_WINDOW_MS,
    cooldownMs = 60_000,
    target = window,
    now = Date.now,
  } = options;
  const lastAttempt = new WeakMap<AuthSession, number>();

  const onInteraction = () => {
    const time = now();
    const session = getSessions().find(
      (candidate) =>
        isExpiringSoon(candidate, time, windowMs) &&
        time - (lastAttempt.get(candidate) ?? -Infinity) >= cooldownMs,
    );
    if (!session) return;
    lastAttempt.set(session, time);
    session.signIn().catch(() => {
      // A failed refresh is not fatal: the token keeps working until it
      // expires, and then the reconnect bar takes over.
    });
  };

  target.addEventListener("pointerdown", onInteraction, { capture: true });
  target.addEventListener("keydown", onInteraction, { capture: true });
  return () => {
    target.removeEventListener("pointerdown", onInteraction, { capture: true });
    target.removeEventListener("keydown", onInteraction, { capture: true });
  };
}
