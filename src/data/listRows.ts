import {
  messageKey,
  type AccountId,
  type MailboxId,
  type MessageId,
  type MessageKey,
} from "../core/ids";
import type { Mailbox, MessageSummary, ThreadSummary } from "../core/model";
import {
  belongsTo,
  threadBelongsTo,
  visibleMessages,
  type MessageChange,
} from "./optimistic";

/**
 * A row of the message list: one message, or one conversation. The URL
 * uses `id`, a message id either way: for a conversation, its oldest
 * message's (stable while replies come in). Focus and selection use `key`,
 * which also names the account (All inboxes lists several).
 */
export interface ListRow {
  readonly key: MessageKey;
  readonly accountId: AccountId;
  readonly id: MessageId;
  /** The message, or a conversation's newest message shown in this list. */
  readonly summary: MessageSummary;
  readonly thread?: ThreadSummary;
}

/** Rows for a message list of an account. */
export function messageRows(
  accountId: AccountId,
  items: readonly MessageSummary[],
): ListRow[] {
  return items.map((summary) => ({
    key: messageKey(accountId, summary.id),
    accountId,
    id: summary.id,
    summary,
  }));
}

/** Rows for a conversation list of an account's `mailbox`. */
export function threadRows(
  accountId: AccountId,
  threads: readonly ThreadSummary[],
  mailbox: Mailbox | undefined,
  isolating: ReadonlySet<MailboxId>,
): ListRow[] {
  return threads.flatMap((thread) => {
    const [oldest] = thread.messages;
    if (!oldest) return [];
    const shown = mailbox
      ? visibleMessages(thread, mailbox, isolating)
      : thread.messages;
    const newest = shown.at(-1) ?? thread.messages.at(-1) ?? oldest;
    return [
      {
        key: messageKey(accountId, oldest.id),
        accountId,
        id: oldest.id,
        summary: newest,
        thread,
      },
    ];
  });
}

/** Rows of an account that leave `mailbox`'s list with these changes. */
export function rowsLeaving(
  rows: readonly ListRow[],
  accountId: AccountId,
  mailbox: Mailbox,
  changes: readonly MessageChange[],
  isolating: ReadonlySet<MailboxId>,
): Set<MessageKey> {
  const byId = new Map(changes.map((change) => [change.id, change]));
  const leaving = new Set<MessageKey>();
  for (const row of rows) {
    if (row.accountId !== accountId) continue;
    if (!row.thread) {
      const change = byId.get(row.id);
      if (
        change &&
        (change.deleted === true ||
          !belongsTo(mailbox, change.after, isolating))
      )
        leaving.add(row.key);
      continue;
    }
    if (!row.thread.messages.some((message) => byId.has(message.id))) continue;
    const after = {
      ...row.thread,
      messages: row.thread.messages.flatMap((message) => {
        const change = byId.get(message.id);
        if (!change) return [message];
        return change.deleted === true ? [] : [change.after];
      }),
    };
    if (!threadBelongsTo(mailbox, after, isolating)) leaving.add(row.key);
  }
  return leaving;
}
