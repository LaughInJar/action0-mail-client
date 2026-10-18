import type { InfiniteData } from "@tanstack/react-query";
import type { Cursor, MailboxId } from "../core/ids";
import type { MailIntent, MessageChange } from "../core/intents";
import type { Mailbox, Message, MessageSummary, Page } from "../core/model";
import type { ProviderCapabilities } from "../core/provider";

/** Cached shape of a message list (an infinite query). */
export type MessageListData = InfiniteData<
  Page<MessageSummary>,
  Cursor | undefined
>;

export type { MessageChange };

/**
 * Predicts the effect of an intent on the given messages. Messages that
 * wouldn't change (archiving something that isn't in the inbox, marking a
 * read message read) are left out, so an empty result means "nothing to do".
 *
 * Archive follows the mailbox model: label-based providers lose the inbox
 * membership; folder-based providers also gain the archive-role folder.
 */
export function planChanges(
  intent: MailIntent,
  current: readonly MessageSummary[],
  mailboxes: readonly Mailbox[],
  capabilities: ProviderCapabilities,
): MessageChange[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  const inbox = roleId(mailboxes, "inbox");
  const archiveFolder = capabilities.mailboxKinds.includes("folder")
    ? roleId(mailboxes, "archive")
    : undefined;

  const kindOf = new Map(
    mailboxes.map((mailbox) => [mailbox.id, mailbox.kind]),
  );
  const context: ApplyContext = { inbox, archiveFolder, kindOf };

  const changes: MessageChange[] = [];
  for (const id of new Set(intent.ids)) {
    const before = byId.get(id);
    if (!before) continue;
    const after = apply(intent, before, context);
    if (after) changes.push({ id, before, after });
  }
  return changes;
}

interface ApplyContext {
  readonly inbox: MailboxId | undefined;
  readonly archiveFolder: MailboxId | undefined;
  readonly kindOf: ReadonlyMap<MailboxId, Mailbox["kind"]>;
}

/** The summary with new memberships, or undefined if they don't change. */
function withMailboxes(
  message: MessageSummary,
  mailboxIds: readonly MailboxId[],
): MessageSummary | undefined {
  const next = [...new Set(mailboxIds)];
  const same =
    next.length === message.mailboxIds.length &&
    next.every((id) => message.mailboxIds.includes(id));
  return same ? undefined : { ...message, mailboxIds: next };
}

function apply(
  intent: MailIntent,
  message: MessageSummary,
  { inbox, archiveFolder, kindOf }: ApplyContext,
): MessageSummary | undefined {
  switch (intent.kind) {
    case "archive": {
      if (inbox === undefined || !message.mailboxIds.includes(inbox)) {
        return undefined;
      }
      const remaining = message.mailboxIds.filter((id) => id !== inbox);
      return {
        ...message,
        mailboxIds:
          archiveFolder === undefined
            ? remaining
            : [...remaining, archiveFolder],
      };
    }
    case "unarchive": {
      if (inbox === undefined || message.mailboxIds.includes(inbox)) {
        return undefined;
      }
      return {
        ...message,
        mailboxIds: [
          inbox,
          ...message.mailboxIds.filter((id) => id !== archiveFolder),
        ],
      };
    }
    case "set-flags": {
      const flags = { ...message.flags, ...intent.flags };
      if (
        flags.seen === message.flags.seen &&
        flags.flagged === message.flags.flagged
      ) {
        return undefined;
      }
      return { ...message, flags };
    }
    case "move": {
      const isFolder = (id: MailboxId) => kindOf.get(id) === "folder";
      // Folders are exclusive: leave every folder. Labels: leave `from`, unless it's a view.
      const kept = isFolder(intent.to)
        ? message.mailboxIds.filter((id) => !isFolder(id))
        : message.mailboxIds.filter(
            (id) => id !== intent.from || kindOf.get(intent.from) === "view",
          );
      return withMailboxes(message, [...kept, intent.to]);
    }
    case "set-labels":
      return withMailboxes(message, [
        ...message.mailboxIds.filter((id) => !intent.remove.includes(id)),
        ...intent.add,
      ]);
  }
}

/** Whether a message shows up in the list of `mailbox`. */
export function belongsTo(mailbox: Mailbox, message: MessageSummary): boolean {
  if (mailbox.role === "flagged") return message.flags.flagged;
  if (mailbox.kind === "view") return true;
  return message.mailboxIds.includes(mailbox.id);
}

/**
 * Applies changes to a cached message list: updates rows, removes rows that
 * no longer belong to the mailbox, and re-inserts rows that came back (undo)
 * at their date position, as far as the loaded pages reach.
 */
export function patchList(
  data: MessageListData,
  mailbox: Mailbox,
  changes: readonly MessageChange[],
): MessageListData {
  const byId = new Map(changes.map((change) => [change.id, change]));
  let pages: Page<MessageSummary>[] = data.pages.map((page) => ({
    ...page,
    items: page.items.flatMap((item) => {
      const change = byId.get(item.id);
      if (!change) return [item];
      return belongsTo(mailbox, change.after)
        ? [
            {
              ...item,
              mailboxIds: change.after.mailboxIds,
              flags: change.after.flags,
            },
          ]
        : [];
    }),
  }));

  const present = new Set(
    pages.flatMap((page) => page.items.map((item) => item.id)),
  );
  const returning = changes
    .filter(
      (change) =>
        !present.has(change.id) &&
        belongsTo(mailbox, change.after) &&
        !belongsTo(mailbox, change.before),
    )
    .map((change) => change.after);
  for (const row of returning) pages = insertByDate(pages, row);

  return { ...data, pages };
}

function insertByDate(
  pages: Page<MessageSummary>[],
  row: MessageSummary,
): Page<MessageSummary>[] {
  for (const [pageIndex, page] of pages.entries()) {
    const index = page.items.findIndex(
      (item) => item.receivedAt < row.receivedAt,
    );
    if (index !== -1) {
      const items = [...page.items];
      items.splice(index, 0, row);
      return pages.map((p, i) => (i === pageIndex ? { ...p, items } : p));
    }
  }
  // Older than everything loaded: append only if there's nothing more to load.
  const last = pages.at(-1);
  if (!last || last.nextCursor !== undefined) return pages;
  return pages.map((p, i) =>
    i === pages.length - 1 ? { ...p, items: [...p.items, row] } : p,
  );
}

/** Applies a change to a cached full message. */
export function patchMessage(message: Message, change: MessageChange): Message {
  return {
    ...message,
    mailboxIds: change.after.mailboxIds,
    flags: change.after.flags,
  };
}

/** Adjusts total and unread counts of the mailbox list. */
export function patchCounts(
  mailboxes: readonly Mailbox[],
  changes: readonly MessageChange[],
): Mailbox[] {
  return mailboxes.map((mailbox) => {
    if (!mailbox.counts || changes.length === 0) return mailbox;
    let { total, unread } = mailbox.counts;
    for (const { before, after } of changes) {
      const wasIn = belongsTo(mailbox, before);
      const isIn = belongsTo(mailbox, after);
      total += Number(isIn) - Number(wasIn);
      unread +=
        Number(isIn && !after.flags.seen) - Number(wasIn && !before.flags.seen);
    }
    const counts = { total: Math.max(0, total), unread: Math.max(0, unread) };
    return counts.total === mailbox.counts.total &&
      counts.unread === mailbox.counts.unread
      ? mailbox
      : { ...mailbox, counts };
  });
}

function roleId(
  mailboxes: readonly Mailbox[],
  role: Mailbox["role"],
): MailboxId | undefined {
  return mailboxes.find((mailbox) => mailbox.role === role)?.id;
}
