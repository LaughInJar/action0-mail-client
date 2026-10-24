import { MailError, type MailErrorReason } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import type { AuthSession, AuthStatus, ScopedSession } from "../types";
import {
  NativeAuthError,
  type NativeAccount,
  type NativeAuthBridge,
  type NativeClient,
} from "./bridge";

/** Options of {@link NativeAuthSession}. */
export interface NativeAuthSessionOptions {
  readonly bridge: NativeAuthBridge;
  readonly provider: "google" | "microsoft";
  readonly client: NativeClient;
  /** The account id, as the native side keys it. */
  readonly key: string;
  /** The address, used as the login hint. */
  readonly loginHint: string;
  /** Asked for at every sign-in. */
  readonly scopes: readonly string[];
  /** Without these the account is useless. */
  readonly required: readonly string[];
  /** The scopes granted so far. */
  readonly granted: readonly string[];
  /** The provider's name in messages. */
  readonly providerName: string;
}

/** Scopes compare like the providers do: Graph's prefix dropped, any case. */
const normal = (scope: string) =>
  scope.replace(/^https:\/\/graph\.microsoft\.com\//, "").toLowerCase();

/**
 * {@link AuthSession} of the desktop app: the native side signs in with the
 * system browser and keeps the refresh token, so access is renewed
 * silently (no `expiresAt`, nothing to do on clicks) until the provider
 * revokes it; then the session is `expired` and {@link signIn} opens the
 * browser again.
 */
export class NativeAuthSession implements AuthSession, ScopedSession {
  readonly #options: NativeAuthSessionOptions;
  readonly #emitter = new Emitter();
  #status: AuthStatus = "signed-in";
  #granted: Set<string>;
  #signingIn: Promise<void> | undefined;

  constructor(options: NativeAuthSessionOptions) {
    this.#options = options;
    this.#granted = new Set(options.granted.map(normal));
  }

  get status(): AuthStatus {
    return this.#status;
  }

  /** Renewed silently: nothing has to happen on a click. */
  readonly expiresAt = undefined;

  get loginHint(): string {
    return this.#options.loginHint;
  }

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  async getAccessToken(): Promise<string> {
    return (await this.#token([])).accessToken;
  }

  /** A token for scopes asked for on demand (calendar access). */
  async tokenFor(scopes: readonly string[]): Promise<string> {
    return (await this.#token(scopes)).accessToken;
  }

  hasScopes(scopes: readonly string[]): boolean {
    return scopes.every((scope) => this.#granted.has(normal(scope)));
  }

  async requestScopes(scopes: readonly string[]): Promise<void> {
    await this.#signIn([...this.#options.scopes, ...scopes], "consent");
    if (!this.hasScopes(scopes))
      throw new MailError("unavailable", "The access wasn't granted.", {
        reason: "accessNotGranted",
        params: { provider: this.#options.providerName },
      });
  }

  signIn(options: { readonly askAgain?: boolean } = {}): Promise<void> {
    return this.#signIn(
      this.#options.scopes,
      options.askAgain ? "consent" : "select_account",
    );
  }

  async signOut(): Promise<void> {
    await this.#options.bridge.signOut(this.#options.key);
    this.#setStatus("signed-out");
  }

  markExpired(): void {
    this.#setStatus("expired");
  }

  async #token(scopes: readonly string[]) {
    try {
      const token = await this.#options.bridge.token(this.#options.key, scopes);
      if (this.#status === "expired") this.#setStatus("signed-in");
      return token;
    } catch (error) {
      throw this.#failure(error);
    }
  }

  /** Concurrent sign-ins share one browser window. */
  #signIn(
    scopes: readonly string[],
    prompt: "select_account" | "consent",
  ): Promise<void> {
    this.#signingIn ??= this.#options.bridge
      .signIn(this.#options.key, {
        provider: this.#options.provider,
        client: this.#options.client,
        scopes: [...new Set(scopes)],
        required: this.#options.required,
        loginHint: this.#options.loginHint,
        prompt,
      })
      .then(
        (account: NativeAccount) => {
          this.#granted = new Set(account.scopes.map(normal));
          this.#setStatus("signed-in");
        },
        (error: unknown) => {
          throw this.#failure(error);
        },
      )
      .finally(() => {
        this.#signingIn = undefined;
      });
    return this.#signingIn;
  }

  /** A native refusal as the {@link MailError} the app expects. */
  #failure(error: unknown): MailError {
    if (error instanceof NativeAuthError && error.kind === "reauth")
      this.#setStatus("expired");
    return nativeAuthError(
      error,
      this.#options.providerName,
      this.#options.loginHint,
    );
  }

  #setStatus(status: AuthStatus) {
    if (status === this.#status) return;
    this.#status = status;
    this.#emitter.emit();
  }
}

/** A new account's first sign-in (opens the browser). */
export async function connectNative(
  bridge: NativeAuthBridge,
  request: Parameters<NativeAuthBridge["connect"]>[0],
  providerName: string,
): Promise<NativeAccount> {
  try {
    return await bridge.connect(request);
  } catch (error) {
    throw nativeAuthError(error, providerName, "");
  }
}

/** What a native refusal means, as the {@link MailError} the app expects. */
export function nativeAuthError(
  error: unknown,
  provider: string,
  expected: string,
): MailError {
  if (!(error instanceof NativeAuthError))
    return new MailError("provider", String(error), { cause: error });
  const options = (
    reason: MailErrorReason,
    params: Readonly<Record<string, string>> = { provider },
  ) => ({
    cause: error,
    reason,
    params,
  });
  switch (error.kind) {
    case "reauth":
      return new MailError(
        "auth-required",
        error.message,
        options("signInAgain"),
      );
    case "scopes":
      // Mail goes on; only what needs these scopes is unavailable.
      return new MailError(
        "unavailable",
        error.message,
        options("calendarAccessNeeded"),
      );
    case "cancelled":
      return new MailError(
        "auth-required",
        error.message,
        options("signInClosed"),
      );
    case "denied":
      return new MailError(
        "auth-required",
        error.message,
        options("accessNotGranted"),
      );
    case "wrongAccount":
      return new MailError(
        "auth-required",
        error.message,
        options("wrongAccount", { actual: error.message, expected }),
      );
    case "network":
      return new MailError(
        "network",
        error.message,
        options("unreachable", { service: provider }),
      );
    case "provider":
      return new MailError(
        "provider",
        error.message,
        options("signInFailed", { provider, detail: error.message }),
      );
  }
}
