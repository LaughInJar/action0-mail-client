import { MailError } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import type { AuthSession, AuthStatus } from "../types";
import { loadGis, peekGis, type GoogleOAuth2 } from "./gis";
import { requestGoogleToken } from "./tokenRequest";
import type { TokenStore } from "./tokenStore";

/** Tokens closer than this to their expiry are treated as expired. */
const EXPIRY_MARGIN_MS = 60_000;

/** Configuration of a {@link GoogleAuthSession}. */
export interface GoogleAuthSessionOptions {
  readonly clientId: string;
  readonly scope: string;
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

  constructor(options: GoogleAuthSessionOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
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

  signIn(): Promise<void> {
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
    const request = {
      clientId: this.#options.clientId,
      scope: this.#options.scope,
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

  #hasUsableToken(): boolean {
    const token = this.#options.tokenStore.load();
    return !!token && token.expiresAt - this.#now() > EXPIRY_MARGIN_MS;
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
