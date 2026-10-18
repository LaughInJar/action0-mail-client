import { asMailboxId, type MailboxId } from "../../core/ids";
import type {
  Mailbox,
  MailboxColor,
  MailboxKind,
  MailboxRole,
  StandardMailbox,
} from "../../core/model";
import type { GmailLabel } from "./types";

/** Synthetic id of the "All Mail" view (Gmail has no label for it). */
export const ALL_MAIL_ID = "ALL_MAIL";
/** Synthetic id of the non-selectable "Categories" group. */
export const CATEGORIES_ID = "CATEGORIES";
/** Prefix of synthetic parents for user labels whose parent label doesn't exist. */
export const SYNTHETIC_PREFIX = "synthetic:";

/**
 * Label colours offered for Gmail: background/text pairs from the palette
 * that Gmail's API accepts (it rejects any other value).
 */
export const GMAIL_LABEL_COLORS: readonly MailboxColor[] = [
  { background: "#fb4c2f", text: "#ffffff" },
  { background: "#ffad47", text: "#000000" },
  { background: "#fad165", text: "#000000" },
  { background: "#16a766", text: "#ffffff" },
  { background: "#43d692", text: "#000000" },
  { background: "#4a86e8", text: "#ffffff" },
  { background: "#a479e2", text: "#ffffff" },
  { background: "#f691b3", text: "#000000" },
  { background: "#ac2b16", text: "#ffffff" },
  { background: "#cf8933", text: "#ffffff" },
  { background: "#0b804b", text: "#ffffff" },
  { background: "#2da2bb", text: "#ffffff" },
  { background: "#285bac", text: "#ffffff" },
  { background: "#653e9b", text: "#ffffff" },
  { background: "#b65775", text: "#ffffff" },
  { background: "#666666", text: "#ffffff" },
];

interface SystemMailbox {
  readonly name: string;
  readonly kind: MailboxKind;
  readonly role: MailboxRole;
  /** Whether users can move messages in and out (see `Mailbox.assignable`). */
  readonly assignable: boolean;
}

/**
 * Gmail system labels that become mailboxes, in display order. `null` marks
 * where the synthetic "All Mail" view goes.
 */
const SYSTEM_MAILBOXES: readonly (readonly [string, SystemMailbox] | null)[] = [
  ["INBOX", { name: "Inbox", kind: "label", role: "inbox", assignable: true }],
  // Starred is a flag in the domain model; the mailbox is a view over it.
  [
    "STARRED",
    { name: "Starred", kind: "view", role: "flagged", assignable: false },
  ],
  // Gmail decides importance itself; changing it is not a "label" action here.
  [
    "IMPORTANT",
    { name: "Important", kind: "label", role: "important", assignable: false },
  ],
  ["SENT", { name: "Sent", kind: "label", role: "sent", assignable: false }],
  [
    "DRAFT",
    { name: "Drafts", kind: "label", role: "drafts", assignable: false },
  ],
  null,
  ["SPAM", { name: "Spam", kind: "label", role: "junk", assignable: true }],
  ["TRASH", { name: "Trash", kind: "label", role: "trash", assignable: true }],
];

const SYSTEM_BY_ID = new Map(
  SYSTEM_MAILBOXES.filter((entry) => entry !== null),
);

/** Gmail inbox categories, in Gmail's display order. */
const CATEGORIES: readonly (readonly [string, string, StandardMailbox])[] = [
  ["CATEGORY_PERSONAL", "Primary", "primary"],
  ["CATEGORY_SOCIAL", "Social", "social"],
  ["CATEGORY_PROMOTIONS", "Promotions", "promotions"],
  ["CATEGORY_UPDATES", "Updates", "updates"],
  ["CATEGORY_FORUMS", "Forums", "forums"],
];

const CATEGORY_NAMES = new Map(CATEGORIES.map(([id, name]) => [id, name]));

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
        assignable: false,
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
      assignable: system.assignable,
    });
  }

  const categories = CATEGORIES.filter(([id]) => byId.has(id));
  if (categories.length > 0) {
    result.push({
      id: asMailboxId(CATEGORIES_ID),
      name: "Categories",
      standard: "categories",
      kind: "view",
      selectable: false,
      hidden: false,
      assignable: false,
    });
    for (const [id, name, standard] of categories) {
      const label = byId.get(id);
      if (!label) continue;
      // Categories are tabs of the inbox; changing them is a separate feature.
      result.push({
        ...base(label),
        name,
        standard,
        kind: "label",
        parentId: asMailboxId(CATEGORIES_ID),
        assignable: false,
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
        assignable: false,
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
      assignable: true,
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

/** A user label as a mailbox, nested in `parentId` (see {@link parentPathOf}). */
export function toUserMailbox(
  label: GmailLabel,
  parentId: MailboxId | undefined,
): Mailbox {
  return {
    ...base(label),
    name: leafName(label.name),
    kind: "label",
    assignable: true,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

/** "Work/Clients" for "Work/Clients/2026"; "" at the top level. */
export function parentPathOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "" : path.slice(0, slash);
}

/** The id of the label at `path`, or of the synthetic node standing in for it. */
export function idOfPath(
  path: string,
  labels: readonly GmailLabel[],
): MailboxId | undefined {
  if (path === "") return undefined;
  const label = labels.find(
    (candidate) => candidate.type === "user" && candidate.name === path,
  );
  return asMailboxId(label?.id ?? SYNTHETIC_PREFIX + path);
}

function base(
  label: GmailLabel,
): Omit<Mailbox, "name" | "kind" | "assignable"> {
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

/** "Clients" for "Work/Clients". */
export function leafName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
