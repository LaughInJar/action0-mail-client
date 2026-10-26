import type { Draft, DraftInput } from "./compose";
import type {
  AttachmentId,
  Cursor,
  DraftId,
  MailboxId,
  MessageId,
  SyncToken,
  ThreadId,
} from "./ids";
import type {
  EmailAddress,
  Mailbox,
  MailboxColor,
  MailboxKind,
  Message,
  MessageFlags,
  MessageSummary,
  Page,
  Sender,
  Thread,
  ThreadSummary,
} from "./model";

/**
 * What a provider supports. The UI checks capabilities instead of branching
 * on the provider type.
 */
export interface ProviderCapabilities {
  /**
   * Mailbox kinds this account uses. Gmail: `label` and `view`. Outlook:
   * `folder`, `label` (its categories) and `view`.
   */
  readonly mailboxKinds: readonly MailboxKind[];
  /** Supports {@link MailProvider.archive} and {@link MailProvider.unarchive}. */
  readonly archive: boolean;
  /** Flags that {@link MailProvider.setFlags} can change. */
  readonly settableFlags: readonly (keyof MessageFlags)[];
  /** Supports {@link MailProvider.move}. */
  readonly move: boolean;
  /**
   * Supports {@link MailProvider.setLabels}: label memberships can be added
   * and removed freely (Gmail labels; Outlook categories, next to folders).
   */
  readonly labels: boolean;
  /** Supports {@link MailProvider.trash} and {@link MailProvider.untrash}. */
  readonly trash: boolean;
  /** Supports {@link MailProvider.reportSpam} and {@link MailProvider.notSpam}. */
  readonly spam: boolean;
  /** Supports {@link MailProvider.deleteForever} and {@link MailProvider.emptyMailbox}. */
  readonly deleteForever: boolean;
  /** Supports drafts and sending ({@link MailProvider.saveDraft} and friends). */
  readonly compose: boolean;
  /** Supports {@link MailProvider.searchContacts}. */
  readonly contacts: boolean;
  /** Most bytes of attachments one mail may carry (inline images included). */
  readonly maxAttachmentBytes: number;
  /**
   * Supports {@link MailProvider.createMailbox}, {@link MailProvider.updateMailbox}
   * and {@link MailProvider.deleteMailbox} for the user's own mailboxes
   * (assignable ones without a role).
   */
  readonly manageMailboxes: boolean;
  /**
   * What can be changed about the user's own mailboxes, per kind (an
   * Outlook account has folders and categories, which differ). Kinds that
   * are missing can't be created or changed.
   */
  readonly mailboxEditing: Partial<Record<MailboxKind, MailboxEditing>>;
  /** Supports {@link MailProvider.listThreads} and {@link MailProvider.getThread}. */
  readonly threads: boolean;
  /** Supports {@link MailProvider.listSenders}. */
  readonly senders: boolean;
  /**
   * The user manages the account's From addresses in action0
   * ({@link MailProvider.saveSenders}): IMAP and Graph, which can't list
   * aliases. Gmail lists its own send-as addresses.
   */
  readonly editSenders: boolean;
  /** Supports {@link MailProvider.getRawMessage} (a message's headers and source). */
  readonly rawSource: boolean;
  /**
   * Where {@link MailProvider.updateSignature} keeps signatures: with the
   * provider (Gmail), or only in this browser (Graph can't read Outlook's).
   */
  readonly signatureStore: "provider" | "browser";
  /**
   * Whose words the interface uses for mailboxes with a role: Gmail's
   * ("Spam", "Starred"), Outlook's ("Junk Email", "Deleted Items") or a
   * mail program's ("Junk", "Trash", "Flagged"). Unset: Outlook's for
   * folder accounts, else Gmail's.
   */
  readonly roleNames?: "gmail" | "outlook" | "client";
}

/** Date order of a message list. */
export type MessageOrder = "newest" | "oldest";

/**
 * Parameters of {@link MailProvider.listMessages}.
 *
 * Searching "everywhere" means searching the account's mailbox with the role
 * `all` (Gmail: All Mail); accounts without one can only search a mailbox.
 */
export interface ListMessagesQuery {
  readonly mailboxId: MailboxId;
  /**
   * Only messages that match, in the provider's search syntax (Gmail: its
   * search operators). Plain words work with every provider. Omit for all.
   */
  readonly search?: string;
  /** Date order; defaults to `"newest"`. */
  readonly order?: MessageOrder;
  /** Cursor from the previous page; omit for the first page. */
  readonly cursor?: Cursor;
  /** Maximum number of messages to return. */
  readonly limit: number;
}

