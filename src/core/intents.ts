import type { MailboxId, MessageId } from "./ids";
import type { Focus, MessageFlags, MessageSummary } from "./model";
import type { MailProvider, MutationResult } from "./provider";

/**
 * A write operation as plain data, so it can be applied optimistically,
 * undone, tested, and (later) queued. Each provider translates intents into
 * its own API calls.
 */
export type MailIntent =
  | { readonly kind: "archive"; readonly ids: readonly MessageId[] }
  | { readonly kind: "unarchive"; readonly ids: readonly MessageId[] }
  | {
      readonly kind: "set-flags";
      readonly ids: readonly MessageId[];
      readonly flags: Partial<MessageFlags>;
    }
  | {
      /** Out of `from` (the list the user is in, possibly a view) into `to`. */
      readonly kind: "move";
      readonly ids: readonly MessageId[];
      readonly from: MailboxId;
      readonly to: MailboxId;
    }
  | {
      /** Adds and removes non-exclusive memberships (labels). */
      readonly kind: "set-labels";
      readonly ids: readonly MessageId[];
      readonly add: readonly MailboxId[];
      readonly remove: readonly MailboxId[];
    }
  | {
      /** Into the snoozed mailbox until `until` (ISO 8601); a new time for snoozed ones. */
      readonly kind: "snooze";
      readonly ids: readonly MessageId[];
      readonly until: string;
    }
  | {
      /**
       * Out of the snoozed mailbox into `to` (`null`: label accounts add
       * nothing); `back`: it came back on its own (unread, marked).
       */
      readonly kind: "unsnooze";
      readonly ids: readonly MessageId[];
      readonly to: MailboxId | null;
      readonly back: boolean;
    }
  | { readonly kind: "clear-back"; readonly ids: readonly MessageId[] }
  | {
      /** To one side of the split Inbox (Outlook's Focused Inbox). */
      readonly kind: "set-focus";
      readonly ids: readonly MessageId[];
      readonly focus: Focus;
    }
  | {
      readonly kind:
        | "trash"
        | "untrash"
        | "report-spam"
        | "not-spam"
        /** Permanent; has no inverse. */
        | "delete-forever";
      readonly ids: readonly MessageId[];
    };

/** What an intent does (or did) to one message. */
export interface MessageChange {
  readonly id: MessageId;
  readonly before: MessageSummary;
  readonly after: MessageSummary;
  /** The message is gone for good (delete-forever); `after` is meaningless. */
  readonly deleted?: true;
}

/** Runs an intent against a provider. */
export function runIntent(
  provider: MailProvider,
  intent: MailIntent,
  signal?: AbortSignal,
): Promise<MutationResult> {
  switch (intent.kind) {
    case "archive":
      return provider.archive(intent.ids, signal);
    case "unarchive":
      return provider.unarchive(intent.ids, signal);
    case "set-flags":
      return provider.setFlags(intent.ids, intent.flags, signal);
    case "move":
      return provider.move(
        intent.ids,
        { from: intent.from, to: intent.to },
        signal,
      );
    case "set-labels":
      return provider.setLabels(
        intent.ids,
        { add: intent.add, remove: intent.remove },
        signal,
      );
    case "trash":
      return provider.trash(intent.ids, signal);
    case "untrash":
      return provider.untrash(intent.ids, signal);
    case "report-spam":
      return provider.reportSpam(intent.ids, signal);
    case "not-spam":
      return provider.notSpam(intent.ids, signal);
    case "delete-forever":
      return provider.deleteForever(intent.ids, signal);
    case "snooze":
      return provider.snooze(intent.ids, new Date(intent.until), signal);
    case "unsnooze":
      return provider.unsnooze(
        intent.ids,
        { to: intent.to, back: intent.back },
        signal,
      );
    case "clear-back":
      return provider.clearBackFromSnooze(intent.ids, signal);
    case "set-focus":
      return provider.setFocus(intent.ids, intent.focus, signal);
  }
}

/** Options of {@link inverseOf}. */
export interface InverseOptions {
  /**
   * For folder providers (Outlook, IMAP): which memberships are folders.
   * Moves, trash and spam are then undone by moving back into the folder a
   * message came from (its other memberships, e.g. categories, stay). Omit
   * for label providers (Gmail).
   */
  readonly isFolder?: (id: MailboxId) => boolean;
  /** The Inbox: label accounts unsnooze into it only if the message was there. */
  readonly inbox?: MailboxId;
}

/**
 * The intents that undo `intent`, built from what actually changed per
 * message (`changes`), so undo never removes something the message already
 * had before. Messages with the same change are grouped into one intent.
 */
