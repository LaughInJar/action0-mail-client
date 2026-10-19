import { useMemo } from "react";
import type { AccountId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { useMailboxes } from "../../data/hooks";
import { useT, type I18n } from "../../i18n/context";

/**
 * A mailbox's name in the interface language (your own labels keep theirs).
 * Folder accounts (`outlook`) get Outlook's names: Deleted Items, not Trash.
 */
export function mailboxName(
  mailbox: Mailbox,
  t: I18n,
  outlook = mailbox.kind === "folder",
): string {
  if (mailbox.role !== undefined)
    return (outlook ? t.mailboxes.folderRoles : t.mailboxes.roles)[
      mailbox.role
    ];
  if (mailbox.standard !== undefined)
    return t.mailboxes.standard[mailbox.standard];
  return mailbox.name;
}

/** An account with folders (Outlook), going by its mailboxes. */
export function usesFolders(mailboxes: readonly Mailbox[]): boolean {
  return mailboxes.some((mailbox) => mailbox.kind === "folder");
}

/** Mailboxes with their names in the interface language. */
export function localizedMailboxes(
  mailboxes: readonly Mailbox[],
  t: I18n,
): Mailbox[] {
  const outlook = usesFolders(mailboxes);
  return mailboxes.map((mailbox) => {
    const name = mailboxName(mailbox, t, outlook);
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
