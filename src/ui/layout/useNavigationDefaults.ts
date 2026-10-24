import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useAccounts } from "../../accounts/context";
import { useCalendarRoute, useRoute, useRouter } from "../../state/context";
import type { Breakpoint } from "./useBreakpoint";
import { useMailboxList } from "../common/mailboxNames";
import { ALL_INBOXES_FROM, allInboxesRoute } from "../mailboxes/allInboxes";

/**
 * Picks a sensible place when the URL doesn't name one:
 * - wide and medium screens open the first account's inbox right away (All
 *   inboxes, with several accounts);
 * - phones also open it on start, but as a new history entry on top of the
 *   folder tree, so Back leads to the folders.
 * Routes to accounts that no longer exist are reset; All inboxes moves on
 * to another account, or to the one account left.
 */
export function useNavigationDefaults(breakpoint: Breakpoint): void {
  const route = useRoute();
  const calendar = useCalendarRoute();
  const router = useRouter();
  const accounts = useAccounts();
  const queryClient = useQueryClient();
  const several = accounts.length >= ALL_INBOXES_FROM;
  const startedAtRoot = useRef(route === null);
  const firstAccountId = accounts[0]?.account.id;
  const { data: mailboxes } = useMailboxList(
    route === null ? firstAccountId : undefined,
  );

  useEffect(() => {
    // The calendar is open: mail has no route meanwhile.
    if (calendar !== null) return;
    if (route !== null) {
      startedAtRoot.current = false;
      if (!accounts.some((handle) => handle.account.id === route.accountId)) {
        const elsewhere =
          route.unified && several
            ? allInboxesRoute(
                queryClient,
                accounts.map((handle) => handle.account.id),
                null,
              )
            : undefined;
        router.navigate(elsewhere ?? null, { replace: true });
      } else if (route.unified && !several) {
        // One account left: its own Inbox.
        router.navigate(
          { accountId: route.accountId, mailboxId: route.mailboxId },
          { replace: true },
        );
      }
      return;
    }
    if (firstAccountId === undefined || !mailboxes) return;
    const inbox =
      mailboxes.find((mailbox) => mailbox.role === "inbox") ??
      mailboxes.find((mailbox) => mailbox.selectable);
    if (!inbox) return;
    const target = {
      accountId: firstAccountId,
      mailboxId: inbox.id,
      ...(several && inbox.role === "inbox" ? { unified: true as const } : {}),
    };
    if (breakpoint !== "narrow") {
      router.navigate(target, { replace: true });
    } else if (startedAtRoot.current) {
      startedAtRoot.current = false;
      router.navigate(target);
    }
  }, [
    route,
    calendar,
    router,
    accounts,
    firstAccountId,
    mailboxes,
    breakpoint,
    several,
    queryClient,
  ]);
}
