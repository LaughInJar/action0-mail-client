import type { AuthSession, AuthStatus } from "../../auth/types";
import { MailError } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import type { ImapBridge } from "./bridge";
import { toMailError } from "./mappers";

/** Options of {@link ImapSession}. */
export interface ImapSessionOptions {
  readonly bridge: ImapBridge;
  /** The account id (`imap:<address>`), as the native side keys it. */
  readonly key: string;
  /** Password accounts ask for the password again; Yahoo/AOL sign in again. */
  readonly reauth: "password" | "browser";
  /** The server's name in messages. */
  readonly service: string;
}

/**
 * A mail server account's session: the native side keeps the password or
 * sign-in and logs in itself, so there are no tokens here. It's `expired`
 * once the server refuses the login; {@link signIn} then takes a new
 * password (or opens the browser for Yahoo/AOL).
 */
export class ImapSession implements AuthSession {
  readonly #options: ImapSessionOptions;
  readonly #emitter = new Emitter();
  #status: AuthStatus = "signed-in";
  #signingIn: Promise<void> | undefined;

  constructor(options: ImapSessionOptions) {
    this.#options = options;
  }

  get status(): AuthStatus {
    return this.#status;
  }

  get reauth(): "password" | "browser" {
    return this.#options.reauth;
  }

  /** Nothing expires on a timer. */
  readonly expiresAt = undefined;

  /** The native side logs in itself; there's no token to hand out. */
  getAccessToken(): Promise<string> {
    return this.#status === "signed-in"
      ? Promise.resolve("")
      : Promise.reject(
          new MailError("auth-required", "Sign in again.", {
            reason: "signInAgain",
            params: { provider: this.#options.service },
          }),
        );
  }

  signIn(options?: { readonly password?: string }): Promise<void> {
    this.#signingIn ??= this.#options.bridge
      .reconnect(this.#options.key, options?.password)
      .then(
        () => {
          this.#set("signed-in");
        },
        (error: unknown) => {
          throw toMailError(error, { service: this.#options.service });
        },
      )
      .finally(() => {
        this.#signingIn = undefined;
      });
    return this.#signingIn;
  }

  async signOut(): Promise<void> {
    this.#set("signed-out");
    await this.#options.bridge.remove(this.#options.key);
  }

  markExpired(): void {
    if (this.#status === "signed-in") this.#set("expired");
  }

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  #set(status: AuthStatus) {
    this.#status = status;
    this.#emitter.emit();
  }
}
