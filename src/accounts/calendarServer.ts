/**
 * Calendar servers (CalDAV), which the apps' native side talks to: finding
 * where an address's calendars are, connecting with the mail account's
 * login or a separate one, and what's kept. Provider-neutral, so the
 * calendar setup dialog and the Add account wizard can use it; failures
 * are {@link MailServerError}s (`untrusted` with `server: "caldav"`, and
 * `notFound` when no calendar server answers at the addresses tried).
 */
export type { MailServerError } from "./mailServer";

/** A place a calendar server may be, best first. */
export interface CalendarServerCandidate {
  /** An `https://` (rarely `http://`) address to start from. */
  readonly url: string;
  /**
   * Where it comes from: action0's list of providers, the domain's DNS
   * (SRV/TXT, desktop only), its `/.well-known/caldav`, or the mail server.
   */
  readonly source: "provider" | "dns" | "wellKnown" | "mailHost";
  /** The provider's name, from action0's list ("Fastmail"). */
  readonly providerName?: string;
  /** Where the provider's users make an app password. */
  readonly appPasswordUrl?: string;
}

/** How the calendar server is signed in to. */
export type CalendarServerLogin =
  /** With the mail account's login (password or Yahoo/AOL sign-in). */
  | { readonly sameAsMail: true }
  | { readonly username: string; readonly password: string };

/** What connecting a calendar server needs. */
export interface CalendarServerSetup {
  /**
   * The source: `imap:<address>` for a mail account's calendars, an
   * existing `caldav:<id>` to change one, or absent for a new
   * calendar-only server (the native side makes its `caldav:<id>`).
   */
  readonly key?: string;
  /** A calendar-only server's name in the calendar list. */
  readonly label?: string;
  /** Addresses to try, in order: one typed in, or the candidates found. */
  readonly urls: readonly string[];
  readonly login: CalendarServerLogin;
  /** SHA-256 (hex, colon-separated) of a certificate the user chose to trust. */
  readonly trust?: string;
}

/** A connected calendar server, as the UI knows it (no secrets). */
export interface CalendarServerInfo {
  /** `imap:<address>` or `caldav:<id>`. */
  readonly key: string;
  /** Calendar-only: its name; a mail account's: the account's address. */
  readonly label: string;
  /** The calendar home (`calendar-home-set`): where the calendars are listed. */
  readonly home: string;
  /** The user's DAV principal. */
  readonly principal: string;
  /** The user's own calendar address (`calendar-user-address-set`), without `mailto:`. */
  readonly address?: string;
  /** The login name ("" when it's the mail account's). */
  readonly username: string;
  readonly sameAsMail: boolean;
  /**
   * The server sends invitations, updates and replies itself (RFC 6638,
   * `calendar-auto-schedule`).
   */
  readonly scheduling: boolean;
  /** A certificate the system doesn't trust is trusted for it. */
  readonly pinned: boolean;
  /**
   * The address book home (CardDAV `addressbook-home-set`), if the login
   * has address books (on the same server, or the provider's contacts host).
   */
  readonly contacts?: string;
  /** Address books were looked for (servers set up before contacts weren't). */
  readonly contactsChecked: boolean;
}

/** Connecting and keeping calendar servers (the apps only). */
export interface CalendarServers {
  /** Where an address's calendar server may be (the mail host as a last guess). */
  readonly discover: (
    address: string,
    mailHost?: string,
  ) => Promise<readonly CalendarServerCandidate[]>;
  /**
   * Signs in at the first address that is a calendar server, finds the
   * calendars and keeps the login. Rejects with {@link MailServerError}.
   */
  readonly connect: (setup: CalendarServerSetup) => Promise<CalendarServerInfo>;
  /** The connected servers (mail accounts' and calendar-only). */
  readonly list: () => Promise<readonly CalendarServerInfo[]>;
  /** Forgets a server's login (a mail account's calendars go back to "Set up"). */
  readonly remove: (key: string) => Promise<void>;
  /** Forgets its trusted certificate; it's refused again from then on. */
  readonly forgetCertificate: (key: string) => Promise<void>;
  /** Announces changes to {@link list}. */
  readonly subscribe: (listener: () => void) => () => void;
}
