/**
 * Accounts on a mail server (IMAP/SMTP), which the apps' native side talks
 * to: finding an address's settings, adding the account with a password
 * or a Yahoo/AOL sign-in, a certificate the system doesn't trust, and what
 * can go wrong. Provider-neutral, so the Add account wizard can use it; the
 * IMAP provider implements it over its native bridge.
 */
import type { AccountHandle } from "./types";

/** How a server is reached: TLS from the start, or STARTTLS (required). */
export type MailServerSecurity = "tls" | "starttls";

/** A server's address. */
export interface MailServer {
  readonly host: string;
  readonly port: number;
  readonly security: MailServerSecurity;
}

/** Where an account's mail is. */
export interface MailServerSettings {
  readonly imap: MailServer;
  readonly smtp: MailServer;
  /** The login name (often the address). */
  readonly username: string;
}

/** Providers whose OAuth sign-in action0 knows, besides passwords. */
export type MailServerOAuth = "yahoo" | "aol";

/** What was found out about an address's provider. */
export interface MailServerDiscovery {
  /** The settings found; absent if none (they're typed in then). */
  readonly settings?: MailServerSettings;
  /**
   * Where they came from: the provider's own configuration, Mozilla's
   * provider database, the domain's mail servers (MX), or nowhere.
   */
  readonly source: "provider" | "ispdb" | "mx" | "none";
  /** The provider's name, if a database knows it ("GMX Freemail"). */
  readonly providerName?: string;
  /** Where the provider's users make an app password (for the hint). */
  readonly appPasswordUrl?: string;
  /** The provider has to have IMAP switched on first (GMX, web.de). */
  readonly enableImapUrl?: string;
  /** The provider has a sign-in action0 supports (instead of a password). */
  readonly oauth?: MailServerOAuth;
  /** A Gmail or Microsoft address: better added as that account type. */
  readonly better?: "gmail" | "microsoft";
}

/** An app's registration at Yahoo or AOL. */
export interface MailServerOAuthClient {
  readonly id: string;
  readonly secret?: string;
}

/** How the account signs in. */
export type MailServerCredentials =
  | { readonly password: string }
  | { readonly oauth: MailServerOAuth; readonly client: MailServerOAuthClient };

/** What adding an account needs. */
export interface MailServerSetup {
  readonly address: string;
  /** The name mail goes out with. */
  readonly name: string;
  readonly settings: MailServerSettings;
  readonly credentials: MailServerCredentials;
  /**
   * The SHA-256 fingerprint (hex, colon-separated) of a certificate the
   * system doesn't trust, which the user chose to trust for this account.
   */
  readonly trust?: string;
}

/** A kept account, as the UI knows it. */
export interface MailServerAccountInfo {
  /** The account id: `imap:<lower-case address>`. */
  readonly key: string;
  readonly address: string;
  readonly name: string;
  readonly settings: MailServerSettings;
  /** How it signs in (no secrets). */
  readonly signIn: "password" | MailServerOAuth;
  /** The most bytes a mail may have (the SMTP server's `SIZE`), if it says. */
  readonly maxBytes?: number;
  /** A certificate the system doesn't trust is trusted for it. */
  readonly pinned: boolean;
}

/** A certificate the system doesn't trust, for the user to decide on. */
export interface MailServerCertificate {
  /** SHA-256 of the certificate (DER), hex, colon-separated. */
  readonly sha256: string;
  readonly subject: string;
  readonly issuer: string;
  /** ISO 8601. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** The host names it's for. */
  readonly names: readonly string[];
  /** Which server showed it (`caldav`: the calendar server; `sieve`: the filter server). */
  readonly server: MailServerRole;
}

/** Which of an account's servers something concerns. */
export type MailServerRole = "imap" | "smtp" | "caldav" | "sieve";

/**
 * Why a call to a mail server failed:
 * - `auth`: the server refused the password or sign-in.
 * - `untrusted`: the certificate isn't trusted (see `certificate`); on an
 *   existing account, a certificate other than the pinned one.
 * - `tls`: TLS or STARTTLS failed (or the server offers no encryption).
 * - `unreachable`: no connection (offline, wrong host or port, timeout).
 * - `oauth`: the Yahoo/AOL sign-in failed or was cancelled (`message`).
 * - `notFound`: the message, folder or account is gone.
 * - `exists`: a folder with that name exists.
 * - `tooBig`: the SMTP server refused the mail's size.
 * - `rejected`: the SMTP server refused a recipient or the mail, or the
 *   filter server a script (`message`).
 * - `changed`: the filters were changed elsewhere since they were read.
 * - `server`: the server answered NO/BAD (`message` is its text).
 */
export type MailServerErrorKind =
  | "auth"
  | "untrusted"
  | "tls"
  | "unreachable"
  | "oauth"
  | "notFound"
  | "exists"
  | "tooBig"
  | "rejected"
  | "changed"
  | "server";

/** See {@link MailServerErrorKind}. The native side answers with its JSON. */
export class MailServerError extends Error {
  override readonly name = "MailServerError";
  readonly kind: MailServerErrorKind;
  /** Which server it concerns, when it matters (adding an account). */
  readonly server: MailServerRole | undefined;
  readonly certificate: MailServerCertificate | undefined;

  constructor(
    kind: MailServerErrorKind,
    message: string,
    options: {
      readonly server?: MailServerRole;
      readonly certificate?: MailServerCertificate;
    } = {},
  ) {
    super(message);
    this.kind = kind;
    this.server = options.server;
    this.certificate = options.certificate;
  }
}

/** Adding and keeping mail server accounts (the apps only). */
export interface MailServerAccounts {
  /** Looks up an address's server settings. */
  readonly discover: (address: string) => Promise<MailServerDiscovery>;
  /**
   * Logs in to IMAP and SMTP and, if both work, adds the account (a known
   * one is replaced). Rejects with {@link MailServerError}.
   */
  readonly add: (setup: MailServerSetup) => Promise<AccountHandle>;
  /** What's kept about an account (settings, sign-in; no secrets). */
  readonly info: (
    accountId: string,
  ) => Promise<MailServerAccountInfo | undefined>;
  /** Forgets an account's trusted certificate. */
  readonly forgetCertificate: (accountId: string) => Promise<void>;
  /**
   * The Yahoo/AOL app registration in use, if any, and where it comes from
   * (the build's `.env.local`, or entered in this app).
   */
  readonly oauthClient: (provider: MailServerOAuth) =>
    | {
        readonly client: MailServerOAuthClient;
        readonly source: "build" | "app";
      }
    | undefined;
  /** Keeps a Yahoo/AOL app registration entered in the app. */
  readonly setOAuthClient: (
    provider: MailServerOAuth,
    client: MailServerOAuthClient,
  ) => void;
}

/** True if `error` is a {@link MailServerError}. */
export function isMailServerError(error: unknown): error is MailServerError {
  return error instanceof MailServerError;
}
