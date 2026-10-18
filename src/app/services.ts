import type { QueryClient } from "@tanstack/react-query";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import { AccountRegistry } from "../accounts/AccountRegistry";
import type { ProviderModule, ProviderSetup } from "../accounts/types";
import { queryKeys } from "../data/keys";
import { createPersistOptions, createQueryClient } from "../data/queryClient";
import { CommandRegistry } from "../keyboard/registry";
import { createGmailModule } from "../providers/gmail/module";
import { createDemoModule } from "../providers/fake/module";
import { createHashRouter, type HashRouter } from "../state/router";
import { createUiStore, type UiStore } from "../state/uiStore";
import type { AppConfig } from "./config";
import { createGoogleSetup, storedGoogleClientId } from "./googleSetup";

/** Everything the UI needs, created once at startup (or per test). */
export interface AppServices {
  readonly registry: AccountRegistry;
  readonly queryClient: QueryClient;
  readonly persistOptions:
    Omit<PersistQueryClientOptions, "queryClient"> | undefined;
  readonly uiStore: UiStore;
  readonly router: HashRouter;
  readonly commands: CommandRegistry;
  /** Providers the user can configure at runtime (e.g. Google's client ID). */
  readonly setups: readonly ProviderSetup[];
}

/** Inputs of {@link createAppServices}. */
export interface AppServicesOptions {
  readonly modules: readonly ProviderModule[];
  /** For settings and UI state only. */
  readonly localStorage: Storage | undefined;
  /** For short-lived caches (and tokens, inside the Gmail module). */
  readonly sessionStorage: Storage | undefined;
  readonly version: string;
  readonly window?: Window;
  /** Creates the runtime provider setups, which need the registry. */
  readonly createSetups?: (
    registry: AccountRegistry,
  ) => readonly ProviderSetup[];
}

/** The composition root: wires the layers together. */
export function createAppServices(options: AppServicesOptions): AppServices {
  const queryClient = createQueryClient();
  const registry = new AccountRegistry({
    modules: options.modules,
    storage: options.localStorage,
    onRemove: (accountId) => {
      queryClient.removeQueries({ queryKey: queryKeys.account(accountId) });
    },
  });
  registry.restore();
  return {
    registry,
    queryClient,
    persistOptions: createPersistOptions(
      options.sessionStorage,
      options.version,
    ),
    uiStore: createUiStore(options.localStorage),
    router: createHashRouter(options.window ?? window),
    commands: new CommandRegistry(),
    setups: options.createSetups?.(registry) ?? [],
  };
}

/**
 * Provider modules available at startup: Gmail, if a client ID is known
 * (from the build or, failing that, from this browser), and the demo account.
 */
export function createDefaultModules(
  config: AppConfig,
  sessionStorage: Storage | undefined,
  localStorage: Storage | undefined,
): ProviderModule[] {
  const clientId = config.googleClientId ?? storedGoogleClientId(localStorage);
  return [
    ...(clientId === undefined
      ? []
      : [createGmailModule({ clientId, tokenStorage: sessionStorage })]),
    createDemoModule(),
  ];
}

/** Runtime setups: Google's client ID can be entered in the Add account wizard. */
export function createDefaultSetups(
  config: AppConfig,
  sessionStorage: Storage | undefined,
  localStorage: Storage | undefined,
): (registry: AccountRegistry) => readonly ProviderSetup[] {
  return (registry) => [
    createGoogleSetup({
      registry,
      buildClientId: config.googleClientId,
      settings: localStorage,
      tokenStorage: sessionStorage,
    }),
  ];
}
