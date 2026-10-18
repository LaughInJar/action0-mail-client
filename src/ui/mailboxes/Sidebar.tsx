import { useAccountRegistry, useAccounts } from "../../accounts/context";
import { useRoute, useRouter, useUi } from "../../state/context";
import { Icon } from "../common/Icon";
import { FolderFilter } from "./FolderFilter";
import { MailboxTree, type MailboxTreeProps } from "./MailboxTree";

/** Column (a): app title, account/mailbox tree and account management. */
export function Sidebar({ onNavigate }: MailboxTreeProps) {
  return (
    <nav
      aria-label="Mailboxes"
      className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        <Icon name="mail" className="size-5 text-blue-600 dark:text-blue-400" />
        action0
      </div>
      <FolderFilter />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <MailboxTree {...(onNavigate ? { onNavigate } : {})} />
      </div>
      <AccountsPanel />
    </nav>
  );
}

/** Lists accounts with "Sign out", and offers to add more. */
function AccountsPanel() {
  const registry = useAccountRegistry();
  const accounts = useAccounts();
  const route = useRoute();
  const router = useRouter();
  const setAddAccountOpen = useUi((state) => state.setAddAccountOpen);

  return (
    <details className="group border-t border-zinc-200 text-sm dark:border-zinc-800">
      <summary className="flex cursor-default list-none items-center gap-2 px-4 py-2 text-zinc-600 select-none hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <Icon name="user" />
        <span className="flex-1">Accounts</span>
        <Icon
          name="chevron-right"
          className="size-3.5 transition-transform group-open:rotate-90"
        />
      </summary>
      <ul className="space-y-1 px-2 pb-2">
        {accounts.map(({ account }) => (
          <li
            key={account.id}
            className="flex items-center gap-2 rounded-md px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">
              {account.email}
            </span>
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
              onClick={() => {
                if (route?.accountId === account.id)
                  router.navigate(null, { replace: true });
                void registry.remove(account.id);
              }}
            >
              <Icon name="log-out" className="size-3.5" />
              Sign out
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-blue-700 hover:bg-zinc-200/60 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
            onClick={() => {
              setAddAccountOpen(true);
            }}
          >
            <Icon name="plus" />
            Add account
          </button>
        </li>
      </ul>
    </details>
  );
}
