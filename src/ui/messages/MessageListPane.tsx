import { useCallback, type ReactNode } from "react";
import {
  useAccountHandle,
  useAccounts,
  useAuthStatus,
} from "../../accounts/context";
import type { MessageId } from "../../core/ids";
import { findMailbox, useMailboxes, useMessageList } from "../../data/hooks";
import { useRoute, useRouter, useUi, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { MailActionButtons } from "../actions/MailActionButtons";
import { useMailActions } from "../actions/useMailActions";
import { IconButton } from "../common/IconButton";
import type { Breakpoint } from "../layout/useBreakpoint";
import { MessageList } from "./MessageList";

/** Column (b): header and message list of the current mailbox. */
export function MessageListPane({ breakpoint }: { breakpoint: Breakpoint }) {
  const route = useRoute();
  const router = useRouter();
  const store = useUiStore();
  const accounts = useAccounts();
  const handle = useAccountHandle(route?.accountId);
  const status = useAuthStatus(handle?.auth);
  const { data: mailboxes } = useMailboxes(route?.accountId);
  const mailbox = findMailbox(mailboxes, route?.mailboxId);
  const list = useMessageList(route?.accountId, route?.mailboxId);
  const selectedCount = useUi((state) => state.selectedIds.size);
  const clearSelection = useUi((state) => state.clearSelection);
  const setDrawerOpen = useUi((state) => state.setDrawerOpen);
  const { fetchNextPage } = list;
  const actions = useMailActions();

  const onOpen = useCallback(
    (id: MessageId) => {
      store.getState().focusOnly(id);
      const current = router.getRoute();
      // On phones the reader is its own screen, reachable with Back.
      if (breakpoint === "narrow" && current)
        router.navigate({ ...current, messageId: id });
    },
    [breakpoint, router, store],
  );
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  let body;
  if (!route) body = <Note>Choose a folder.</Note>;
  else if (!handle) body = <Note>This account is no longer connected.</Note>;
  else if (!list.data && status !== "signed-in")
    body = <Note>Reconnect the account to see its messages.</Note>;
  else if (list.isPending) body = <ListSkeleton />;
  else if (list.isError && !list.data)
    body = (
      <Note>
        {errorMessage(list.error)}{" "}
        <button
          type="button"
          className="text-blue-700 underline dark:text-blue-300"
          onClick={() => void list.refetch()}
        >
          Try again
        </button>
      </Note>
    );
  else if (list.data.length === 0) body = <Note>No messages here.</Note>;
  else
    body = (
      <MessageList
        accountId={route.accountId}
        allowDrag={mailbox?.role !== "trash" && mailbox?.role !== "junk"}
        items={list.data}
        mailbox={mailbox}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        fetchNextPage={loadMore}
        onOpen={onOpen}
        {...(actions.canStar
          ? {
              onToggleStar: (id: MessageId) => {
                actions.toggleStar([id]);
              },
            }
          : {})}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-12 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
        {breakpoint !== "wide" && (
          <IconButton
            label="Show folders"
            icon="menu"
            onClick={() => {
              if (breakpoint === "medium") setDrawerOpen(true);
              else router.navigate(null);
            }}
          />
        )}
        {selectedCount > 0 ? (
          <>
            <p className="flex-1 px-2 text-sm font-medium" aria-live="polite">
              {selectedCount} selected
            </p>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-zinc-100 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
            >
              Done
            </button>
          </>
        ) : (
          <div className="min-w-0 flex-1 px-2">
            <h2 className="truncate text-sm font-semibold">
              {mailbox?.name ?? ""}
            </h2>
            {accounts.length > 1 && handle && (
              <p className="truncate text-xs text-zinc-500">
                {handle.account.email}
              </p>
            )}
          </div>
        )}
        <IconButton
          label="Refresh"
          icon="refresh"
          spinning={list.isFetching}
          disabled={!route || status !== "signed-in"}
          onClick={() => void list.refetch()}
        />
      </header>
      {selectedCount > 0 && (
        <div
          role="group"
          aria-label="Actions for the selected messages"
          className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <MailActionButtons actions={actions} />
        </div>
      )}
      {(mailbox?.role === "trash" || mailbox?.role === "junk") && (
        <div
          role="note"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        >
          <span className="min-w-0 flex-1">
            Messages in {mailbox.name} are deleted automatically after 30 days.
          </span>
          {actions.canDeleteForever && (list.data?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={actions.requestEmpty}
              className="rounded px-2 py-1 font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950 pointer-coarse:min-h-11"
            >
              Empty {mailbox.name}
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-sm text-zinc-500">{children}</p>;
}

function ListSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading messages"
      className="animate-pulse"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="space-y-2 border-b border-zinc-100 px-6 py-3 dark:border-zinc-800"
        >
          <div className="h-3 w-1/3 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-5/6 rounded bg-zinc-100 dark:bg-zinc-800/60" />
        </div>
      ))}
    </div>
  );
}
