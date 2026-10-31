import { useSyncExternalStore } from "react";
import type { PwaControls } from "../../platform/types";

/** The PWA's state, kept current. */
export function usePwaState(pwa: PwaControls | undefined) {
  const subscribe = pwa?.subscribe ?? noSubscription;
  const updateReady = useSyncExternalStore(
    subscribe,
    () => pwa?.updateReady() ?? false,
  );
  const canInstall = useSyncExternalStore(
    subscribe,
    () => pwa?.canInstall() ?? false,
  );
  const installed = useSyncExternalStore(
    subscribe,
    () => pwa?.installed() ?? false,
  );
  return { updateReady, canInstall, installed };
}

const noSubscription = () => () => undefined;
