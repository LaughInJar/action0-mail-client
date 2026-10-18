/**
 * Provider-agnostic domain model.
 *
 * The mailbox model follows JMAP (RFC 8621): a message belongs to a *set* of
 * mailboxes, and each mailbox declares whether membership is exclusive
 * (`folder`), non-exclusive (`label`) or computed (`view`). This covers Gmail
 * labels as well as Exchange and IMAP folders without provider-specific
 * branches in the UI.
 *
 * All values are plain, JSON-serializable data so the cache layer can persist
 * them unchanged.
 */
import type {
  AccountId,
  AttachmentId,
  Cursor,
  MailboxId,
  MessageId,
  ThreadId,
} from "./ids";

/** Every provider implementation the app knows about. */
export type ProviderType = "gmail" | "demo";

/** A connected mail account. Contains no credentials. */
export interface Account {
  readonly id: AccountId;
  readonly type: ProviderType;
  /** Primary address, also used as the login hint for re-authentication. */
  readonly email: string;
}

/**
 * How messages relate to a mailbox:
 * - `folder`: exclusive. A message is in exactly one folder (Exchange, IMAP).
 * - `label`: non-exclusive. A message can carry any number of labels (Gmail).
 * - `view`: virtual and query-backed (Gmail "All Mail", "Starred"). Never a
 *   drop target.
 */
export type MailboxKind = "folder" | "label" | "view";

/**
 * Special purpose of a mailbox. Same vocabulary as JMAP and IMAP SPECIAL-USE
 * (RFC 6154), so every provider can map onto it.
 */
export type MailboxRole =
  | "inbox"
  | "flagged"
  | "important"
  | "sent"
  | "drafts"
  | "all"
  | "archive"
  | "junk"
  | "trash";

/** Display order of mailboxes with a role, used for sorting siblings in the tree. */
export const MAILBOX_ROLE_ORDER: readonly MailboxRole[] = [
  "inbox",
  "flagged",
  "important",
  "sent",
  "drafts",
  "all",
  "archive",
  "junk",
  "trash",
];

/** Message counters of a mailbox. */
export interface MailboxCounts {
  readonly unread: number;
  readonly total: number;
}

/** A label, folder or view, as shown in the mailbox tree. */
export interface Mailbox {
  readonly id: MailboxId;
  /** Leaf display name, e.g. "Clients" for the Gmail label "Work/Clients". */
  readonly name: string;
  readonly parentId?: MailboxId;
  readonly kind: MailboxKind;
  readonly role?: MailboxRole;
  /**
   * `false` for grouping nodes that hold no messages themselves, e.g. IMAP
   * `\Noselect` folders or the Gmail "Categories" group.
   */
  readonly selectable: boolean;
  /** The user asked the provider to hide this mailbox from the folder list. */
  readonly hidden: boolean;
  /**
   * Users may put messages here or take them out: a target for moving and
   * labelling. False for computed views and system mailboxes like Sent.
   */
  readonly assignable: boolean;
  readonly counts?: MailboxCounts;
  readonly color?: { readonly background: string; readonly text: string };
}

/** A parsed address from an address header. */
export interface EmailAddress {
  readonly name?: string;
  readonly address: string;
}

/**
 * Per-message state that is *not* modelled as mailbox membership, even where
 * the provider stores it that way (Gmail's `UNREAD` and `STARRED` labels).
 */
export interface MessageFlags {
  readonly seen: boolean;
  readonly flagged: boolean;
}

/** What the message list needs to render one row. */
export interface MessageSummary {
  readonly id: MessageId;
  readonly threadId?: ThreadId;
  /**
   * Mailboxes the message is a member of. Contains one entry for folder-based
   * providers and any number for label-based ones. Never contains flag-like
   * labels such as `UNREAD` or `STARRED`.
   */
  readonly mailboxIds: readonly MailboxId[];
  readonly from?: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly subject: string;
  /** Short plain-text preview of the body. */
  readonly snippet: string;
  /** When the provider received the message, as an ISO 8601 string. */
  readonly receivedAt: string;
  readonly flags: MessageFlags;
  /** May be a heuristic in list views (Gmail's metadata format has no MIME parts). */
  readonly hasAttachments: boolean;
}

/** Metadata of an attachment or inline part. */
export interface AttachmentInfo {
  readonly id: AttachmentId;
  readonly filename: string;
  readonly mimeType: string;
  /** Size in bytes. */
  readonly size: number;
  /** Set for parts that the HTML body references as `cid:<contentId>`. */
  readonly contentId?: string;
}

/** Body of a message. Both parts are raw and **unsanitized**. */
export interface MessageBody {
  readonly html?: string;
  readonly text?: string;
}

/** A complete message, as shown in the reader. */
export interface Message extends MessageSummary {
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: readonly EmailAddress[];
  /** The `Message-ID` header (with angle brackets), for replies. */
  readonly internetMessageId?: string;
  /** Message-IDs from the `References` header, oldest first. */
  readonly references: readonly string[];
  readonly body: MessageBody;
  readonly attachments: readonly AttachmentInfo[];
}

/** One page of a paginated result. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Pass this back to get the next page. Absent on the last page. */
  readonly nextCursor?: Cursor;
}
