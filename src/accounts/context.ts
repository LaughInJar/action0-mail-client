import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { AuthSession, AuthStatus } from "../auth/types";
import type { AccountId } from "../core/ids";
import type { AccountRegistry } from "./AccountRegistry";
import type { AccountHandle, ProviderModule, ProviderSetup } from "./types";
import type { ProviderType } from "../core/model";

/** Provides the {@link AccountRegistry} to the UI. */
export const AccountRegistryContext = createContext<AccountRegistry | null>(
  null,
);

/** The account registry from context. */
export function useAccountRegistry(): AccountRegistry {
  const registry = useContext(AccountRegistryContext);
  if (!registry)
    throw new Error("useAccountRegistry() needs an AccountRegistryContext");
  return registry;
}

/** All connected accounts; re-renders when accounts are added or removed. */
export function useAccounts(): readonly AccountHandle[] {
  const registry = useAccountRegistry();
  return useSyncExternalStore(registry.subscribe, registry.list);
}

/** The account with the given id, if connected. */
export function useAccountHandle(
  id: AccountId | undefined,
): AccountHandle | undefined {
  const accounts = useAccounts();
  return id === undefined
    ? undefined
    : accounts.find((h) => h.account.id === id);
}

const noSubscription = () => () => undefined;

/** Live auth status of a session. */
export function useAuthStatus(
  auth: AuthSession | undefined,
): AuthStatus | undefined {
  return useSyncExternalStore(
    auth?.subscribe ?? noSubscription,
    () => auth?.status,
  );
}

/**
 * The accounts among `handles` whose sessions can make requests (signed
 * in); re-renders when that changes.
 */
export function useSignedIn(
  handles: readonly AccountHandle[],
): ReadonlySet<AccountId> {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = handles.map((handle) =>
        handle.auth.subscribe(listener),
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [handles],
  );
  // A string, so the snapshot only changes when the answer does.
  const signedIn = useSyncExternalStore(subscribe, () =>
    JSON.stringify(
      handles.flatMap((handle) =>
        handle.auth.status === "signed-in" ? [handle.account.id] : [],
      ),
    ),
  );
  return useMemo(
    () => new Set(JSON.parse(signedIn) as AccountId[]),
    [signedIn],
  );
}

/** Live token expiry (epoch ms) of a session. */
export function useAuthExpiry(
  auth: AuthSession | undefined,
): number | undefined {
  return useSyncExternalStore(
    auth?.subscribe ?? noSubscription,
    () => auth?.expiresAt,
  );
}

/** Provides the runtime setups of providers (e.g. Google's client ID). */
export const ProviderSetupContext = createContext<readonly ProviderSetup[]>([]);

/** The setup of a provider type, if it can be configured at runtime. */
export function useProviderSetup(
  type: ProviderType,
): ProviderSetup | undefined {
  return useContext(ProviderSetupContext).find((setup) => setup.type === type);
}

/** Provider modules that can add accounts; re-renders when one is registered. */
export function useAvailableModules(): readonly ProviderModule[] {
  const registry = useAccountRegistry();
  return useSyncExternalStore(registry.subscribe, registry.availableModules);
}
