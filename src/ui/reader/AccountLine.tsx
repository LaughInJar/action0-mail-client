import { useAccountHandle } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import { useT } from "../../i18n/context";
import { useAccountColors } from "../accounts/accountColors";

/** "● In anna@example.com": whose message this is (All inboxes). */
export function AccountLine({ accountId }: { readonly accountId: AccountId }) {
  const t = useT();
  const email = useAccountHandle(accountId)?.account.email;
  const color = useAccountColors().get(accountId);
  if (email === undefined) return null;
  return (
    <p className="flex items-center gap-2 px-4 pt-3 text-xs text-zinc-500 sm:px-6 dark:text-zinc-400">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className="truncate">{t.reader.inAccount(email)}</span>
    </p>
  );
}
