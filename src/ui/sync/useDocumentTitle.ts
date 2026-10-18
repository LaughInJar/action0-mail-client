import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAccounts } from "../../accounts/context";
import type { Mailbox } from "../../core/model";
import { queryKeys } from "../../data/keys";
import { useT } from "../../i18n/context";

/** The title without unread mail. */
export const APP_TITLE = "action0";

/**
 * Keeps the tab title current: "(3) action0" with the unread count of all
 * inboxes, or "Reconnect – action0" while an account's session has expired
 * (then nothing updates until it's renewed).
 */
export function useDocumentTitle(): void {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const t = useT();

  useEffect(() => {
    const update = () => {
      let unread = 0;
      let expired = false;
      for (const { account, auth } of accounts) {
        if (auth.status === "expired") expired = true;
        const inbox = queryClient
          .getQueryData<readonly Mailbox[]>(queryKeys.mailboxes(account.id))
          ?.find((mailbox) => mailbox.role === "inbox");
        unread += inbox?.counts?.unread ?? 0;
      }
      const title = expired
        ? t.layout.titleReconnect(APP_TITLE)
        : unread > 0
          ? `(${String(unread)}) ${APP_TITLE}`
          : APP_TITLE;
      if (document.title !== title) document.title = title;
    };
    update();
    const unsubscribers = [
      queryClient.getQueryCache().subscribe(update),
      ...accounts.map(({ auth }) => auth.subscribe(update)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [accounts, queryClient, t]);
}
