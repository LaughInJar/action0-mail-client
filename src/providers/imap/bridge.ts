/**
 * What the apps' native side does for IMAP/SMTP accounts, and the JSON that
 * crosses to it: the contract between `ImapProvider` and `src-tauri/src/imap`
 * (implemented over Tauri commands in `src/platform/native/imap.ts`).
 *
 * The native side keeps the connections, the password or sign-in and the
 * server settings (in its vault), parses mail and talks IMAP and SMTP; the
 * provider turns that into the mailbox model (archive, trash, drafts, …).
 * Mail is never written to disk: the native side caches in memory only.
 *
 * Shapes mirror the domain model where they can, with plain strings for ids
 * (the provider brands them) and ISO 8601 dates. Adding an account uses the
 * provider-neutral shapes of `src/accounts/mailServer.ts`.
 */
import type {
  MailServerAccountInfo,
  MailServerDiscovery,
  MailServerSetup,
} from "../../accounts/mailServer";

/**
 * A folder or view, shaped like `Mailbox`. Folder ids are `f:<path>`;
 * views are `v:flagged` (flagged mail of every folder but Trash and Junk)
 * and `v:all` (every folder but Trash and Junk, hidden: "Everywhere").
 */
export interface ImapMailbox {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly kind: "folder" | "view";
  readonly role?:
    | "inbox"
    | "flagged"
    | "sent"
    | "drafts"
    | "all"
    | "archive"
    | "junk"
    | "trash";
  readonly selectable: boolean;
  readonly hidden: boolean;
  /** False for views, Sent and Drafts. */
  readonly assignable: boolean;
  readonly counts?: { readonly unread: number; readonly total: number };
}

/** An address of an address header. */
export interface ImapAddress {
  readonly name?: string;
  readonly address: string;
}

/**
 * A message as a list row, shaped like `MessageSummary`. Ids stay the same
 * when the message moves (the server's EMAILID or X-GM-MSGID, or
 * `l:<folder>:<uidvalidity>:<uid>` from where action0 first saw it).
 * `mailboxIds` holds its folder's id only.
 */
export interface ImapSummary {
  readonly id: string;
  /** The thread key (see {@link ImapThread}). */
  readonly threadId: string;
  readonly mailboxIds: readonly string[];
  readonly from?: ImapAddress;
  readonly to: readonly ImapAddress[];
  readonly subject: string;
  readonly snippet: string;
  /** When the server received it (INTERNALDATE), ISO 8601. */
  readonly receivedAt: string;
  readonly flags: { readonly seen: boolean; readonly flagged: boolean };
  readonly hasAttachments: boolean;
}

/**
 * A conversation: its key is the server's thread id (THREADID, X-GM-THRID)
 * or the first Message-ID of the References (else In-Reply-To, else the
 * message's own). Messages oldest first.
 */
export interface ImapThread {
  readonly id: string;
  readonly messages: readonly ImapSummary[];
}

/** A file or inline part of a message, shaped like `AttachmentInfo`. */
export interface ImapAttachment {
  /** The MIME part's path ("2", "1.3"). */
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentId?: string;
}

/** A whole message, shaped like `Message` minus what the provider derives. */
export interface ImapMessage extends ImapSummary {
  readonly cc: readonly ImapAddress[];
  readonly bcc: readonly ImapAddress[];
  readonly replyTo: readonly ImapAddress[];
  /** The `Message-ID` header, with angle brackets. */
  readonly internetMessageId?: string;
  /** The References header's ids, oldest first. */
  readonly references: readonly string[];
  readonly inReplyTo?: string;
  /** Raw and unsanitized. */
  readonly body: { readonly html?: string; readonly text?: string };
  readonly attachments: readonly ImapAttachment[];
  /** The `List-Unsubscribe` and `List-Unsubscribe-Post` headers. */
  readonly listUnsubscribe?: string;
  readonly listUnsubscribePost?: string;
  /** A `text/calendar` part's text (an invitation). */
  readonly calendar?: string;
  /** It's a draft (`\Draft`). */
  readonly draft: boolean;
}

/** A page of a list. */
export interface ImapPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** One change, shaped like `MailChange`. */
export type ImapChange =
  | { readonly kind: "added"; readonly message: ImapSummary }
  | { readonly kind: "updated"; readonly message: ImapSummary }
  | { readonly kind: "removed"; readonly id: string };

/** What a list asks for. */
export interface ImapListQuery {
  readonly mailboxId: string;
  /** Words, `-word`, `from:`, `to:`, `subject:`, `is:unread`, `is:starred`, `larger:`, `smaller:` (bytes, or `5K`, `2M`). */
  readonly search?: string;
  readonly order?: "newest" | "oldest";
  readonly cursor?: string;
  readonly limit: number;
}

