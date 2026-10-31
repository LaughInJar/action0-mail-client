import type { AuthSession } from "../auth/types";
import type { CalendarProvider } from "../core/calendar";
import type { FilterProvider } from "../core/filters";
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
   * Loads whatever {@link connect} needs (e.g. Google's sign-in script), so
   * that connect() can open its popup synchronously inside the click.
   */
  readonly prepare?: () => Promise<void>;

  /**
   * Adds a new account interactively (the user picks and authorizes an
   * account). Must be called from a user gesture. Mail server accounts get
   * what the user entered (a `MailServerSetup`) as `input`.
   */
  connect(input?: unknown): Promise<{ account: Account; auth: AuthSession }>;

  /** Recreates the session of a known account without user interaction. */
  restore(account: Account): AuthSession;

  createProvider(account: Account, auth: AuthSession): MailProvider;

  /** The account's calendars, if the provider has them. */
  readonly createCalendar?: (
    account: Account,
    auth: AuthSession,
  ) => CalendarProvider;

  /** The account's filters and automatic reply, if the provider has them. */
  readonly createFilters?: (
    account: Account,
    auth: AuthSession,
  ) => FilterProvider;
}

/** A connected account with its session and provider. */
export interface AccountHandle {
  readonly account: Account;
  readonly auth: AuthSession;
  readonly provider: MailProvider;
  /** The account's calendars, if its provider has them. */
  readonly calendar?: CalendarProvider;
  /** The account's filters and automatic reply, if its provider has them. */
  readonly filters?: FilterProvider;
}

/**
 * What's wrong with an entered setting: nothing entered, a client secret
 * instead of the client ID, a web address, or not the expected format.
 */
export type SetupProblem = "missing" | "secret" | "url" | "malformed";

/** Where a provider setting comes from: the build (`.env.local`) or this browser. */
export type SettingSource = "build" | "browser";

/**
 * Lets the user configure a provider at runtime, e.g. Google's OAuth client
 * ID. The composition root implements it; the UI only sees this interface.
 */
export interface ProviderSetup {
  readonly type: ProviderType;
  /** The value in use and where it came from; a build value takes precedence. */
  readonly current: () =>
    | {
        readonly value: string;
        readonly source: SettingSource;
        /** The client secret, for setups that need one. */
        readonly secret?: string;
      }
    | undefined;
  /** What's wrong with a value, or undefined if it's fine. */
  readonly validate: (value: string) => SetupProblem | undefined;
  /**
   * The setup needs a client secret too (Google's desktop clients), and
   * what's wrong with one.
   */
  readonly secret?: {
    readonly validate: (secret: string) => SetupProblem | undefined;
  };
  /** Saves the value (and secret) and (re-)registers the provider module. */
  readonly apply: (value: string, secret?: string) => void;
}