/** One change to an account's messages, as {@link MailProvider.changesSince} reports it. */
export type MailChange =
  /** A message arrived (or was created, e.g. sent or drafted). */
  | { readonly kind: "added"; readonly message: MessageSummary }
  /** Its mailboxes or flags changed. */
  | { readonly kind: "updated"; readonly message: MessageSummary }
  /** It's gone for good. */
  | { readonly kind: "removed"; readonly id: MessageId };

/** Result of {@link MailProvider.changesSince}. */
export interface ChangeSet {
  /** Pass this to the next call. */
  readonly token: SyncToken;
  /** Too many changes, or the token was too old: reload everything instead. */
  readonly reset: boolean;
  readonly changes: readonly MailChange[];
}

/** What can be changed about the user's own mailboxes of one kind. */
export interface MailboxEditing {
  /** {@link MailboxChange.name} works (Outlook categories can't be renamed). */
  readonly rename: boolean;
  /** Colours one may get; empty if colours can't be set. */
  readonly colors: readonly MailboxColor[];
  /** They can be nested ({@link MailboxChange.parentId}). */
  readonly nest: boolean;
  /**
   * They can be hidden from the folder list ({@link MailboxChange.hidden};
   * Gmail yes, Graph can't change it after a folder exists).
   */
  readonly hide: boolean;
}

/** A new mailbox, for {@link MailProvider.createMailbox}. */
export interface NewMailbox {
  /** Leaf name, e.g. "Clients" (never a path). */
  readonly name: string;
  /**
   * What to create, among {@link ProviderCapabilities.mailboxEditing};
   * defaults to the account's own kind (Outlook: a folder, not a category).
   */
  readonly kind?: MailboxKind;
  /** Mailbox to nest it in; omit for the top level. */
  readonly parentId?: MailboxId;
  /** One of the kind's {@link MailboxEditing.colors}. */
  readonly color?: MailboxColor;
  /** Hide it from the folder list. */
  readonly hidden?: boolean;
}

/**
 * Changes for {@link MailProvider.updateMailbox}; fields left out stay as
 * they are, `null` removes the parent (top level) or the colour.
 */
export interface MailboxChange {
  readonly name?: string;
  readonly parentId?: MailboxId | null;
  readonly color?: MailboxColor | null;
  readonly hidden?: boolean;
}

/** A From address as the user set it up (its signature is saved apart). */
export interface SenderSettings {
  readonly address: string;
  readonly name?: string;
  readonly replyTo?: EmailAddress;
  readonly bccSelf?: boolean;
  readonly isDefault: boolean;
}

/**
 * Result of a write operation; nothing for now. Message ids stay the same
 * across writes (see {@link MessageId}), so callers never re-key.
 */
export type MutationResult = Readonly<Record<string, never>>;

/**
 * Provider-agnostic access to one account's mail.
 *
 * Implementations translate between the provider's API and the domain model.
 * They do no caching (that is the data layer's job) and never open UI.
 * Every method rejects with a {@link MailError} on failure, except when
 * `signal` aborts, which rejects with the abort reason.
 */
export interface MailProvider {
  readonly capabilities: ProviderCapabilities;

  /** All mailboxes of the account, including hidden ones, in display order. */
  listMailboxes(signal?: AbortSignal): Promise<readonly Mailbox[]>;

