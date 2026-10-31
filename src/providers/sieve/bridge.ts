/**
 * The contract between the Sieve filter provider and the apps' native side
 * (ManageSieve, RFC 5804). The native side finds a mail server account's
 * filter server, logs in with the account's login (the UI never sees it)
 * and its trusted certificate, and moves the active script back and forth;
 * reading and writing Sieve happens in TypeScript.
 *
 * Every method rejects with a `MailServerError` (`server: "sieve"` where it
 * concerns the filter server): `notFound` when no filter server answers,
 * `changed` when the script isn't the one read before, `rejected` when the
 * server refuses a script (its text says why).
 */

/** Where a filter server is. */
export interface SieveServer {
  readonly host: string;
  /** Usually 4190. */
  readonly port: number;
}

/** A mail server account's filter server, as found or chosen. */
export interface SieveServerInfo extends SieveServer {
  /** The Sieve extensions it supports (`fileinto`, `body`, `vacation`, …), lower case. */
  readonly extensions: readonly string[];
  /** The user entered it ("Use another server"), rather than it being found. */
  readonly chosen: boolean;
}

/** The script the server runs. */
export interface SieveScript {
  /** Its name; `undefined` when no script is active. */
  readonly name?: string;
  /** Its text ("" when no script is active). */
  readonly script: string;
  readonly extensions: readonly string[];
}

/** What {@link SieveBridge.write} stores. */
export interface SieveWrite {
  /** The script's name: the active one's, or "action0" for a new one. */
  readonly name: string;
  readonly script: string;
  /**
   * The text this change was made from: the native side writes only if
   * the server still has exactly this (else `changed`).
   */
  readonly expected: string;
  /** Make it the active script (there was none). */
  readonly activate: boolean;
}

/** See the module docs. `key` is the account's `imap:<address>`. */
export interface SieveBridge {
  /**
   * The account's filter server: the one kept for it, else one found (the
   * provider's known server, else the IMAP host on port 4190), which is
   * then kept. Rejects with `notFound` when there is none.
   */
  readonly find: (key: string) => Promise<SieveServerInfo>;
  /**
   * Uses this server from now on (it's checked by logging in first), or
   * forgets the kept one (`null`), so the next {@link find} looks again.
   */
  readonly setServer: (
    key: string,
    server: SieveServer | null,
  ) => Promise<SieveServerInfo | null>;
  /**
   * The kept server without looking for one (`null` if none is kept yet):
   * cheap, for the automatic reply notice.
   */
  readonly known: (key: string) => Promise<SieveServerInfo | null>;
  /** The active script. */
  readonly read: (key: string) => Promise<SieveScript>;
  /** Stores a script, see {@link SieveWrite}. */
  readonly write: (key: string, request: SieveWrite) => Promise<void>;
}
