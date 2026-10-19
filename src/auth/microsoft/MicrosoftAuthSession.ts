import type { AccountInfo, AuthenticationResult } from "@azure/msal-browser";
import { MailError } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import type { AuthSession, AuthStatus } from "../types";
import {
  GRAPH_SCOPES,
  needsInteraction,
  signInError,
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

  constructor(options: MicrosoftAuthSessionOptions) {
    this.#options = options;
  }

  get status(): AuthStatus {
    return this.#status;
  }

  /** Undefined: MSAL renews silently, so nothing needs to refresh it on a click. */
  get expiresAt(): undefined {
    return undefined;
  }

  async getAccessToken(): Promise<string> {
    if (this.#status !== "signed-in") throw this.#signInAgain();
    const msal = await this.#options.msal.load();
    const account = this.#account(msal.getAllAccounts());
    const scopes = [...GRAPH_SCOPES];
    try {
      const result = account
        ? await msal.acquireTokenSilent({ account, scopes })
        : await msal.ssoSilent({ loginHint: this.#options.loginHint, scopes });
      this.#remember(result);
      return result.accessToken;
    } catch (error) {
      if (!needsInteraction(error)) throw signInError(error);
      this.markExpired();
      throw this.#signInAgain(error);
    }
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
    const signedInAs = result.account.username;
    if (!sameAddress(signedInAs, this.#options.loginHint)) {
      await msal.clearCache({ account: result.account });
      throw new MailError(
        "auth-required",
        `Signed in as ${signedInAs} instead of ${this.#options.loginHint}.`,
        {
          reason: "wrongAccount",
          params: { actual: signedInAs, expected: this.#options.loginHint },
        },
      );
    }
    this.#remember(result);
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
