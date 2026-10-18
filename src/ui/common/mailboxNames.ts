import { useMemo } from "react";
import type { AccountId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { useMailboxes } from "../../data/hooks";
import { useT, type I18n } from "../../i18n/context";

/** A mailbox's name in the interface language (your own labels keep theirs). */
export function mailboxName(mailbox: Mailbox, t: I18n): string {
  if (mailbox.role !== undefined) return t.mailboxes.roles[mailbox.role];
  if (mailbox.standard !== undefined)
    return t.mailboxes.standard[mailbox.standard];
  return mailbox.name;
}

/** Mailboxes with their names in the interface language. */
export function localizedMailboxes(
  mailboxes: readonly Mailbox[],
  t: I18n,
): Mailbox[] {
  return mailboxes.map((mailbox) => {
    const name = mailboxName(mailbox, t);
    return name === mailbox.name ? mailbox : { ...mailbox, name };
  });
}

/**
 * {@link useMailboxes} with names in the interface language: what the UI
 * shows, filters and announces.
 */
export function useMailboxList(accountId: AccountId | undefined) {
  const query = useMailboxes(accountId);
  const t = useT();
  const { data } = query;
  const localized = useMemo(
    () => (data ? localizedMailboxes(data, t) : undefined),
    [data, t],
  );
  return { ...query, data: localized };
}
