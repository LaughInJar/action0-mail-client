import { QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useEffect, type ReactNode } from "react";
import {
  AccountRegistryContext,
  MailServerAccountsContext,
  ProviderSetupContext,
} from "../accounts/context";
import { AiServicesContext } from "../ai/context";
import { installRefreshOnInteraction } from "../auth/refreshOnInteraction";
import { IcsFactoryContext } from "../data/calendar";
import { I18nProvider } from "../i18n/I18nProvider";
import { PlatformContext } from "../platform/context";
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
      if (isModalOpen() || ownsKeys(event.target)) return;
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
            <ProviderSetupContext value={services.setups}>
              <IcsFactoryContext value={services.icsFactory}>
                <PlatformContext value={services.platform}>
                  <AiServicesContext value={services.ai}>
                    <MailServerAccountsContext value={services.mailServers}>
                      <I18nProvider>{children}</I18nProvider>
                    </MailServerAccountsContext>
                  </AiServicesContext>
                </PlatformContext>
              </IcsFactoryContext>
            </ProviderSetupContext>
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

/** Inside an element with `data-own-keys` (the composer), single keys are text, not shortcuts. */
function ownsKeys(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest("[data-own-keys]") !== null
  );
}

/** True while a modal dialog is shown (closed drawers are `inert`). */
function isModalOpen(): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
    (dialog) => dialog.closest("[inert]") === null,
  );
}