  /** Messages in a mailbox (optionally only matching ones), by date. */
  listMessages(
    query: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>>;

  /**
   * Conversations with a message in the mailbox (optionally only matching
   * ones), ordered by their newest message. Each comes with all its
   * messages, as summaries.
   */
  listThreads(
    query: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<ThreadSummary>>;

  /** A complete conversation: every message with its (unsanitized) body. */
  getThread(id: ThreadId, signal?: AbortSignal): Promise<Thread>;

  /** A complete message including its (unsanitized) body. */
  getMessage(id: MessageId, signal?: AbortSignal): Promise<Message>;

  /** Raw content of an attachment or inline part. */
  getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<Blob>;

  /**
   * The message exactly as stored: RFC 5322 bytes with every header and
   * MIME part (only if {@link ProviderCapabilities.rawSource}). For
   * "Show original"; callers don't keep it.
   */
  getRawMessage(id: MessageId, signal?: AbortSignal): Promise<Uint8Array>;

  /**
   * Takes messages out of the inbox. Gmail removes the `INBOX` label;
   * folder-based providers move them to the archive-role folder.
   */
  archive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Puts archived messages back into the inbox (used for undo). */
  unarchive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Sets flags on messages; flags that are left out stay unchanged. */
  setFlags(
    ids: readonly MessageId[],
    flags: Partial<MessageFlags>,
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /**
   * Marks every unread message of a mailbox read (for views: what the view lists,
   * e.g. All mail without Trash/Spam). Returns the ids it changed, so the caller
   * can undo it by marking exactly those unread again.
   */
  markAllRead(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<readonly MessageId[]>;

  /**
   * Moves messages out of `from` (the list the user is in) into `to`.
   * Label-based providers add `to` and remove `from` unless it is a view;
   * folder-based providers move the messages.
   */
  move(
    ids: readonly MessageId[],
    target: { readonly from: MailboxId; readonly to: MailboxId },
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Adds and removes labels (only if {@link ProviderCapabilities.labels}). */
  setLabels(
    ids: readonly MessageId[],
    change: {
      readonly add: readonly MailboxId[];
      readonly remove: readonly MailboxId[];
    },
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Moves messages to the trash. They then appear in no other mailbox. */
  trash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Takes messages out of the trash, back where they were (Gmail) or into the inbox. */
  untrash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Reports messages as spam: into the junk mailbox, out of the inbox. */
  reportSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Not spam after all: out of the junk mailbox, into the inbox. */
  notSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /** Deletes messages permanently. Cannot be undone. */
  deleteForever(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult>;

  /**
   * Deletes every message in a trash- or junk-role mailbox permanently.
   * Rejects for any other mailbox.
   */
  emptyMailbox(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<{ readonly deleted: number }>;

  /**
   * Creates a draft (no `id`) or replaces one with new content. Returns the
   * draft's id and the id of its new message.
   */
  saveDraft(
    draft: DraftInput,
    signal?: AbortSignal,
  ): Promise<{ readonly id: DraftId; readonly messageId: MessageId }>;

  /** The draft whose message this is (a row in the drafts mailbox), if any. */
  draftIdOf(
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<DraftId | undefined>;

  /** A saved draft, to continue editing it. */
  getDraft(id: DraftId, signal?: AbortSignal): Promise<Draft>;

  /** Deletes a draft permanently. */
  deleteDraft(id: DraftId, signal?: AbortSignal): Promise<void>;

  /**
   * Sends a draft with the given (final) content. The draft is gone
   * afterwards; the sent message is in the sent mailbox.
   */
  sendDraft(
    draft: DraftInput & { readonly id: DraftId },
    signal?: AbortSignal,
  ): Promise<{ readonly messageId: MessageId }>;

  /**
   * People whose name or address matches `query`, best matches first (only
   * if {@link ProviderCapabilities.contacts}). Rejects with `unavailable`
   * when the account's contacts can't be read right now.
   */
  searchContacts(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly EmailAddress[]>;

  /**
   * What changed since `token` (including the app's own writes). Without a
   * token, returns just a starting token and no changes.
   */
  changesSince(
    token: SyncToken | undefined,
    signal?: AbortSignal,
  ): Promise<ChangeSet>;

  /**
   * Creates a mailbox (only if {@link ProviderCapabilities.manageMailboxes}).
   * Rejects with a readable message if the name is taken or not allowed.
   */
  createMailbox(spec: NewMailbox, signal?: AbortSignal): Promise<Mailbox>;

  /**
   * Renames, moves, recolours, hides or shows a mailbox. Mailboxes nested in
   * it move along. Returns the updated mailbox.
   */
  updateMailbox(
    id: MailboxId,
    change: MailboxChange,
    signal?: AbortSignal,
  ): Promise<Mailbox>;

  /**
   * Deletes a mailbox. Its messages stay (in their other mailboxes); what
   * happens to nested mailboxes is up to the provider. Cannot be undone.
   */
  deleteMailbox(id: MailboxId, signal?: AbortSignal): Promise<void>;

  /**
   * Sends the RFC 8058 one-click unsubscribe request to `url` (the
   * `oneClick` URL of a message's `unsubscribe`). Resolves once the request went out;
   * the sender's answer usually can't be read (browsers hide cross-site
   * responses). Rejects if the sender couldn't be reached.
   */
  oneClickUnsubscribe(url: string, signal?: AbortSignal): Promise<void>;

  /** The addresses the account can send from, the default first. */
  listSenders(signal?: AbortSignal): Promise<readonly Sender[]>;

  /**
   * Replaces the account's From addresses (only if
   * {@link ProviderCapabilities.editSenders}); the account's own address
   * stays first. `catchAll`: domains whose every address is the user's.
   */
  saveSenders(
    senders: readonly SenderSettings[],
    catchAll: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>;
  /** Domains the user marked as catch-all ([] without `editSenders`). */
  catchAllDomains(signal?: AbortSignal): Promise<readonly string[]>;
  /**
   * Replaces the signature of one of the {@link listSenders} addresses ("" for
   * none). Rejects with `unavailable` when the account didn't grant the
   * permission to change settings.
   */
  updateSignature(
    address: string,
    html: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
