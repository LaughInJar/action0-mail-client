import type { AttachmentId, Cursor, MailboxId, MessageId } from "./ids";
import type {
  Mailbox,
  MailboxKind,
  Message,
  MessageSummary,
  Page,
} from "./model";

/**
 * What a provider supports. The UI checks capabilities instead of branching
 * on the provider type. Write capabilities (archive, move, add label, ...)
 * are added together with the features that need them.
 */
export interface ProviderCapabilities {
  /** Mailbox kinds this account uses. Gmail: `label` and `view`. Exchange: `folder`. */
  readonly mailboxKinds: readonly MailboxKind[];
}

/** Parameters of {@link MailProvider.listMessages}. */
export interface ListMessagesQuery {
  readonly mailboxId: MailboxId;
  /** Cursor from the previous page; omit for the first page. */
  readonly cursor?: Cursor;
  /** Maximum number of messages to return. */
  readonly limit: number;
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
}
