import type { MailboxId } from "../../core/ids";
import { MAILBOX_ROLE_ORDER, type Mailbox } from "../../core/model";

/** A mailbox with its visible children. */
export interface MailboxNode {
  readonly mailbox: Mailbox;
  readonly children: readonly MailboxNode[];
}

const roleRank = (mailbox: Mailbox) =>
  mailbox.role === undefined
    ? Number.MAX_SAFE_INTEGER
    : MAILBOX_ROLE_ORDER.indexOf(mailbox.role);

/**
 * Builds the visible mailbox tree:
 * - hidden mailboxes and everything below them are left out,
 * - siblings with a role come first (inbox, starred, ... trash), the rest
 *   keep the provider's order,
 * - grouping nodes that end up empty are dropped.
 */
export function buildMailboxTree(mailboxes: readonly Mailbox[]): MailboxNode[] {
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));

  const isHidden = (mailbox: Mailbox, seen = new Set<MailboxId>()): boolean => {
    if (mailbox.hidden) return true;
    if (mailbox.parentId === undefined || seen.has(mailbox.id)) return false;
    seen.add(mailbox.id);
    const parent = byId.get(mailbox.parentId);
    return parent ? isHidden(parent, seen) : false;
  };

  const childrenOf = new Map<MailboxId | null, Mailbox[]>();
  for (const mailbox of mailboxes) {
    if (isHidden(mailbox)) continue;
    const parent =
      mailbox.parentId !== undefined && byId.has(mailbox.parentId)
        ? mailbox.parentId
        : null;
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(mailbox);
    childrenOf.set(parent, siblings);
  }

  const build = (
    parent: MailboxId | null,
    ancestors: ReadonlySet<MailboxId>,
  ): MailboxNode[] =>
    (childrenOf.get(parent) ?? [])
      .map((mailbox, index) => ({ mailbox, index }))
      .sort(
        (a, b) =>
          roleRank(a.mailbox) - roleRank(b.mailbox) || a.index - b.index,
      )
      .flatMap(({ mailbox }) => {
        if (ancestors.has(mailbox.id)) return [];
        const children = build(mailbox.id, new Set(ancestors).add(mailbox.id));
        if (!mailbox.selectable && children.length === 0) return [];
        return [{ mailbox, children }];
      });

  return build(null, new Set());
}

/** Number shown next to a mailbox: drafts count everything, others count unread. */
export function badgeCount(mailbox: Mailbox): number | undefined {
  if (!mailbox.counts) return undefined;
  if (mailbox.role === "drafts") return mailbox.counts.total || undefined;
  if (
    mailbox.role === "sent" ||
    mailbox.role === "trash" ||
    mailbox.role === "all"
  ) {
    return undefined;
  }
  return mailbox.counts.unread || undefined;
}

/** Whether a tree node starts out expanded: grouping-only nodes (like Gmail's Categories) start collapsed. */
export function expandedByDefault(mailbox: Mailbox): boolean {
  return mailbox.selectable;
}
