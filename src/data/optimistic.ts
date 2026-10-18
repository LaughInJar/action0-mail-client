import type { InfiniteData } from "@tanstack/react-query";
import type { Cursor, MailboxId } from "../core/ids";
import type { MailIntent, MessageChange } from "../core/intents";
import type { Mailbox, Message, MessageSummary, Page } from "../core/model";
import type { MessageOrder, ProviderCapabilities } from "../core/provider";

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
  const context: ApplyContext = {
    inbox,
    archiveFolder,
    trash: roleId(mailboxes, "trash"),
    junk: roleId(mailboxes, "junk"),
    folders: capabilities.mailboxKinds.includes("folder"),
    kindOf,
  };

  const changes: MessageChange[] = [];
  for (const id of new Set(intent.ids)) {
    const before = byId.get(id);
    if (!before) continue;
    const after = apply(intent, before, context);
    if (after === "deleted")
      changes.push({ id, before, after: before, deleted: true });
    else if (after) changes.push({ id, before, after });
  }
  return changes;
}

interface ApplyContext {
  readonly inbox: MailboxId | undefined;
  readonly archiveFolder: MailboxId | undefined;
  readonly trash: MailboxId | undefined;
  readonly junk: MailboxId | undefined;
  /** Folder-based provider: special mailboxes are reached by moving. */
  readonly folders: boolean;
  readonly kindOf: ReadonlyMap<MailboxId, Mailbox["kind"]>;
}

/** Mailboxes whose messages appear in no other list (Gmail: Spam and Trash). */
export function isolatingMailboxes(
  mailboxes: readonly Mailbox[],
): ReadonlySet<MailboxId> {
  return new Set(
    mailboxes
      .filter((mailbox) => mailbox.role === "junk" || mailbox.role === "trash")
      .map((mailbox) => mailbox.id),
  );
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

/** Into a special mailbox: folder providers move there, label providers add it. */
function enter(
  message: MessageSummary,
  target: MailboxId | undefined,
  { folders, kindOf }: ApplyContext,
  alsoLeave: MailboxId | undefined,
): MessageSummary | undefined {
  if (target === undefined || message.mailboxIds.includes(target))
    return undefined;
  const kept = folders
    ? message.mailboxIds.filter((id) => kindOf.get(id) !== "folder")
    : message.mailboxIds.filter((id) => id !== alsoLeave);
  return withMailboxes(message, [...kept, target]);
}

/** Out of a special mailbox: label providers drop it, folder providers move to `fallback`. */
function leave(
  message: MessageSummary,
  source: MailboxId | undefined,
  { folders }: ApplyContext,
  fallback: MailboxId | undefined,
  addBack: MailboxId | undefined,
): MessageSummary | undefined {
  if (source === undefined || !message.mailboxIds.includes(source))
    return undefined;
  const remaining = message.mailboxIds.filter((id) => id !== source);
  if (folders)
    return withMailboxes(
      message,
      fallback === undefined ? remaining : [...remaining, fallback],
    );
  return withMailboxes(
    message,
    addBack === undefined ? remaining : [...remaining, addBack],
  );
}

function apply(
  intent: MailIntent,
  message: MessageSummary,
  context: ApplyContext,
): MessageSummary | "deleted" | undefined {
  const { inbox, archiveFolder, kindOf } = context;
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
    case "trash":
      // Gmail keeps the other labels; the message just disappears from them.
      return enter(message, context.trash, context, undefined);
    case "untrash":
      return leave(message, context.trash, context, inbox, undefined);
    case "report-spam":
      return enter(message, context.junk, context, inbox);
    case "not-spam":
      return leave(message, context.junk, context, inbox, inbox);
    case "delete-forever":
      return "deleted";
  }
}

/**
 * Whether a message shows up in the list of `mailbox`. Messages in an
 * isolating mailbox (Spam, Trash; see {@link isolatingMailboxes}) show up
 * only there.
 */
export function belongsTo(
  mailbox: Mailbox,
  message: MessageSummary,
  isolating: ReadonlySet<MailboxId> = new Set(),
): boolean {
  if (
    !isolating.has(mailbox.id) &&
    message.mailboxIds.some((id) => isolating.has(id))
  ) {
    return false;
  }
  if (mailbox.role === "flagged") return message.flags.flagged;
  if (mailbox.kind === "view") return true;
  return message.mailboxIds.includes(mailbox.id);
}

/** Whether the message is in the list after the change (never, once deleted). */
function staysIn(
  mailbox: Mailbox,
  change: MessageChange,
  isolating: ReadonlySet<MailboxId>,
): boolean {
  return change.deleted !== true && belongsTo(mailbox, change.after, isolating);
}

/**
 * Applies changes to a cached message list: updates rows, removes rows that
 * no longer belong to the mailbox, and re-inserts rows that came back (undo)
 * at their date position in `order`, as far as the loaded pages reach.
 */
export function patchList(
  data: MessageListData,
  mailbox: Mailbox,
  changes: readonly MessageChange[],
  isolating: ReadonlySet<MailboxId> = new Set(),
  order: MessageOrder = "newest",
): MessageListData {
  const byId = new Map(changes.map((change) => [change.id, change]));
  let pages: Page<MessageSummary>[] = data.pages.map((page) => ({
    ...page,
    items: page.items.flatMap((item) => {
      const change = byId.get(item.id);
      if (!change) return [item];
      return staysIn(mailbox, change, isolating)
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
        staysIn(mailbox, change, isolating) &&
        !belongsTo(mailbox, change.before, isolating),
    )
    .map((change) => change.after);
  for (const row of returning) pages = insertByDate(pages, row, order);

  return { ...data, pages };
}

function insertByDate(
  pages: Page<MessageSummary>[],
  row: MessageSummary,
  order: MessageOrder,
): Page<MessageSummary>[] {
  const comesAfter = (item: MessageSummary) =>
    order === "newest"
      ? item.receivedAt < row.receivedAt
      : item.receivedAt > row.receivedAt;
  for (const [pageIndex, page] of pages.entries()) {
    const index = page.items.findIndex(comesAfter);
    if (index !== -1) {
      const items = [...page.items];
      items.splice(index, 0, row);
      return pages.map((p, i) => (i === pageIndex ? { ...p, items } : p));
    }
  }
  // Past everything loaded: append only if there's nothing more to load.
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
  const isolating = isolatingMailboxes(mailboxes);
  return mailboxes.map((mailbox) => {
    if (!mailbox.counts || changes.length === 0) return mailbox;
    let { total, unread } = mailbox.counts;
    for (const change of changes) {
      const { before, after } = change;
      const wasIn = belongsTo(mailbox, before, isolating);
      const isIn = staysIn(mailbox, change, isolating);
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
