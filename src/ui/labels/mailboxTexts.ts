import { useAccountHandle } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import type { ProviderCapabilities } from "../../core/provider";
import { useT, type I18n } from "../../i18n/context";

/**
 * The wording for an account's own mailboxes: labels (Gmail) or folders
 * (Outlook), by what the provider uses.
 */
export function mailboxTexts(
  t: I18n,
  capabilities: ProviderCapabilities | undefined,
): I18n["labels"] {
  return capabilities?.mailboxKinds.includes("folder") ? t.folders : t.labels;
}

/** {@link mailboxTexts} for an account. */
export function useMailboxTexts(
  accountId: AccountId | undefined,
): I18n["labels"] {
  const t = useT();
  return mailboxTexts(t, useAccountHandle(accountId)?.provider.capabilities);
}
