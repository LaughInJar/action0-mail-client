import type { QueryKey } from "@tanstack/react-query";
import type {
  AccountId,
  AttachmentId,
  MailboxId,
  MessageId,
  ThreadId,
} from "../core/ids";
import type { CalendarId, DateRange } from "../core/calendar";
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
  /** Prefix of every conversation list of a mailbox. */
  threads: (accountId: AccountId, mailboxId: MailboxId) =>
    ["acct", accountId, "threads", mailboxId] as const,
  /** One conversation list; like {@link queryKeys.messageList}. */
  threadList: (accountId: AccountId, { mailboxId, search, order }: ListSpec) =>
    [
      "acct",
      accountId,
      "threads",
      mailboxId,
      { search: search ?? "", order },
    ] as const,
  thread: (accountId: AccountId, threadId: ThreadId) =>
    ["acct", accountId, "thread", threadId] as const,
  senders: (accountId: AccountId) => ["acct", accountId, "senders"] as const,
  message: (accountId: AccountId, messageId: MessageId) =>
    ["acct", accountId, "message", messageId] as const,
  inlineImages: (accountId: AccountId, messageId: MessageId) =>
    ["acct", accountId, "inline-images", messageId] as const,
  attachment: (
    accountId: AccountId,
    messageId: MessageId,
    attachmentId: AttachmentId,
  ) => ["acct", accountId, "attachment", messageId, attachmentId] as const,
  /**
   * Everything of a calendar source: under its account (so it goes with
   * the account), or `["ics", key]` for iCal subscriptions.
   */
  calendarSource: (source: string) =>
    source.startsWith("ics:")
      ? (["ics", source] as const)
      : (["acct", source, "calendar"] as const),
  calendars: (source: string) =>
    [...queryKeys.calendarSource(source), "calendars"] as const,
  /** Prefix of every event list of a source. */
  calendarEvents: (source: string) =>
    [...queryKeys.calendarSource(source), "events"] as const,
  events: (source: string, calendarId: CalendarId, range: DateRange) =>
    [
      ...queryKeys.calendarEvents(source),
      calendarId,
      range.from,
      range.to,
    ] as const,
  invitation: (accountId: AccountId, uid: string) =>
    ["acct", accountId, "invitation", uid] as const,
  /** An event read fresh for the editor (not persisted). */
  eventForEdit: (source: string, eventId: string) =>
    [...queryKeys.calendarSource(source), "edit", eventId] as const,
};

/**
 * The list a {@link queryKeys.messageList} or {@link queryKeys.threadList}
 * key stands for; undefined for other keys.
 */
export function listSpecOfKey(key: QueryKey): ListSpec | undefined {
  const [, , kind, mailboxId, view] = key;
  if (
    (kind !== "messages" && kind !== "threads") ||
    typeof mailboxId !== "string"
  )
    return undefined;
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
