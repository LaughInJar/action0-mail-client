import { useAccounts } from "../../accounts/context";
import type { AccountHandle } from "../../accounts/types";
import { autoReplyActive } from "../../core/filters";
import type { AccountId } from "../../core/ids";
import { useAutoReply } from "../../data/filters";
import { useT } from "../../i18n/context";
import { useRouter, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { openFilterSettings } from "./filterLink";
import { useFilterActions } from "./useFilterActions";

/** Today in the browser's time zone, "YYYY-MM-DD". */
function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * "Automatic replies are on for …" above the list, for the accounts it
 * shows whose automatic reply answers mail today, with Turn off and Edit.
 */
export function AutoReplyNotice({
  accountIds,
}: {
  readonly accountIds: readonly AccountId[];
}) {
  const accounts = useAccounts().filter(
    (handle) => handle.filters && accountIds.includes(handle.account.id),
  );
  return (
    <>
      {accounts.map((handle) => (
        <AccountNotice key={handle.account.id} handle={handle} />
      ))}
    </>
  );
}

function AccountNotice({ handle }: { readonly handle: AccountHandle }) {
  const t = useT();
  const f = t.filters;
  const accountId = handle.account.id;
  const { data: reply } = useAutoReply(accountId);
  const actions = useFilterActions();
  const router = useRouter();
  const store = useUiStore();
  if (!reply || !autoReplyActive(reply, today())) return null;
  return (
    <div
      role="note"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-blue-50 px-3 py-2 text-xs text-blue-950 dark:border-zinc-800 dark:bg-blue-950/40 dark:text-blue-100"
    >
      <span className="min-w-0 flex-1">{f.noticeOn(handle.account.email)}</span>
      <button
        type="button"
        onClick={() => {
          openFilterSettings(router, { kind: "auto-reply", accountId });
        }}
        className="rounded px-2 py-1 font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900 pointer-coarse:min-h-11"
      >
        {f.edit}
      </button>
      <button
        type="button"
        onClick={() => {
          actions
            .setAutoReply(accountId, { ...reply, enabled: false }, reply)
            .catch((error: unknown) => {
              store.getState().showToast({
                message: `${f.couldntSaveReply}: ${errorMessage(error, t)}`,
                tone: "error",
              });
            });
        }}
        className="rounded px-2 py-1 font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900 pointer-coarse:min-h-11"
      >
        {f.turnOff}
      </button>
    </div>
  );
}
