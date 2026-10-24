import { useAccountHandle } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import type { MailboxKind } from "../../core/model";
import type { ProviderCapabilities } from "../../core/provider";
import { useT, type I18n } from "../../i18n/context";

/**
 * The wording for an account's own mailboxes: labels (Gmail), or in
 * folder accounts (Outlook) folders, and categories for its labels.
 */
export function mailboxTexts(
  t: I18n,
  capabilities: ProviderCapabilities | undefined,
  kind?: MailboxKind,
): I18n["labels"] {
  if (!capabilities?.mailboxKinds.includes("folder")) return t.labels;
  return kind === "label" ? t.categories : t.folders;
}

/** {@link mailboxTexts} for an account. */
export function useMailboxTexts(
  accountId: AccountId | undefined,
  kind?: MailboxKind,
): I18n["labels"] {
  const t = useT();
  return mailboxTexts(
    t,
    useAccountHandle(accountId)?.provider.capabilities,
    kind,
  );
}
