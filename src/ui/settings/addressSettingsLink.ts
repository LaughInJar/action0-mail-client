import type { AccountId } from "../../core/ids";
import type { HashRouter } from "../../state/router";

/** DOM id of an account's addresses in Settings → Writing. */
export function addressSettingsId(accountId: AccountId): string {
  return `settings-addresses-${accountId}`;
}

let requested: AccountId | undefined;

/** Opens Settings at an account's addresses, ready to add one. */
export function openAddressSettings(
  router: HashRouter,
  accountId: AccountId,
): void {
  requested = accountId;
  router.openSettings();
}

/** Whether {@link openAddressSettings} asked for this account (and it's not taken yet). */
export function addressRequested(accountId: AccountId): boolean {
  return requested === accountId;
}

/** True once after {@link openAddressSettings} for this account. */
export function takeAddressRequest(accountId: AccountId): boolean {
  if (requested !== accountId) return false;
  requested = undefined;
  return true;
}
