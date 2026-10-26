import { useMemo } from "react";
import type { AccountId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import type { ProviderCapabilities } from "../../core/provider";
import { useAccountHandle } from "../../accounts/context";
import { useMailboxes } from "../../data/hooks";
import { useT, type I18n } from "../../i18n/context";

/** Whose words name the mailboxes with a role (see `ProviderCapabilities.roleNames`). */
export type RoleNames = NonNullable<ProviderCapabilities["roleNames"]>;

/** An account with folders (Outlook), going by its mailboxes. */
export function usesFolders(mailboxes: readonly Mailbox[]): boolean {
  return mailboxes.some((mailbox) => mailbox.kind === "folder");
}

/** The role names an account uses: its provider's choice, else by its mailboxes. */
export function roleNamesOf(
  mailboxes: readonly Mailbox[],
  capabilities: ProviderCapabilities | undefined,
): RoleNames {
  return (
    capabilities?.roleNames ?? (usesFolders(mailboxes) ? "outlook" : "gmail")
  );
}

/**
 * A mailbox's name in the interface language (your own labels keep theirs),
 * in the account's words (Outlook: Deleted Items, not Trash).
 */
export function mailboxName(
  mailbox: Mailbox,
  t: I18n,
  names: RoleNames = mailbox.kind === "folder" ? "outlook" : "gmail",
): string {
  if (mailbox.role !== undefined) {
    const m = t.mailboxes;
    const roles =
      names === "outlook"
        ? m.folderRoles
        : names === "client"
          ? m.clientRoles
          : m.roles;
    return roles[mailbox.role];
  }
  if (mailbox.standard !== undefined)
    return t.mailboxes.standard[mailbox.standard];
  return mailbox.name;
}

/** Mailboxes with their names in the interface language. */
export function localizedMailboxes(
  mailboxes: readonly Mailbox[],
  t: I18n,
  names: RoleNames = roleNamesOf(mailboxes, undefined),
): Mailbox[] {
  return mailboxes.map((mailbox) => {
    const name = mailboxName(mailbox, t, names);
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
  const capabilities = useAccountHandle(accountId)?.provider.capabilities;
  const { data } = query;
  const localized = useMemo(
    () =>
      data
        ? localizedMailboxes(data, t, roleNamesOf(data, capabilities))
        : undefined,
    [data, t, capabilities],
  );
  return { ...query, data: localized };
}
