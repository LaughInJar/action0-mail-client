import {
  useAccountHandle,
  useAccountRegistry,
  useAccounts,
} from "../../accounts/context";
import { useRoute, useRouter, useUi } from "../../state/context";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { useComposeActions } from "../composer/useComposeActions";
import { ThemeSwitch } from "../layout/ThemeSwitch";
import { FolderFilter } from "./FolderFilter";
import { MailboxTree, type MailboxTreeProps } from "./MailboxTree";

/** Column (a): app title, account/mailbox tree and account management. */
export function Sidebar({ onNavigate }: MailboxTreeProps) {
  const compose = useComposeActions();
  const router = useRouter();
  return (
    <nav
      aria-label="Mailboxes"
      className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 pt-2 pr-2 pb-1 pl-4 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        <Icon name="mail" className="size-5 text-blue-600 dark:text-blue-400" />
        <span className="flex-1">action0</span>
        <ThemeSwitch />
        <IconButton
          label="Settings"
          icon="settings"
          onClick={() => {
            onNavigate?.();
            router.openSettings();
          }}
        />
      </div>
      {compose.canCompose && (
        <div className="px-2 pt-1 pb-2">
          <button
            type="button"
            onClick={() => {
              onNavigate?.();
              compose.compose();
            }}
            className="flex w-full items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 pointer-coarse:min-h-11"
          >
            <Icon name="pencil" className="size-4" />
            <span className="flex-1 text-left">Compose</span>
            <kbd className="font-sans text-xs font-normal opacity-75 pointer-coarse:hidden">
              c
            </kbd>
          </button>
        </div>
      )}
      <FolderFilter />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <MailboxTree {...(onNavigate ? { onNavigate } : {})} />
        <LabelButtons {...(onNavigate ? { onNavigate } : {})} />
      </div>
      <AccountsPanel />
    </nav>
  );
}

/** "New label" and "Manage labels" for the account being shown. */
function LabelButtons({ onNavigate }: MailboxTreeProps) {
  const route = useRoute();
  const handle = useAccountHandle(route?.accountId);
  const setLabelDialog = useUi((state) => state.setLabelDialog);
  const setManageLabels = useUi((state) => state.setManageLabels);
  if (!handle?.provider.capabilities.manageMailboxes) return null;
  const { id } = handle.account;
  const button =
    "flex items-center gap-1 rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 pointer-coarse:min-h-11";
  return (
    <div className="flex flex-wrap gap-1 px-2 pb-3 text-xs">
      <button
        type="button"
        className={button}
        onClick={() => {
          onNavigate?.();
          setLabelDialog({ mode: "create", accountId: id });
        }}
      >
        <Icon name="plus" className="size-3.5" />
        New label
      </button>
      <button
        type="button"
        className={button}
        onClick={() => {
          onNavigate?.();
          setManageLabels(id);
        }}
      >
        <Icon name="tag" className="size-3.5" />
        Manage labels
      </button>
    </div>
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
