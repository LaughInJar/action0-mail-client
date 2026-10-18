declare const brand: unique symbol;

/**
 * Nominal typing helper: a `T` that the compiler keeps apart from other
 * branded `T`s, so a {@link MessageId} can't be passed where a
 * {@link MailboxId} is expected.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Identifies an account across all providers, e.g. `gmail:jane@example.com`. */
export type AccountId = Brand<string, "AccountId">;

/**
 * Identifies a mailbox (label, folder or view) within one account.
 * Opaque: only the provider that issued it may interpret it.
 */
export type MailboxId = Brand<string, "MailboxId">;

/**
 * Identifies a message within one account. Opaque, and not guaranteed to be
 * stable across moves (IMAP UIDs change when a message changes folders).
 */
export type MessageId = Brand<string, "MessageId">;

/** Identifies a conversation within one account. Opaque. */
export type ThreadId = Brand<string, "ThreadId">;

/** Identifies an attachment within one message. Opaque. */
export type AttachmentId = Brand<string, "AttachmentId">;

/**
 * Identifies a draft within one account. Opaque, and different from the id
 * of the draft's message (Gmail gives the message a new id on every save).
 */
export type DraftId = Brand<string, "DraftId">;

/**
 * Opaque pagination cursor, e.g. a Gmail `pageToken`, a Graph `@odata.nextLink`
 * or an IMAP UID range. Callers pass it back unchanged.
 */
export type Cursor = Brand<string, "Cursor">;

/** Brands a raw string as an {@link AccountId}. */
export const asAccountId = (value: string): AccountId => value as AccountId;
/** Brands a raw string as a {@link MailboxId}. */
export const asMailboxId = (value: string): MailboxId => value as MailboxId;
/** Brands a raw string as a {@link MessageId}. */
export const asMessageId = (value: string): MessageId => value as MessageId;
/** Brands a raw string as a {@link ThreadId}. */
export const asThreadId = (value: string): ThreadId => value as ThreadId;
/** Brands a raw string as an {@link AttachmentId}. */
export const asAttachmentId = (value: string): AttachmentId =>
  value as AttachmentId;
/** Brands a raw string as a {@link DraftId}. */
export const asDraftId = (value: string): DraftId => value as DraftId;
/** Brands a raw string as a {@link Cursor}. */
export const asCursor = (value: string): Cursor => value as Cursor;
