import { readJson, removeKey, writeJson } from "../../lib/storage";

/** An OAuth access token with its absolute expiry and granted scopes. */
export interface StoredToken {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** Space-separated scopes the user granted. Empty for tokens stored before scopes were recorded. */
  readonly scope: string;
}

/** Where a session keeps its token. Never backed by localStorage. */
export interface TokenStore {
  load(): StoredToken | undefined;
  save(token: StoredToken): void;
  clear(): void;
}

/**
 * Keeps the token in sessionStorage, so a page reload within the token's
 * lifetime needs no new popup. sessionStorage is per tab and cleared when the
 * tab closes.
 */
export function sessionTokenStore(
  key: string,
  storage: Storage | undefined,
): TokenStore {
  const storageKey = `a0.token.${key}`;
  return {
    load: () => parseToken(readJson(storage, storageKey)),
    save: (token) => {
      writeJson(storage, storageKey, token);
    },
    clear: () => {
      removeKey(storage, storageKey);
    },
  };
}

/** Keeps the token in memory only. */
export function memoryTokenStore(initial?: StoredToken): TokenStore {
  let token = initial;
  return {
    load: () => token,
    save: (next) => {
      token = next;
    },
    clear: () => {
      token = undefined;
    },
  };
}

function parseToken(value: unknown): StoredToken | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { accessToken, expiresAt, scope } = value as Record<string, unknown>;
  return typeof accessToken === "string" && typeof expiresAt === "number"
    ? { accessToken, expiresAt, scope: typeof scope === "string" ? scope : "" }
    : undefined;
}
