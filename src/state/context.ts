import { createContext, useContext, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { HashRouter, Route } from "./router";
import type { UiActions, UiState, UiStore } from "./uiStore";

/** Provides the {@link UiStore}. */
export const UiStoreContext = createContext<UiStore | null>(null);

/** Provides the {@link HashRouter}. */
export const RouterContext = createContext<HashRouter | null>(null);

/** The UI store itself, for reading the latest state inside event handlers. */
export function useUiStore(): UiStore {
  const store = useContext(UiStoreContext);
  if (!store) throw new Error("useUiStore() needs a UiStoreContext");
  return store;
}

/** Subscribes to a slice of the UI state. */
export function useUi<T>(selector: (state: UiState & UiActions) => T): T {
  return useStore(useUiStore(), selector);
}

/** The router. */
export function useRouter(): HashRouter {
  const router = useContext(RouterContext);
  if (!router) throw new Error("useRouter() needs a RouterContext");
  return router;
}

/** The current route; re-renders on navigation. */
export function useRoute(): Route {
  const router = useRouter();
  return useSyncExternalStore(router.subscribe, router.getRoute);
}

/** Whether Settings is open; re-renders when that changes. */
export function useSettingsOpen(): boolean {
  const router = useRouter();
  return useSyncExternalStore(router.subscribe, router.isSettingsOpen);
}
