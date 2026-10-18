import { asMailboxId } from "../../core/ids";
import type { Mailbox, MailboxKind, MailboxRole } from "../../core/model";
import type { GmailLabel } from "./types";

/** Synthetic id of the "All Mail" view (Gmail has no label for it). */
export const ALL_MAIL_ID = "ALL_MAIL";
/** Synthetic id of the non-selectable "Categories" group. */
export const CATEGORIES_ID = "CATEGORIES";
/** Prefix of synthetic parents for user labels whose parent label doesn't exist. */
const SYNTHETIC_PREFIX = "synthetic:";

interface SystemMailbox {
  readonly name: string;
  readonly kind: MailboxKind;
  readonly role: MailboxRole;
}

/**
 * Gmail system labels that become mailboxes, in display order. `null` marks
 * where the synthetic "All Mail" view goes.
 */
const SYSTEM_MAILBOXES: readonly (readonly [string, SystemMailbox] | null)[] = [
  ["INBOX", { name: "Inbox", kind: "label", role: "inbox" }],
  // Starred is a flag in the domain model; the mailbox is a view over it.
  ["STARRED", { name: "Starred", kind: "view", role: "flagged" }],
  ["IMPORTANT", { name: "Important", kind: "label", role: "important" }],
  ["SENT", { name: "Sent", kind: "label", role: "sent" }],
  ["DRAFT", { name: "Drafts", kind: "label", role: "drafts" }],
  null,
  ["SPAM", { name: "Spam", kind: "label", role: "junk" }],
  ["TRASH", { name: "Trash", kind: "label", role: "trash" }],
];

const SYSTEM_BY_ID = new Map(
  SYSTEM_MAILBOXES.filter((entry) => entry !== null),
);

/** Gmail inbox categories, in Gmail's display order. */
const CATEGORIES: readonly (readonly [string, string])[] = [
  ["CATEGORY_PERSONAL", "Primary"],
  ["CATEGORY_SOCIAL", "Social"],
  ["CATEGORY_PROMOTIONS", "Promotions"],
  ["CATEGORY_UPDATES", "Updates"],
  ["CATEGORY_FORUMS", "Forums"],
];

const CATEGORY_NAMES = new Map(CATEGORIES);

/**
 * Labels that are flags in the domain model (or irrelevant) and therefore
 * never appear in `mailboxIds`.
 */
const NON_MAILBOX_LABELS = new Set(["UNREAD", "STARRED", "CHAT"]);

/** True if the label id becomes a mailbox membership in the domain model. */
export function isMembershipLabel(labelId: string): boolean {
  return !NON_MAILBOX_LABELS.has(labelId);
}

/** True if `labels.list` returned a label we show as a mailbox. */
export function isMappedLabel(label: GmailLabel): boolean {
  return (
    SYSTEM_BY_ID.has(label.id) ||
    CATEGORY_NAMES.has(label.id) ||
    label.type === "user"
  );
}

/**
 * Maps Gmail labels (with counts, from `labels.get`) to mailboxes in display
 * order: system mailboxes, then the "Categories" group, then user labels as
 * an alphabetical tree. Nested names like "Work/Clients" become children;
 * missing parents are added as non-selectable nodes.
 */
export function mapLabels(labels: readonly GmailLabel[]): Mailbox[] {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const result: Mailbox[] = [];

  for (const entry of SYSTEM_MAILBOXES) {
    if (entry === null) {
      result.push({
        id: asMailboxId(ALL_MAIL_ID),
        name: "All Mail",
        kind: "view",
        role: "all",
        selectable: true,
        hidden: false,
      });
      continue;
    }
    const [id, system] = entry;
    const label = byId.get(id);
    if (!label) continue;
    result.push({
      ...base(label),
      name: system.name,
      kind: system.kind,
      role: system.role,
    });
  }

  const categories = CATEGORIES.filter(([id]) => byId.has(id));
  if (categories.length > 0) {
    result.push({
      id: asMailboxId(CATEGORIES_ID),
      name: "Categories",
      kind: "view",
      selectable: false,
      hidden: false,
    });
    for (const [id, name] of categories) {
      const label = byId.get(id);
      if (!label) continue;
      result.push({
        ...base(label),
        name,
        kind: "label",
        parentId: asMailboxId(CATEGORIES_ID),
      });
    }
  }

  result.push(
    ...mapUserLabels(labels.filter((label) => label.type === "user")),
  );
  return result;
}

function mapUserLabels(labels: readonly GmailLabel[]): Mailbox[] {
  const idByPath = new Map(labels.map((label) => [label.name, label.id]));
  const mailboxes = new Map<string, Mailbox>();

  const parentIdOf = (path: string): string | undefined => {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return undefined;
    const parentPath = path.slice(0, slash);
    const existing = idByPath.get(parentPath);
    if (existing !== undefined) return existing;
    const syntheticId = SYNTHETIC_PREFIX + parentPath;
    if (!mailboxes.has(parentPath)) {
      const grandParentId = parentIdOf(parentPath);
      mailboxes.set(parentPath, {
        id: asMailboxId(syntheticId),
        name: leafName(parentPath),
        kind: "label",
        selectable: false,
        hidden: false,
        ...(grandParentId === undefined
          ? {}
          : { parentId: asMailboxId(grandParentId) }),
      });
    }
    return syntheticId;
  };

  for (const label of labels) {
    const parentId = parentIdOf(label.name);
    mailboxes.set(label.name, {
      ...base(label),
      name: leafName(label.name),
      kind: "label",
      ...(parentId === undefined ? {} : { parentId: asMailboxId(parentId) }),
    });
  }

  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return [...mailboxes.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([, mailbox]) => mailbox);
}

function base(label: GmailLabel): Omit<Mailbox, "name" | "kind"> {
  const unread = label.messagesUnread ?? 0;
  const hidden =
    label.labelListVisibility === "labelHide" ||
    (label.labelListVisibility === "labelShowIfUnread" && unread === 0);
  return {
    id: asMailboxId(label.id),
    selectable: true,
    hidden,
    ...(label.messagesTotal === undefined
      ? {}
      : { counts: { unread, total: label.messagesTotal } }),
    ...(label.color
      ? {
          color: {
            background: label.color.backgroundColor,
            text: label.color.textColor,
          },
        }
      : {}),
  };
}

function leafName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
