import type { MailboxId, MessageId } from "../core/ids";
import type { Mailbox, MessageSummary, ThreadSummary } from "../core/model";
import {
  belongsTo,
  threadBelongsTo,
  visibleMessages,
  type MessageChange,
} from "./optimistic";

/**
 * A row of the message list: one message, or one conversation. Focus,
 * selection and the URL use `id`, a message id either way: for a
 * conversation, its oldest message's (stable while replies come in).
 */
export interface ListRow {
  readonly id: MessageId;
  /** The message, or a conversation's newest message shown in this list. */
  readonly summary: MessageSummary;
  readonly thread?: ThreadSummary;
}

/** Rows for a message list. */
export function messageRows(items: readonly MessageSummary[]): ListRow[] {
  return items.map((summary) => ({ id: summary.id, summary }));
}

/** Rows for a conversation list of `mailbox`. */
export function threadRows(
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
    return [{ id: oldest.id, summary: newest, thread }];
  });
}

/** Rows that leave `mailbox`'s list with these changes. */
export function rowsLeaving(
  rows: readonly ListRow[],
  mailbox: Mailbox,
  changes: readonly MessageChange[],
  isolating: ReadonlySet<MailboxId>,
): Set<MessageId> {
  const byId = new Map(changes.map((change) => [change.id, change]));
  const leaving = new Set<MessageId>();
  for (const row of rows) {
    if (!row.thread) {
      const change = byId.get(row.id);
      if (
        change &&
        (change.deleted === true ||
          !belongsTo(mailbox, change.after, isolating))
      )
        leaving.add(row.id);
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
    if (!threadBelongsTo(mailbox, after, isolating)) leaving.add(row.id);
  }
  return leaving;
}
