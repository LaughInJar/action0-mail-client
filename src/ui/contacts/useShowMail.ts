import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import { useFetchMailboxes } from "../../data/hooks";
import { useRouter } from "../../state/context";
import { ALL_INBOXES_FROM, combinedRoute } from "../mailboxes/allInboxes";

/**
 * "Show mail": searches mail for an address, everywhere. With several
 * accounts that's All inboxes' search of every account, else the one
 * account's. A bare address matches it as sender and recipient with
 * every provider.
 */
export function useShowMail(): (
  address: string,
  accountId?: AccountId,
) => Promise<void> {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const router = useRouter();
  const fetchMailboxes = useFetchMailboxes();
  return useCallback(
    async (address, accountId) => {
      const ids = accounts.map((handle) => handle.account.id);
      const search = { text: address, everywhere: true };
      if (ids.length >= ALL_INBOXES_FROM) {
        for (const id of ids) await fetchMailboxes(id).catch(() => []);
        const target = combinedRoute(
          queryClient,
          ids,
          router.getLastMailRoute(),
        );
        if (target) {
          router.navigate({ ...target, search });
          return;
        }
      }
      const account =
        accountId !== undefined && ids.includes(accountId)
          ? accountId
          : (router.getLastMailRoute()?.accountId ?? ids[0]);
      if (account === undefined) return;
      const mailboxes = await fetchMailboxes(account);
      const inbox =
        mailboxes.find((mailbox) => mailbox.role === "inbox") ??
        mailboxes.find((mailbox) => mailbox.selectable);
      if (inbox)
        router.navigate({ accountId: account, mailboxId: inbox.id, search });
    },
    [accounts, queryClient, router, fetchMailboxes],
  );
}
