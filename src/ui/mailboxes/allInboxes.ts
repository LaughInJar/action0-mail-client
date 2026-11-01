import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import { cachedMailboxes } from "../../data/mutations";
import { useRouter } from "../../state/context";
import type { Route } from "../../state/router";
import { unifiedRoleOf, type UnifiedRole } from "../../data/unified";

/** All inboxes is offered from this many accounts on. */
export const ALL_INBOXES_FROM = 2;

/** Unread messages in the Inboxes of `accountIds` (as far as their mailboxes are loaded). */
export function inboxUnread(
  queryClient: QueryClient,
  accountIds: readonly AccountId[],
): number {
  return accountIds.reduce(
    (sum, accountId) =>
      sum +
      (cachedMailboxes(queryClient, accountId).find(
        (mailbox) => mailbox.role === "inbox",
      )?.counts?.unread ?? 0),
    0,
  );
}

/** The unread count of all inboxes; re-renders when it changes. */
export function useInboxUnread(): number {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => queryClient.getQueryCache().subscribe(listener),
      [queryClient],
    ),
    () =>
      inboxUnread(
        queryClient,
        accounts.map((handle) => handle.account.id),
      ),
  );
}

/** Drafts in the Drafts of `accountIds` (as far as their mailboxes are loaded). */
function draftCount(
  queryClient: QueryClient,
  accountIds: readonly AccountId[],
): number {
  return accountIds.reduce(
    (sum, accountId) =>
      sum +
      (cachedMailboxes(queryClient, accountId).find(
        (mailbox) => mailbox.role === "drafts",
      )?.counts?.total ?? 0),
    0,
  );
}

/**
 * What a combined view shows next to its name: All inboxes the unread
 * mail, Drafts the drafts, the others nothing (0). Re-renders when it changes.
 */
export function useCombinedCount(role: UnifiedRole): number {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => queryClient.getQueryCache().subscribe(listener),
      [queryClient],
    ),
    () => {
      const ids = accounts.map((handle) => handle.account.id);
      return role === "inbox"
        ? inboxUnread(queryClient, ids)
        : role === "drafts"
          ? draftCount(queryClient, ids)
          : 0;
    },
  );
}

/**
 * The route of a combined view, with the account in context kept (or else
 * the first account that has such a mailbox, as far as known); undefined
 * until one is.
 */
export function combinedRoute(
  queryClient: QueryClient,
  accountIds: readonly AccountId[],
  route: Route,
  role: UnifiedRole = "inbox",
): NonNullable<Route> | undefined {
  const preferred = route?.accountId;
  const ordered = [
    ...accountIds.filter((id) => id === preferred),
    ...accountIds.filter((id) => id !== preferred),
  ];
  for (const accountId of ordered) {
    const mailbox = cachedMailboxes(queryClient, accountId).find(
      (candidate) => candidate.role === role,
    );
    if (mailbox)
      return {
        accountId,
        mailboxId: mailbox.id,
        unified: true,
        ...(role === "inbox" ? {} : { combined: role }),
      };
  }
  return undefined;
}

/**
 * Opens a combined view (when there are enough accounts); false if it
 * can't yet. Opening the one shown goes back to its whole list.
 */
export function useOpenCombined(): (role: UnifiedRole) => boolean {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const router = useRouter();
  return useCallback(
    (role) => {
      if (accounts.length < ALL_INBOXES_FROM) return false;
      const current = router.getRoute();
      if (current?.unified && unifiedRoleOf(current) === role) {
        // Already there: back to the whole list (no search).
        if (current.search) {
          const { search: _search, messageId: _message, ...list } = current;
          router.navigate(list);
        }
        return true;
      }
      const target = combinedRoute(
        queryClient,
        accounts.map((handle) => handle.account.id),
        current,
        role,
      );
      if (!target) return false;
      router.navigate(target);
      return true;
    },
    [accounts, queryClient, router],
  );
}

/** Opens All inboxes (when there are enough accounts); false if it can't yet. */
export function useOpenAllInboxes(): () => boolean {
  const open = useOpenCombined();
  return useCallback(() => open("inbox"), [open]);
}
