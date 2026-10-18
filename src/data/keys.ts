import type { QueryKey } from "@tanstack/react-query";
import type {
  AccountId,
  AttachmentId,
  MailboxId,
  MessageId,
} from "../core/ids";
import type { MessageOrder } from "../core/provider";

/** Which message list: a mailbox's messages, or only those matching a search, by date. */
export interface ListSpec {
  readonly mailboxId: MailboxId;
  /** Provider search syntax; omitted (never blank) for the whole mailbox. */
  readonly search?: string;
  readonly order: MessageOrder;
}

/**
 * Query keys. The account comes first, so all data of an account can be
 * dropped with one `removeQueries({ queryKey: queryKeys.account(id) })`.
 */
export const queryKeys = {
  account: (accountId: AccountId) => ["acct", accountId] as const,
  mailboxes: (accountId: AccountId) =>
    ["acct", accountId, "mailboxes"] as const,
  /** Prefix of every list of a mailbox (all searches and orders). */
  messages: (accountId: AccountId, mailboxId: MailboxId) =>
    ["acct", accountId, "messages", mailboxId] as const,
  /** One list. The mailbox stays at index 3, see {@link listSpecOfKey}. */
  messageList: (accountId: AccountId, { mailboxId, search, order }: ListSpec) =>
    [
      "acct",
      accountId,
      "messages",
      mailboxId,
      { search: search ?? "", order },
    ] as const,
  message: (accountId: AccountId, messageId: MessageId) =>
    ["acct", accountId, "message", messageId] as const,
  inlineImages: (accountId: AccountId, messageId: MessageId) =>
    ["acct", accountId, "inline-images", messageId] as const,
  attachment: (
    accountId: AccountId,
    messageId: MessageId,
    attachmentId: AttachmentId,
  ) => ["acct", accountId, "attachment", messageId, attachmentId] as const,
};

/** The list a {@link queryKeys.messageList} key stands for; undefined for other keys. */
export function listSpecOfKey(key: QueryKey): ListSpec | undefined {
  const [, , kind, mailboxId, view] = key;
  if (kind !== "messages" || typeof mailboxId !== "string") return undefined;
  const { search = "", order = "newest" } = (view ?? {}) as {
    search?: string;
    order?: MessageOrder;
  };
  return {
    mailboxId: mailboxId as MailboxId,
    order,
    ...(search ? { search } : {}),
  };
}
