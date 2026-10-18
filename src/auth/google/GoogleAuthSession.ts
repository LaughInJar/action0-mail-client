import { MailError } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import type { AuthSession, AuthStatus } from "../types";
import { loadGis, peekGis, type GoogleOAuth2 } from "./gis";
import { requestGoogleToken } from "./tokenRequest";
import type { StoredToken, TokenStore } from "./tokenStore";

/** Tokens closer than this to their expiry are treated as expired. */
const EXPIRY_MARGIN_MS = 60_000;

/** Configuration of a {@link GoogleAuthSession}. */
export interface GoogleAuthSessionOptions {
  readonly clientId: string;
  /** Space-separated scopes that must be granted. */
  readonly scope: string;
  /**
   * Space-separated scopes that are asked for too, but may be declined. A
   * token counts as expired only if they were never asked for (e.g. tokens
   * from before they were added), so the user is asked exactly once.
   */
  readonly optionalScope?: string;
  /** Email of the account, used as login hint so re-auth skips the account chooser. */
  readonly loginHint: string;
  readonly tokenStore: TokenStore;
  readonly now?: () => number;
  /** Override for tests. */
  readonly gis?: {
    peek: () => GoogleOAuth2 | undefined;
    load: () => Promise<GoogleOAuth2>;
  };
}

/**
 * {@link AuthSession} backed by the Google Identity Services token model.
 *
 * GIS issues 1-hour access tokens and no refresh tokens. A new token needs a
 * popup, which browsers only allow during a user gesture, so
 * {@link getAccessToken} never refreshes; it reports `auth-required` instead
 * and the UI offers a one-click reconnect (or refreshes on the next
 * interaction shortly before expiry).
 */
export class GoogleAuthSession implements AuthSession {
  readonly #options: GoogleAuthSessionOptions;
  readonly #now: () => number;
  readonly #emitter = new Emitter();
  #status: AuthStatus;
  #pending: Promise<void> | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Optional scopes the user declined; not asked for again in this page. */
  readonly #declined = new Set<string>();

  constructor(options: GoogleAuthSessionOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#rememberDeclined(options.tokenStore.load());
    this.#status = this.#hasUsableToken() ? "signed-in" : "expired";
    this.#scheduleExpiry();
  }

  get status(): AuthStatus {
    return this.#status;
  }

  get expiresAt(): number | undefined {
    return this.#options.tokenStore.load()?.expiresAt;
  }

  getAccessToken(): Promise<string> {
    const token = this.#options.tokenStore.load();
    if (token && this.#hasUsableToken()) {
      return Promise.resolve(token.accessToken);
    }
    if (this.#status === "signed-in") this.markExpired();
    return Promise.reject(
      new MailError("auth-required", "Please sign in to Google again."),
    );
  }

  signIn({
    askAgain = false,
  }: { readonly askAgain?: boolean } = {}): Promise<void> {
    if (askAgain) this.#declined.clear();
    this.#pending ??= this.#requestToken().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async signOut(): Promise<void> {
    const token = this.#options.tokenStore.load();
    clearTimeout(this.#expiryTimer);
    this.#options.tokenStore.clear();
    this.#setStatus("signed-out");
    const oauth2 = this.#gisPeek();
    if (token && oauth2) {
      await new Promise<void>((resolve) => {
        oauth2.revoke(token.accessToken, resolve);
      });
    }
  }

  markExpired(): void {
    clearTimeout(this.#expiryTimer);
    this.#options.tokenStore.clear();
    if (this.#status === "signed-in") this.#setStatus("expired");
  }

  subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  async #requestToken(): Promise<void> {
    const { scope, optionalScope = "" } = this.#options;
    // Asking again for a declined scope would show Google's consent screen
    // on every refresh.
    const optional = optionalScope
      .split(" ")
      .filter((s) => s && !this.#declined.has(s));
    const request = {
      clientId: this.#options.clientId,
      scope: [scope, ...optional].join(" "),
      required: scope,
      prompt: "",
      loginHint: this.#options.loginHint,
    } as const;
    // Open the popup synchronously when GIS is ready, to stay inside the user gesture.
    const ready = this.#gisPeek();
    const token = await requestGoogleToken(
      ready ?? (await this.#gisLoad()),
      request,
      this.#now,
    );
    this.#options.tokenStore.save(token);
    this.#rememberDeclined(token);
    this.#setStatus("signed-in");
    this.#scheduleExpiry();
    // Expiry changes even if the status doesn't.
    this.#emitter.emit();
  }

  /** Flips the status to `expired` when the token runs out, so the UI can react without a failed request. */
  #scheduleExpiry() {
    clearTimeout(this.#expiryTimer);
    const token = this.#options.tokenStore.load();
    if (!token || this.#status !== "signed-in") return;
    const delay = token.expiresAt - EXPIRY_MARGIN_MS - this.#now();
    this.#expiryTimer = setTimeout(
      () => {
        this.markExpired();
      },
      Math.max(0, delay),
    );
  }

  /**
   * Unexpired, granted every required scope, and asked for every optional
   * one (older tokens may lack newer scopes).
   */
  #hasUsableToken(): boolean {
    const token = this.#options.tokenStore.load();
    if (!token || token.expiresAt - this.#now() <= EXPIRY_MARGIN_MS)
      return false;
    const granted = new Set(token.scope.split(" "));
    const asked = new Set(token.requested?.split(" ") ?? []);
    const optional = this.#options.optionalScope?.split(" ") ?? [];
    return (
      this.#options.scope.split(" ").every((scope) => granted.has(scope)) &&
      optional.every((scope) => granted.has(scope) || asked.has(scope))
    );
  }

  #rememberDeclined(token: StoredToken | undefined) {
    if (!token?.requested) return;
    const granted = new Set(token.scope.split(" "));
    for (const scope of this.#options.optionalScope?.split(" ") ?? []) {
      if (token.requested.split(" ").includes(scope) && !granted.has(scope))
        this.#declined.add(scope);
    }
  }

  #gisPeek() {
    return this.#options.gis ? this.#options.gis.peek() : peekGis();
  }

  #gisLoad() {
    return this.#options.gis ? this.#options.gis.load() : loadGis();
  }

  #setStatus(status: AuthStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.#emitter.emit();
  }
}
