import { useCallback, type ReactNode } from "react";
import {
  useAccountHandle,
  useAccounts,
  useAuthStatus,
} from "../../accounts/context";
import { messageRef, type MessageKey } from "../../core/ids";
import { useRouter, useUi, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { MailActionButtons } from "../actions/MailActionButtons";
import { useMailActions } from "../actions/useMailActions";
import { useComposeActions } from "../composer/useComposeActions";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import type { Breakpoint } from "../layout/useBreakpoint";
import { ListToolbar } from "./ListToolbar";
import { MessageList } from "./MessageList";
import {
  everywhereMailbox,
  routeOfRow,
  useCurrentList,
} from "./useCurrentList";
import { useT } from "../../i18n/context";

/** Column (b): header, search and message list of the current mailbox. */
export function MessageListPane({ breakpoint }: { breakpoint: Breakpoint }) {
  const {
    route,
    list,
    rows,
    conversations,
    mailboxes,
    mailbox,
    scope,
    order,
    listKey,
    unified,
    sources,
    unavailable,
  } = useCurrentList();
  const t = useT();
  const l = t.list;
  const router = useRouter();
  const store = useUiStore();
  const accounts = useAccounts();
  const handle = useAccountHandle(route?.accountId);
  const status = useAuthStatus(handle?.auth);
  const search = route?.search;
  const everywhere = everywhereMailbox(mailboxes);
  // What's listed, by name (where a search runs).
  const here = unified ? l.allInboxes : mailbox?.name;
  const isolated = scope?.role === "trash" || scope?.role === "junk";
  const selectedCount = useUi((state) => state.selectedIds.size);
  const clearSelection = useUi((state) => state.clearSelection);
  const setDrawerOpen = useUi((state) => state.setDrawerOpen);
  const { fetchNextPage } = list;
  const actions = useMailActions();

  const compose = useComposeActions();
  const isDrafts = scope?.role === "drafts" && compose.canCompose;
  const onOpen = useCallback(
    (key: MessageKey) => {
      store.getState().focusOnly(key);
      // Drafts open in the composer.
      if (isDrafts) {
        compose.editDraft(messageRef(key));
        return;
      }
      const current = router.getRoute();
      // On phones the reader is its own screen, reachable with Back.
      if (breakpoint === "narrow" && current)
        router.navigate(routeOfRow(current, key, sources));
    },
    [breakpoint, router, store, isDrafts, compose, sources],
  );
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  let body;
  if (!route) body = <Note>{l.chooseFolder}</Note>;
  else if (!handle) body = <Note>{t.errors.reasons.notConnected({})}</Note>;
  else if (!rows && status !== "signed-in" && !unified)
    body = <Note>{l.reconnectToSee}</Note>;
  else if (list.isPending)
    body = (
      <>
        {order === "oldest" && <Note>{l.sortingOldest}</Note>}
        <ListSkeleton />
      </>
    );
  else if (list.isError && !rows)
    body = (
      <Note>
        {errorMessage(list.error, t)}{" "}
        <button
          type="button"
          className="text-blue-700 underline dark:text-blue-300"
          onClick={() => void list.refetch()}
        >
          {t.common.tryAgain}
        </button>
      </Note>
    );
  else if (!rows) body = <ListSkeleton />;
  else if (rows.length === 0 && search)
    body = (
      <Note>
        {search.everywhere || !here
          ? l.noMatch(conversations, search.text)
          : l.noMatchIn(conversations, search.text, here)}
        {!search.everywhere &&
          (unified ||
            (everywhere && mailbox && mailbox.id !== everywhere.id)) && (
            <>
              {" "}
              <button
                type="button"
                className="text-blue-700 underline dark:text-blue-300"
                onClick={() => {
                  router.navigate({
                    ...route,
                    search: { ...search, everywhere: true },
                  });
                }}
              >
                {l.searchEverywhere}
              </button>
            </>
          )}
      </Note>
    );
  else if (rows.length === 0) body = <Note>{l.empty(conversations)}</Note>;
  else
    body = (
      <MessageList
        key={listKey}
        allowDrag={!isolated}
        rows={rows}
        sources={sources}
        showAccounts={unified}
        mailbox={scope}
        {...(listKey === null ? {} : { listKey })}
        {...(search
          ? { label: l.results(search.text) }
          : unified
            ? { label: l.messagesIn(l.allInboxes) }
            : {})}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        fetchNextPage={loadMore}
        onOpen={onOpen}
        enterOpens={breakpoint === "narrow" || isDrafts}
        {...(actions.canStar
          ? {
              onToggleStar: (key: MessageKey) => {
                actions.toggleStar([key]);
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
            label={l.showFolders}
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
              {l.selected(selectedCount)}
            </p>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-zinc-100 dark:text-blue-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
            >
              {t.common.done}
            </button>
          </>
        ) : (
          <div className="min-w-0 flex-1 px-2">
            <h2 className="truncate text-sm font-semibold">
              {search ? l.results(search.text) : (here ?? "")}
            </h2>
            {accounts.length > 1 && handle && !unified && (
              <p className="truncate text-xs text-zinc-500">
                {handle.account.email}
              </p>
            )}
          </div>
        )}
        {breakpoint === "medium" && compose.canCompose && (
          <IconButton
            label={l.composeButton}
            icon="pencil"
            onClick={compose.compose}
          />
        )}
        <IconButton
          label={l.refresh}
          icon="refresh"
          spinning={list.isFetching}
          disabled={!route || (status !== "signed-in" && !unified)}
          onClick={() => void list.refetch()}
        />
      </header>
      {route && (
        <ListToolbar
          mailbox={mailbox}
          everywhere={everywhere}
          unified={unified}
        />
      )}
      {unavailable.length > 0 && (
        <div
          role="note"
          className="border-b border-zinc-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-zinc-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {unavailable.map((accountId) => {
            const unavailableHandle = accounts.find(
              (candidate) => candidate.account.id === accountId,
            );
            if (!unavailableHandle) return null;
            const { email } = unavailableHandle.account;
            return (
              <p key={accountId}>
                {unavailableHandle.auth.status === "signed-in"
                  ? l.couldntLoad(email)
                  : l.needsReconnect(email)}
              </p>
            );
          })}
        </div>
      )}
      {selectedCount > 0 && (
        <div
          role="group"
          aria-label={l.selectionActions}
          className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <MailActionButtons actions={actions} />
        </div>
      )}
      {scope && isolated && (
        <div
          role="note"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        >
          <span className="min-w-0 flex-1">{l.deletedAfter30(scope.name)}</span>
          {actions.canDeleteForever && !search && (rows?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={actions.requestEmpty}
              className="rounded px-2 py-1 font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950 pointer-coarse:min-h-11"
            >
              {t.actions.empty(scope.name)}
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
      {breakpoint === "narrow" && compose.canCompose && (
        <button
          type="button"
          aria-label={t.layout.compose}
          onClick={compose.compose}
          className="fixed right-4 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-30 grid size-14 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg"
        >
          <Icon name="pencil" className="size-6" />
        </button>
      )}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-sm text-zinc-500">{children}</p>;
}

function ListSkeleton() {
  const t = useT();
  return (
    <div
      aria-busy="true"
      aria-label={t.list.loadingMessages}
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
