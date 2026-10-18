import type { AuthSession } from "../auth/types";
import type { Account, ProviderType } from "../core/model";
import type { MailProvider } from "../core/provider";

/**
 * Everything the app needs to know about one kind of provider. Modules are
 * registered in the composition root (`src/app`), so nothing else depends on
 * concrete providers.
 */
export interface ProviderModule {
  readonly type: ProviderType;
  /** Human-readable name, e.g. for an "Add account" menu. */
  readonly label: string;

  /**
   * Adds a new account interactively (the user picks and authorizes an
   * account). Must be called from a user gesture.
   */
  connect(): Promise<{ account: Account; auth: AuthSession }>;

  /** Recreates the session of a known account without user interaction. */
  restore(account: Account): AuthSession;

  createProvider(account: Account, auth: AuthSession): MailProvider;
}

/** A connected account with its session and provider. */
export interface AccountHandle {
  readonly account: Account;
  readonly auth: AuthSession;
  readonly provider: MailProvider;
}
