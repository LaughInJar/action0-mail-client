import type { Draft, DraftInput } from "./compose";
import type {
  AttachmentId,
  Cursor,
  DraftId,
  MailboxId,
  MessageId,
} from "./ids";
import type {
  EmailAddress,
  Mailbox,
  MailboxKind,
  Message,
  MessageFlags,
  MessageSummary,
  Page,
} from "./model";

/**
 * What a provider supports. The UI checks capabilities instead of branching
 * on the provider type. Further write capabilities (move, add label, ...)
 * are added together with the features that need them.
 */
export interface ProviderCapabilities {
  /** Mailbox kinds this account uses. Gmail: `label` and `view`. Exchange: `folder`. */
  readonly mailboxKinds: readonly MailboxKind[];
  /** Supports {@link MailProvider.archive} and {@link MailProvider.unarchive}. */
  readonly archive: boolean;
  /** Flags that {@link MailProvider.setFlags} can change. */
  readonly settableFlags: readonly (keyof MessageFlags)[];
  /** Supports {@link MailProvider.move}. */
  readonly move: boolean;
  /** Supports {@link MailProvider.setLabels}: memberships can be added and removed freely. */
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

/** Result of a write operation. */
export interface MutationResult {
  /**
   * Messages whose id changed because they moved (IMAP UIDs are per
   * folder). Callers replace old ids with new ones. Absent for Gmail.
   */
  readonly idMap?: ReadonlyMap<MessageId, MessageId>;
}

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

  /** A complete message including its (unsanitized) body. */
  getMessage(id: MessageId, signal?: AbortSignal): Promise<Message>;

  /** Raw content of an attachment or inline part. */
  getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<Blob>;

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
}
