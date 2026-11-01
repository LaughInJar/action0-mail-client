import type { Focus, FocusRule, Mailbox } from "./model";

/**
 * Outlook's Focused Inbox: the Inbox split into Focused and Other, two
 * hidden views of the Inbox (`standard` `focused` and `other`) that
 * providers with `ProviderCapabilities.focusedInbox` list.
 */
export interface FocusViews {
  readonly focused: Mailbox;
  readonly other: Mailbox;
}

/** The Inbox's Focused and Other views, if the account has them. */
export function focusViews(
  mailboxes: readonly Mailbox[],
): FocusViews | undefined {
  const focused = mailboxes.find((mailbox) => mailbox.standard === "focused");
  const other = mailboxes.find((mailbox) => mailbox.standard === "other");
  return focused && other ? { focused, other } : undefined;
}

/**
 * Whether the account's Inbox shows split: the user's switch (`setting`),
 * else automatically once Outlook has put Inbox mail into Other (Graph
 * can't tell whether Focused Inbox is on in Outlook).
 */
export function isSplit(
  mailboxes: readonly Mailbox[],
  setting: boolean | undefined,
): boolean {
  const views = focusViews(mailboxes);
  if (!views) return false;
  return setting ?? (views.other.counts?.total ?? 0) > 0;
}

/** What the Inbox stands for (its list, count, new mail): Focused when split, else the Inbox. */
export function inboxListOf(
  mailboxes: readonly Mailbox[],
  setting: boolean | undefined,
): Mailbox | undefined {
  const views = focusViews(mailboxes);
  if (views && isSplit(mailboxes, setting)) return views.focused;
  return mailboxes.find((mailbox) => mailbox.role === "inbox");
}

/** Whether `mailbox` is the Focused or the Other view. */
export function isFocusView(mailbox: Mailbox | undefined): boolean {
  return mailbox?.standard === "focused" || mailbox?.standard === "other";
}

/** A sender's rule as it should be: a side, or `null` for none. */
export interface FocusRuleChange {
  readonly address: string;
  readonly focus: Focus | null;
}

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/** `rules` with `changes` made (a rule's name stays), by address. */
export function withRuleChanges(
  rules: readonly FocusRule[],
  changes: readonly FocusRuleChange[],
): FocusRule[] {
  const kept = rules.filter(
    (rule) =>
      !changes.some((change) => sameAddress(change.address, rule.address)),
  );
  const set = changes.flatMap((change): FocusRule[] => {
    if (change.focus === null) return [];
    const old = rules.find((rule) => sameAddress(rule.address, change.address));
    return [
      {
        address: change.address,
        ...(old?.name ? { name: old.name } : {}),
        focus: change.focus,
      },
    ];
  });
  return [...kept, ...set].sort((a, b) =>
    a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
  );
}

/** The changes that put `changes`' senders back as `rules` had them. */
export function ruleChangesBack(
  rules: readonly FocusRule[],
  changes: readonly FocusRuleChange[],
): FocusRuleChange[] {
  return changes.map((change) => ({
    address: change.address,
    focus:
      rules.find((rule) => sameAddress(rule.address, change.address))?.focus ??
      null,
  }));
}
