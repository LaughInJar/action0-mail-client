import { useEffect, useRef } from "react";
import { useAccountRegistry } from "../../accounts/context";
import { useMailSyncService, type Arrivals } from "../../data/sync";

/** Checks for changes this often while the app is visible. */
export const CHECK_VISIBLE_MS = 60_000;
/** … and this often while it's in the background. */
export const CHECK_HIDDEN_MS = 5 * 60_000;

/**
 * Keeps all accounts up to date: checks for changes on a timer (more often
 * while the app is visible), right away when it becomes visible again or
 * the network comes back, and hands new mail to `onArrivals`.
 */
export function useMailSync(onArrivals: (arrivals: Arrivals) => void): void {
  const registry = useAccountRegistry();
  const sync = useMailSyncService();
  const arrived = useRef(onArrivals);
  useEffect(() => {
    arrived.current = onArrivals;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const checkAll = async () => {
      for (const { account } of registry.list()) {
        try {
          const arrivals = await sync.check(account.id);
          if (arrivals) arrived.current(arrivals);
        } catch {
          // Offline or signed out: the next check tries again.
        }
      }
    };
    const run = () => {
      clearTimeout(timer);
      void checkAll().finally(() => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(
          run,
          document.hidden ? CHECK_HIDDEN_MS : CHECK_VISIBLE_MS,
        );
      });
    };
    const onVisibility = () => {
      if (!document.hidden) run();
    };

    run();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", run);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", run);
    };
  }, [registry, sync]);
}
