import type { AttachmentId, Cursor, MailboxId, MessageId } from "./ids";
import type {
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
}

/** Parameters of {@link MailProvider.listMessages}. */
export interface ListMessagesQuery {
  readonly mailboxId: MailboxId;
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

  /** Messages in a mailbox, newest first. */
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
}
