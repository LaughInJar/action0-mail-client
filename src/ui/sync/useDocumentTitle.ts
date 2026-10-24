import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAccounts } from "../../accounts/context";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { inboxUnread } from "../mailboxes/allInboxes";

/** The title without unread mail. */
export const APP_TITLE = "action0";

/**
 * Keeps the tab title current: "(3) action0" with the unread count of all
 * inboxes, or "Reconnect – action0" while an account's session has expired
 * (then nothing updates until it's renewed). The desktop app also shows the
 * count on its icons.
 */
export function useDocumentTitle(): void {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const t = useT();
  const { setUnreadCount } = usePlatform();

  useEffect(() => {
    const update = () => {
      const unread = inboxUnread(
        queryClient,
        accounts.map((handle) => handle.account.id),
      );
      const expired = accounts.some(({ auth }) => auth.status === "expired");
      const title = expired
        ? t.layout.titleReconnect(APP_TITLE)
        : unread > 0
          ? `(${String(unread)}) ${APP_TITLE}`
          : APP_TITLE;
      if (document.title !== title) document.title = title;
      setUnreadCount(unread, t.desktop.unread(unread));
    };
    update();
    const unsubscribers = [
      queryClient.getQueryCache().subscribe(update),
      ...accounts.map(({ auth }) => auth.subscribe(update)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [accounts, queryClient, t, setUnreadCount]);
}
