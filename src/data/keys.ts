import type { AccountId, MailboxId, MessageId } from "../core/ids";

/**
 * Query keys. The account comes first, so all data of an account can be
 * dropped with one `removeQueries({ queryKey: queryKeys.account(id) })`.
 */
export const queryKeys = {
  account: (accountId: AccountId) => ["acct", accountId] as const,
  mailboxes: (accountId: AccountId) =>
    ["acct", accountId, "mailboxes"] as const,
  messages: (accountId: AccountId, mailboxId: MailboxId) =>
    ["acct", accountId, "messages", mailboxId] as const,
  message: (accountId: AccountId, messageId: MessageId) =>
    ["acct", accountId, "message", messageId] as const,
  inlineImages: (accountId: AccountId, messageId: MessageId) =>
    ["acct", accountId, "inline-images", messageId] as const,
};