/** The operations of `imap_call`, with what each one answers. */
export interface ImapCalls {
  readonly folders: { request: object; response: readonly ImapMailbox[] };
  readonly list: { request: ImapListQuery; response: ImapPage<ImapSummary> };
  readonly threads: {
    request: ImapListQuery;
    response: ImapPage<ImapThread>;
  };
  /** A conversation with every message, found in Inbox, Sent, Archive and the folder it's listed in. */
  readonly thread: {
    request: { readonly id: string };
    response: readonly ImapMessage[];
  };
  readonly message: { request: { readonly id: string }; response: ImapMessage };
  readonly flags: {
    request: {
      readonly ids: readonly string[];
      readonly seen?: boolean;
      readonly flagged?: boolean;
    };
    response: object;
  };
  /** Moves messages into a folder (MOVE, else COPY and expunge). */
  readonly move: {
    request: { readonly ids: readonly string[]; readonly to: string };
    response: object;
  };
  /** Deletes messages permanently. */
  readonly delete: {
    request: { readonly ids: readonly string[] };
    response: object;
  };
  /** Deletes every message of a folder permanently. */
  readonly empty: {
    request: { readonly mailboxId: string };
    response: { readonly deleted: number };
  };
  /** Marks a folder's or view's unread messages read; the ids it changed. */
  readonly markAllRead: {
    request: { readonly mailboxId: string };
    response: readonly string[];
  };
  /** Creates a folder (with the special use, where the server allows it). */
  readonly createFolder: {
    request: {
      readonly name: string;
      readonly parentId?: string;
      readonly role?: "archive" | "trash" | "junk" | "sent" | "drafts";
    };
    response: ImapMailbox;
  };
  /** Renames or moves a folder (its subfolders move along). */
  readonly updateFolder: {
    request: {
      readonly id: string;
      readonly name?: string;
      /** `null`: to the top level. */
      readonly parentId?: string | null;
    };
    response: ImapMailbox;
  };
  /**
   * Deletes a folder: into Trash (renamed below it), or for good if it's
   * in Trash already.
   */
  readonly deleteFolder: {
    request: { readonly id: string };
    response: object;
  };
  /** What changed since `token`; without one, just a starting token. */
  readonly changes: {
    request: { readonly token?: string };
    response: {
      readonly token: string;
      readonly reset: boolean;
      readonly changes: readonly ImapChange[];
    };
  };
}

export type ImapCallName = keyof ImapCalls;

/** What `imap_bytes` fetches: the whole message, or one part decoded. */
export type ImapBytesRequest =
  | { readonly kind: "raw"; readonly id: string }
  | { readonly kind: "part"; readonly id: string; readonly part: string };

/** See the module docs. Rejects with `MailServerError`. */
export interface ImapBridge {
  /** Looks up an address's server settings. */
  readonly discover: (address: string) => Promise<MailServerDiscovery>;
  /**
   * Logs in to IMAP and SMTP with the setup and, if both work, keeps the
   * account (a known one is replaced). Opens the browser for Yahoo/AOL.
   */
  readonly connect: (setup: MailServerSetup) => Promise<MailServerAccountInfo>;
  /** The kept accounts, and whether they survive restarts (keychain). */
  readonly accounts: () => Promise<{
    readonly persistent: boolean;
    readonly accounts: readonly MailServerAccountInfo[];
  }>;
  /** A new password, or a new Yahoo/AOL sign-in (`password` absent). */
  readonly reconnect: (key: string, password?: string) => Promise<void>;
  /** Forgets the account (and its trusted certificate). */
  readonly remove: (key: string) => Promise<void>;
  /** Forgets a trusted certificate; it's refused again from then on. */
  readonly forgetCertificate: (key: string) => Promise<void>;
  readonly call: <K extends ImapCallName>(
    key: string,
    name: K,
    request: ImapCalls[K]["request"],
    signal?: AbortSignal,
  ) => Promise<ImapCalls[K]["response"]>;
  readonly bytes: (
    key: string,
    request: ImapBytesRequest,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  /** Stores a message in a folder; its id. */
  readonly append: (
    key: string,
    folder: { readonly mailboxId: string; readonly flags: readonly string[] },
    message: Uint8Array,
  ) => Promise<{ readonly id: string }>;
  /** Sends a message over SMTP to these addresses. */
  readonly send: (
    key: string,
    envelope: { readonly from: string; readonly to: readonly string[] },
    message: Uint8Array,
  ) => Promise<void>;
}
