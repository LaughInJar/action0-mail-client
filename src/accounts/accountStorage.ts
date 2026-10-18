import { asAccountId } from "../core/ids";
import type { Account, ProviderType } from "../core/model";
import { readJson, writeJson } from "../lib/storage";

/** localStorage key of the account list. Holds no credentials. */
export const ACCOUNTS_KEY = "a0.accounts";

const PROVIDER_TYPES: ReadonlySet<string> = new Set<ProviderType>([
  "gmail",
  "demo",
]);

/** Reads the persisted account list, dropping malformed entries. */
export function loadAccounts(storage: Storage | undefined): Account[] {
  const value = readJson(storage, ACCOUNTS_KEY);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): Account[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, type, email } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof email !== "string") return [];
    if (typeof type !== "string" || !PROVIDER_TYPES.has(type)) return [];
    return [{ id: asAccountId(id), type: type as ProviderType, email }];
  });
}

/** Persists the account list: id, provider type and email only. */
export function saveAccounts(
  storage: Storage | undefined,
  accounts: readonly Account[],
): void {
  writeJson(
    storage,
    ACCOUNTS_KEY,
    accounts.map(({ id, type, email }) => ({ id, type, email })),
  );
}
