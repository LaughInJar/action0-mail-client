import { useAccounts } from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import { useSenders } from "../../data/senders";
import { usePlatform } from "../../platform/context";
import { errorMessage } from "../common/errorMessage";
import { useT } from "../../i18n/context";
import { AccountAddresses } from "./AddressSettings";
import { addressSettingsId } from "./addressSettingsLink";
import { SignatureEditor } from "./SignatureEditor";

/**
 * Signatures of every account that has them, one editor per address.
 * Accounts whose addresses are managed here (`editSenders`) also get
 * their addresses and catch-all domains.
 */
export function SignatureSettings() {
  const accounts = useAccounts().filter(
    (handle) => handle.provider.capabilities.senders,
  );
  const s = useT().settings;
  if (accounts.length === 0) return null;
  const addresses = accounts.some(
    (handle) => handle.provider.capabilities.editSenders,
  );
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium">
          {addresses ? s.addresses : s.signatures}
        </h4>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {addresses ? s.addressesHint : s.signaturesHint}
        </p>
      </div>
      {accounts.map((handle) => (
        <AccountSignatures
          key={handle.account.id}
          handle={handle}
          showAccount={accounts.length > 1}
        />
      ))}
    </div>
  );
}

function AccountSignatures({
  handle,
  showAccount,
}: {
  handle: AccountHandle;
  showAccount: boolean;
}) {
  const { data: senders, isPending, error } = useSenders(handle.account.id);
  const t = useT();
  const { desktop, mobile } = usePlatform();
  const where =
    handle.provider.capabilities.signatureStore === "provider"
      ? t.settings.savedWithProvider
      : desktop || mobile
        ? t.settings.savedInApp
        : t.settings.savedInBrowser;
  const editable = handle.provider.capabilities.editSenders;
  return (
    <div
      // "Add an address…" in the composer scrolls here.
      id={editable ? addressSettingsId(handle.account.id) : undefined}
      className="scroll-mt-4 space-y-3"
    >
      <div>
        {showAccount && (
          <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
            {handle.account.email}
          </p>
        )}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{where}</p>
      </div>
      {isPending && (
        <p className="text-xs text-zinc-500">{t.settings.loadingSignatures}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {t.settings.couldntLoadSignatures(errorMessage(error, t))}
        </p>
      )}
      {editable ? (
        <AccountAddresses handle={handle} senders={senders} />
      ) : (
        senders?.map((sender) => (
          <SignatureEditor
            key={sender.address}
            handle={handle}
            sender={sender}
          />
        ))
      )}
    </div>
  );
}
