import { createContext, useContext, useSyncExternalStore } from "react";
import type { AuthSession, AuthStatus } from "../auth/types";
import type { AccountId } from "../core/ids";
import type { AccountRegistry } from "./AccountRegistry";
import type { AccountHandle } from "./types";

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

/** Live token expiry (epoch ms) of a session. */
export function useAuthExpiry(
  auth: AuthSession | undefined,
): number | undefined {
  return useSyncExternalStore(
    auth?.subscribe ?? noSubscription,
    () => auth?.expiresAt,
  );
}