export function inverseOf(
  intent: MailIntent,
  changes: readonly MessageChange[],
  options: InverseOptions = {},
): MailIntent[] {
  const { isFolder } = options;
  if (changes.length === 0) return [];
  const ids = changes.map((change) => change.id);
  switch (intent.kind) {
    case "archive":
      return [{ kind: "unarchive", ids }];
    case "unarchive":
      return [{ kind: "archive", ids }];
    case "set-flags":
      return (["seen", "flagged"] as const).flatMap((flag): MailIntent[] => {
        const changed = changes
          .filter(
            (change) => change.before.flags[flag] !== change.after.flags[flag],
          )
          .map((change) => change.id);
        return changed.length === 0
          ? []
          : [
              {
                kind: "set-flags",
                ids: changed,
                flags: { [flag]: !intent.flags[flag] },
              },
            ];
      });
    case "set-labels":
      return labelInverses(changes);
    case "move":
      return isFolder
        ? moveBackInverses(changes, isFolder)
        : labelInverses(changes);
    case "trash":
      // Folders: back into the folder it came from, not just the inbox.
      return isFolder
        ? moveBackInverses(changes, isFolder)
        : [{ kind: "untrash", ids }];
    case "untrash":
      return [{ kind: "trash", ids }];
    case "report-spam":
    case "not-spam":
      // Exact restore of the memberships (e.g. back into a label, not the inbox).
      return isFolder
        ? moveBackInverses(changes, isFolder)
        : labelInverses(changes);
    case "delete-forever":
      return [];
    case "snooze":
      return snoozeInverses(changes, options);
    case "unsnooze":
      // Snoozed again until the time it had (a mail that came back on its
      // own is only taken back by the waker, which offers no undo).
      return groupBy(changes, (change) => change.before.snoozedUntil).flatMap(
        ([until, ids]): MailIntent[] =>
          until === undefined ? [] : [{ kind: "snooze", ids, until }],
      );
    case "clear-back":
      return [];
    case "set-focus":
      return groupBy(changes, (change) => change.before.focus ?? "focused").map(
        ([focus, ids]): MailIntent => ({ kind: "set-focus", ids, focus }),
      );
  }
}

/**
 * Undoing a snooze: messages that were snoozed already get their old time
 * back; the others leave the snoozed mailbox for where they were (the
 * folder they came from; for labels the Inbox if they were in it).
 */
function snoozeInverses(
  changes: readonly MessageChange[],
  { isFolder, inbox }: InverseOptions,
): MailIntent[] {
  const resnoozed = changes.filter(
    (change) => change.before.snoozedUntil !== undefined,
  );
  const fresh = changes.filter(
    (change) => change.before.snoozedUntil === undefined,
  );
  const origin = (change: MessageChange): MailboxId | null => {
    if (isFolder)
      return change.before.mailboxIds.find(isFolder) ?? inbox ?? null;
    return inbox !== undefined && change.before.mailboxIds.includes(inbox)
      ? inbox
      : null;
  };
  return [
    ...groupBy(resnoozed, (change) => change.before.snoozedUntil).flatMap(
      ([until, ids]): MailIntent[] =>
        until === undefined ? [] : [{ kind: "snooze", ids, until }],
    ),
    ...groupBy(fresh, origin).map(([to, ids]): MailIntent => ({
      kind: "unsnooze",
      ids,
      to,
      back: false,
    })),
  ];
}

/** The changes' ids grouped by `key`, in first-seen order. */
function groupBy<K>(
  changes: readonly MessageChange[],
  key: (change: MessageChange) => K,
): [K, MessageId[]][] {
  const groups = new Map<K, MessageId[]>();
  for (const change of changes) {
    const value = key(change);
    groups.set(value, [...(groups.get(value) ?? []), change.id]);
  }
  return [...groups];
}

/** Groups messages by their exact membership diff and reverses it. */
function labelInverses(changes: readonly MessageChange[]): MailIntent[] {
  const groups = new Map<
    string,
    { add: MailboxId[]; remove: MailboxId[]; ids: MessageId[] }
  >();
  for (const { id, before, after } of changes) {
    const added = after.mailboxIds.filter(
      (mailbox) => !before.mailboxIds.includes(mailbox),
    );
    const removed = before.mailboxIds.filter(
      (mailbox) => !after.mailboxIds.includes(mailbox),
    );
    if (added.length === 0 && removed.length === 0) continue;
    const key = JSON.stringify([added, removed]);
    const group = groups.get(key) ?? { add: removed, remove: added, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ ids, add, remove }) => ({
    kind: "set-labels",
    ids,
    add,
    remove,
  }));
}

/** For folder providers: move each message back to the folder it came from. */
function moveBackInverses(
  changes: readonly MessageChange[],
  isFolder: (id: MailboxId) => boolean,
): MailIntent[] {
  const groups = new Map<
    string,
    { from: MailboxId; to: MailboxId; ids: MessageId[] }
  >();
  for (const { id, before, after } of changes) {
    const origin = before.mailboxIds.find(isFolder);
    const current = after.mailboxIds.find(isFolder);
    if (origin === undefined || current === undefined || origin === current)
      continue;
    const key = JSON.stringify([current, origin]);
    const group = groups.get(key) ?? { from: current, to: origin, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ from, to, ids }) => ({
    kind: "move",
    ids,
    from,
    to,
  }));
}
