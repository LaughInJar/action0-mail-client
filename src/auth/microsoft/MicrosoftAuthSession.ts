import type { AccountInfo, AuthenticationResult } from "@azure/msal-browser";
import { MailError } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import type { AuthSession, AuthStatus } from "../types";
import {
  GRAPH_SCOPES,
  needsInteraction,
  signInError,
  type MsalClient as MsalLoaderClient,
  type MsalLoader,
} from "./msal";

/** Configuration of a {@link MicrosoftAuthSession}. */
export interface MicrosoftAuthSessionOptions {
  /** Email of the account: login hint, and how its MSAL account is found. */
  readonly loginHint: string;
  readonly msal: MsalLoader;
  /** Remembers which MSAL account this is, per tab (sessionStorage). */
  readonly accountStore: MicrosoftAccountStore;
}

/** Remembers the MSAL `homeAccountId` of an account (no tokens). */
export interface MicrosoftAccountStore {
  readonly load: () => string | undefined;
  readonly save: (homeAccountId: string) => void;
  readonly clear: () => void;
}

/** A {@link MicrosoftAccountStore} in sessionStorage. */
export function sessionAccountStore(
  accountId: string,
  storage: Storage | undefined,
): MicrosoftAccountStore {
  const key = `a0.microsoft.account.${accountId}`;
  return {
    load: () => {
      try {
        return storage?.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    save: (homeAccountId) => {
      try {
        storage?.setItem(key, homeAccountId);
      } catch {
        // Storage full or blocked: the account is found by its email instead.
      }
    },
    clear: () => {
      try {
        storage?.removeItem(key);
      } catch {
        // Nothing to forget.
      }
    },
  };
}

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * {@link AuthSession} backed by MSAL (auth code flow with PKCE).
 *
 * Unlike Google's token model, MSAL renews tokens by itself: with its
 * refresh token for about 24 hours, then through a hidden iframe if the
 * browser still has a Microsoft session. Only when both fail does
 * {@link getAccessToken} report `auth-required`, and the UI offers a
 * one-click reconnect (a popup).
 *
 * A restored session starts as `signed-in` and finds out on the first
 * request whether a silent token is still available.
 */
export class MicrosoftAuthSession implements AuthSession {
  readonly #options: MicrosoftAuthSessionOptions;
  readonly #emitter = new Emitter();
  #status: AuthStatus = "signed-in";
  #pending: Promise<void> | undefined;
  /** Extra scopes (e.g. calendar access) the account hasn't consented to. */
  readonly #missing = new Set<string>();

  constructor(options: MicrosoftAuthSessionOptions) {
    this.#options = options;
  }

  get status(): AuthStatus {
    return this.#status;
  }

  /** The account's sign-in name. */
  get loginHint(): string {
    return this.#options.loginHint;
  }

  /** Undefined: MSAL renews silently, so nothing needs to refresh it on a click. */
  get expiresAt(): undefined {
    return undefined;
  }

  async getAccessToken(): Promise<string> {
    return this.#token([...GRAPH_SCOPES]);
  }

  /**
   * Whether the account consented to these extra scopes (as far as known:
   * a refusal shows up on the first {@link tokenFor}).
   */
  hasScopes(scopes: readonly string[]): boolean {
    return !scopes.some((scope) => this.#missing.has(scope));
  }

  /**
   * A token for extra scopes, e.g. calendar access. Without consent it
   * rejects as `unavailable` (no Reconnect bar: mail keeps working) and
   * {@link hasScopes} turns false until {@link requestScopes}.
   */
  async tokenFor(scopes: readonly string[]): Promise<string> {
    try {
      const token = await this.#token(scopes, false);
      this.#setMissing(scopes, false);
      return token;
    } catch (error) {
      if (!needsInteraction(error)) throw error;
      // Mail still works without a popup: it's the extra consent that's missing.
      await this.getAccessToken();
      this.#setMissing(scopes, true);
      throw new MailError("unavailable", "Calendar access isn't allowed yet.", {
        cause: error,
        reason: "calendarAccessNeeded",
      });
    }
  }

  /** Asks for consent to extra scopes (a popup: call it from a click). */
  async requestScopes(scopes: readonly string[]): Promise<void> {
    const msal = this.#options.msal.peek() ?? (await this.#options.msal.load());
    let result: AuthenticationResult;
    try {
      result = await msal.acquireTokenPopup({
        scopes: [...scopes],
        loginHint: this.#options.loginHint,
      });
    } catch (error) {
      throw signInError(error);
    }
    await this.#checkAccount(result, msal);
    this.#remember(result);
    this.#setMissing(scopes, false);
  }

  /** A token for `scopes`; MSAL errors that need the user are passed on when `expire` is off. */
  async #token(scopes: readonly string[], expire = true): Promise<string> {
    if (this.#status !== "signed-in") throw this.#signInAgain();
    const msal = await this.#options.msal.load();
    const account = this.#account(msal.getAllAccounts());
    try {
      const result = account
        ? await msal.acquireTokenSilent({ account, scopes: [...scopes] })
        : await msal.ssoSilent({
            loginHint: this.#options.loginHint,
            scopes: [...scopes],
          });
      this.#remember(result);
      return result.accessToken;
    } catch (error) {
      if (!needsInteraction(error)) throw signInError(error);
      if (!expire) throw error;
      this.markExpired();
      throw this.#signInAgain(error);
    }
  }

  #setMissing(scopes: readonly string[], missing: boolean) {
    const before = this.hasScopes(scopes);
    for (const scope of scopes)
      if (missing) this.#missing.add(scope);
      else this.#missing.delete(scope);
    if (before !== this.hasScopes(scopes)) this.#emitter.emit();
  }

  signIn(): Promise<void> {
    this.#pending ??= this.#popup().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async signOut(): Promise<void> {
    this.#setStatus("signed-out");
    const msal = this.#options.msal.peek();
    const account = msal && this.#account(msal.getAllAccounts());
    this.#options.accountStore.clear();
    // Forgets the account in action0 only; the browser stays signed in to Microsoft.
    if (msal && account) await msal.clearCache({ account });
  }

  markExpired(): void {
    if (this.#status === "signed-in") this.#setStatus("expired");
  }

  subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  async #popup(): Promise<void> {
    // Open the popup synchronously when MSAL is ready, inside the user gesture.
    const msal = this.#options.msal.peek() ?? (await this.#options.msal.load());
    let result: AuthenticationResult;
    try {
      result = await msal.acquireTokenPopup({
        scopes: [...GRAPH_SCOPES],
        loginHint: this.#options.loginHint,
      });
    } catch (error) {
      throw signInError(error);
    }
    await this.#checkAccount(result, msal);
    this.#remember(result);
  }

  /** Refuses a popup answer for another account than this one. */
  async #checkAccount(
    result: AuthenticationResult,
    msal?: { clearCache: MsalLoaderClient["clearCache"] },
  ): Promise<void> {
    const signedInAs = result.account.username;
    if (sameAddress(signedInAs, this.#options.loginHint)) return;
    await (msal ?? this.#options.msal.peek())?.clearCache({
      account: result.account,
    });
    throw new MailError(
      "auth-required",
      `Signed in as ${signedInAs} instead of ${this.#options.loginHint}.`,
      {
        reason: "wrongAccount",
        params: { actual: signedInAs, expected: this.#options.loginHint },
      },
    );
  }

  /** This session's MSAL account: the remembered one, else by email. */
  #account(accounts: readonly AccountInfo[]): AccountInfo | undefined {
    const home = this.#options.accountStore.load();
    return (
      accounts.find((account) => account.homeAccountId === home) ??
      accounts.find((account) =>
        sameAddress(account.username, this.#options.loginHint),
      )
    );
  }

  #remember(result: AuthenticationResult) {
    this.#options.accountStore.save(result.account.homeAccountId);
    this.#setStatus("signed-in");
  }

  #signInAgain(cause?: unknown): MailError {
    return new MailError(
      "auth-required",
      "Please sign in to Microsoft again.",
      {
        cause,
        reason: "signInAgain",
        params: { provider: "Microsoft" },
      },
    );
  }

  #setStatus(status: AuthStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.#emitter.emit();
  }
}
