import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import { cachedMailboxes } from "../../data/mutations";
import { useRouter } from "../../state/context";
import type { Route } from "../../state/router";

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

/**
 * The route of All inboxes, with the account in context kept (or else the
 * first account whose mailboxes are known); undefined until one is.
 */
export function allInboxesRoute(
  queryClient: QueryClient,
  accountIds: readonly AccountId[],
  route: Route,
): NonNullable<Route> | undefined {
  const preferred = route?.accountId;
  const ordered = [
    ...accountIds.filter((id) => id === preferred),
    ...accountIds.filter((id) => id !== preferred),
  ];
  for (const accountId of ordered) {
    const inbox = cachedMailboxes(queryClient, accountId).find(
      (mailbox) => mailbox.role === "inbox",
    );
    if (inbox) return { accountId, mailboxId: inbox.id, unified: true };
  }
  return undefined;
}

/** Opens All inboxes (when there are enough accounts); false if it can't yet. */
export function useOpenAllInboxes(): () => boolean {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const router = useRouter();
  return useCallback(() => {
    if (accounts.length < ALL_INBOXES_FROM) return false;
    const current = router.getRoute();
    if (current?.unified) {
      // Already there: back to the whole list (no search).
      if (current.search)
        router.navigate({
          accountId: current.accountId,
          mailboxId: current.mailboxId,
          unified: true,
        });
      return true;
    }
    const target = allInboxesRoute(
      queryClient,
      accounts.map((handle) => handle.account.id),
      current,
    );
    if (!target) return false;
    router.navigate(target);
    return true;
  }, [accounts, queryClient, router]);
}
