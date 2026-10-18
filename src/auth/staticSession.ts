import { MailError } from "../core/errors";
import { Emitter } from "../lib/emitter";
import type { AuthSession, AuthStatus } from "./types";

/**
 * An {@link AuthSession} with a fixed token that never expires on its own.
 * Used by the demo account, by tests, and to make a single call with a
 * freshly obtained token.
 */
export class StaticAuthSession implements AuthSession {
  readonly #emitter = new Emitter();
  readonly #token: string;
  #status: AuthStatus;

  constructor(status: AuthStatus = "signed-in", token = "static-token") {
    this.#status = status;
    this.#token = token;
  }

  get status(): AuthStatus {
    return this.#status;
  }

  get expiresAt(): undefined {
    return undefined;
  }

  getAccessToken(): Promise<string> {
    if (this.#status !== "signed-in") {
      return Promise.reject(
        new MailError("auth-required", "Not signed in", {
          reason: "notConnected",
        }),
      );
    }
    return Promise.resolve(this.#token);
  }

  signIn(): Promise<void> {
    this.#set("signed-in");
    return Promise.resolve();
  }

  signOut(): Promise<void> {
    this.#set("signed-out");
    return Promise.resolve();
  }

  markExpired(): void {
    this.#set("expired");
  }

  subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  #set(status: AuthStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.#emitter.emit();
  }
}
