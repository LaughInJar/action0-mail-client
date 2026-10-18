import { QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useEffect, type ReactNode } from "react";
import { AccountRegistryContext } from "../accounts/context";
import { installRefreshOnInteraction } from "../auth/refreshOnInteraction";
import { CommandRegistryContext } from "../keyboard/context";
import { RouterContext, UiStoreContext } from "../state/context";
import { COARSE_POINTER_QUERY } from "../ui/layout/useBreakpoint";
import type { AppServices } from "./services";

/** Provides all services to the UI and installs the global listeners. */
export function AppProviders({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}) {
  const { registry, commands, queryClient, persistOptions } = services;

  // One keyboard listener for the whole app. An open modal dialog owns the
  // keyboard: no Delete behind a confirmation, no j/k behind a picker.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isModalOpen()) return;
      commands.handleKeyDown(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [commands]);

  // Refresh expiring tokens on interaction, except on touch devices, where
  // the sign-in popup would open as a new tab (they get a reconnect bar).
  useEffect(() => {
    const coarse =
      typeof window.matchMedia === "function" &&
      window.matchMedia(COARSE_POINTER_QUERY).matches;
    if (coarse) return;
    return installRefreshOnInteraction(() =>
      registry.list().map((handle) => handle.auth),
    );
  }, [registry]);

  const tree = (
    <AccountRegistryContext value={registry}>
      <UiStoreContext value={services.uiStore}>
        <RouterContext value={services.router}>
          <CommandRegistryContext value={commands}>
            {children}
          </CommandRegistryContext>
        </RouterContext>
      </UiStoreContext>
    </AccountRegistryContext>
  );

  return persistOptions ? (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
    >
      {tree}
    </PersistQueryClientProvider>
  ) : (
    <QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>
  );
}

/** True while a modal dialog is shown (closed drawers are `inert`). */
function isModalOpen(): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
    (dialog) => dialog.closest("[inert]") === null,
  );
}
