/**
 * - `signed-in`: a usable access token is available.
 * - `expired`: the account is known but needs interactive sign-in
 *   (token expired, revoked, or not yet obtained in this browser session).
 * - `signed-out`: the user signed out; the session is no longer usable.
 */
export type AuthStatus = "signed-in" | "expired" | "signed-out";

/**
 * Credentials for one account. Implementations decide how tokens are obtained
 * and refreshed: MSAL can refresh silently inside {@link getAccessToken},
 * Google Identity Services can't and needs {@link signIn} from a user gesture.
 */
export interface AuthSession {
  readonly status: AuthStatus;
  /**
   * Expiry of the current access token (epoch ms), if there is one. Sessions
   * that renew silently (MSAL) leave it undefined, so nothing opens a popup
   * to refresh them.
   */
  readonly expiresAt: number | undefined;

  /**
   * Returns a valid access token. Never opens UI: if user interaction is
   * needed, it rejects with `MailError("auth-required")`.
   */
  getAccessToken(): Promise<string>;

  /**
   * What signing in again takes: the browser (OAuth, the default), or a
   * password the user types (mail server accounts), which the interface
   * asks for and passes to {@link signIn}.
   */
  readonly reauth?: "browser" | "password";

  /**
   * Interactive (re-)authentication. Must be called from a user gesture,
   * because it may open a popup. Concurrent calls share one attempt. With
   * `askAgain`, optional permissions the user declined before are asked
   * for again (e.g. "Allow editing" for signatures); `password` is the new
   * password of a session whose {@link reauth} is `password`.
   */
  signIn(options?: {
    readonly askAgain?: boolean;
    readonly password?: string;
  }): Promise<void>;

  /** Revokes and forgets the credentials. */
  signOut(): Promise<void>;

  /** Called by the HTTP layer when the provider rejects the token (HTTP 401). */
  markExpired(): void;

  /** Notifies about changes of {@link status} and {@link expiresAt}. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * A session with permissions that are asked for when needed (calendar
 * access), so mail works without them.
 */
export interface ScopedSession {
  /** True if the account granted all of these scopes. */
  hasScopes(scopes: readonly string[]): boolean;
  /** Asks the user for these scopes (opens UI): call it from a click. */
  requestScopes(scopes: readonly string[]): Promise<void>;
  /** Notifies when granted scopes (or the status) change. */
  readonly subscribe: (listener: () => void) => () => void;
}
