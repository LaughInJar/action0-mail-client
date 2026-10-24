import type { QueryClient } from "@tanstack/react-query";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import { AccountRegistry } from "../accounts/AccountRegistry";
import type { ProviderModule, ProviderSetup } from "../accounts/types";
import type { IcsFactory } from "../data/calendar";
import { queryKeys } from "../data/keys";
import { IcsCalendarProvider } from "../providers/ical/IcsCalendarProvider";
import { createPersistOptions, createQueryClient } from "../data/queryClient";
import { CommandRegistry } from "../keyboard/registry";
import { createGmailModule } from "../providers/gmail/module";
import { createDemoModule } from "../providers/fake/module";
import { createHashRouter, type HashRouter } from "../state/router";
import { createUiStore, type UiStore } from "../state/uiStore";
import type { NativeSignIn } from "../auth/native/bridge";
import type { Platform } from "../platform/types";
import { webPlatform } from "../platform/web";
import type { AppConfig } from "./config";
import {
  createGoogleDesktopSetup,
  createGoogleSetup,
  storedGoogleClientId,
  storedGoogleDesktopClient,
} from "./googleSetup";
import {
  createMicrosoftSetup,
  storedMicrosoftClientId,
} from "./microsoftSetup";
import { createMicrosoftModule } from "../providers/microsoft/module";

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
  /** Creates the calendar of an iCal subscription. */
  readonly icsFactory: IcsFactory;
  /** The web app or the desktop app. */
  readonly platform: Platform;
}

/** What the desktop app adds to the composition: native sign-in and networking. */
export interface DesktopServices {
  /** Native sign-in, without a client (each provider has its own). */
  readonly native: Omit<NativeSignIn, "client">;
  /** Network requests through the native side (no CORS). */
  readonly fetch: typeof fetch;
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
  /** Creates iCal subscriptions' calendars (default: fetched from the browser). */
  readonly icsFactory?: IcsFactory;
  /** The web app (default) or the desktop app. */
  readonly platform?: Platform;
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
    icsFactory:
      options.icsFactory ??
      ((subscription) => new IcsCalendarProvider(subscription)),
    platform: options.platform ?? webPlatform,
  };
}

/**
 * Provider modules available at startup: Gmail and Microsoft, each if its
 * client is known (from the build or, failing that, from this browser or
 * app), and the demo account. The desktop app signs in natively.
 */
export function createDefaultModules(
  config: AppConfig,
  sessionStorage: Storage | undefined,
  localStorage: Storage | undefined,
  desktop?: DesktopServices,
): ProviderModule[] {
  const microsoftId =
    config.microsoftClientId ?? storedMicrosoftClientId(localStorage);
  const microsoft =
    microsoftId === undefined
      ? []
      : [
          createMicrosoftModule({
            clientId: microsoftId,
            sessionStorage,
            settings: localStorage,
            ...(desktop
              ? {
                  native: { ...desktop.native, client: { id: microsoftId } },
                  fetch: desktop.fetch,
                }
              : {}),
          }),
        ];
  if (desktop) {
    const client =
      config.googleDesktopClient ?? storedGoogleDesktopClient(localStorage);
    return [
      ...(client === undefined
        ? []
        : [
            createGmailModule({
              clientId: client.id,
              tokenStorage: undefined,
              native: { ...desktop.native, client },
              fetch: desktop.fetch,
            }),
          ]),
      ...microsoft,
      createDemoModule(),
    ];
  }
  const clientId = config.googleClientId ?? storedGoogleClientId(localStorage);
  return [
    ...(clientId === undefined
      ? []
      : [createGmailModule({ clientId, tokenStorage: sessionStorage })]),
    ...microsoft,
    createDemoModule(),
  ];
}

/** Runtime setups: Google's and Microsoft's clients can be entered in the Add account wizard. */
export function createDefaultSetups(
  config: AppConfig,
  sessionStorage: Storage | undefined,
  localStorage: Storage | undefined,
  desktop?: DesktopServices,
): (registry: AccountRegistry) => readonly ProviderSetup[] {
  return (registry) => [
    desktop
      ? createGoogleDesktopSetup({
          registry,
          buildClient: config.googleDesktopClient,
          settings: localStorage,
          native: desktop.native,
          fetch: desktop.fetch,
        })
      : createGoogleSetup({
          registry,
          buildClientId: config.googleClientId,
          settings: localStorage,
          tokenStorage: sessionStorage,
        }),
    createMicrosoftSetup({
      registry,
      buildClientId: config.microsoftClientId,
      settings: localStorage,
      sessionStorage,
      ...(desktop ? { desktop } : {}),
    }),
  ];
}
