import { useEffect, useRef } from "react";
import { useAccounts } from "../../accounts/context";
import { useRoute, useRouter } from "../../state/context";
import type { Breakpoint } from "./useBreakpoint";
import { useMailboxList } from "../common/mailboxNames";

/**
 * Picks a sensible place when the URL doesn't name one:
 * - wide and medium screens open the first account's inbox right away;
 * - phones also open the inbox on start, but as a new history entry on top
 *   of the folder tree, so Back leads to the folders.
 * Routes to accounts that no longer exist are reset.
 */
export function useNavigationDefaults(breakpoint: Breakpoint): void {
  const route = useRoute();
  const router = useRouter();
  const accounts = useAccounts();
  const startedAtRoot = useRef(route === null);
  const firstAccountId = accounts[0]?.account.id;
  const { data: mailboxes } = useMailboxList(
    route === null ? firstAccountId : undefined,
  );

  useEffect(() => {
    if (route !== null) {
      startedAtRoot.current = false;
      if (!accounts.some((handle) => handle.account.id === route.accountId)) {
        router.navigate(null, { replace: true });
      }
      return;
    }
    if (firstAccountId === undefined || !mailboxes) return;
    const inbox =
      mailboxes.find((mailbox) => mailbox.role === "inbox") ??
      mailboxes.find((mailbox) => mailbox.selectable);
    if (!inbox) return;
    const target = { accountId: firstAccountId, mailboxId: inbox.id };
    if (breakpoint !== "narrow") {
      router.navigate(target, { replace: true });
    } else if (startedAtRoot.current) {
      startedAtRoot.current = false;
      router.navigate(target);
    }
  }, [route, router, accounts, firstAccountId, mailboxes, breakpoint]);
}
