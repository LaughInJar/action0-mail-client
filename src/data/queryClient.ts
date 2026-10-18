import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";
import {
  removeOldestQuery,
  type PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /** Write this query to sessionStorage (short-lived, see {@link PERSIST_MAX_AGE_MS}). */
      persist?: boolean;
    };
  }
}

/** Persisted queries older than this are discarded on restore. */
export const PERSIST_MAX_AGE_MS = 10 * 60_000;

/** sessionStorage key of the persisted query cache. */
export const QUERY_CACHE_KEY = "a0.query-cache";

/** Creates the app's query client. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Providers retry transient failures themselves; a second retry layer
        // would multiply requests against the provider's quota.
        retry: false,
        refetchOnWindowFocus: true,
        // Must not be shorter than the persistence window.
        gcTime: PERSIST_MAX_AGE_MS,
      },
    },
  });
}

/**
 * Persistence of selected queries (`meta.persist`) to sessionStorage, so a
 * reload shows the last mailbox list and message list instantly. Message
 * bodies are never persisted.
 *
 * @param buster Changing it (e.g. on app updates) discards the persisted cache.
 */
export function createPersistOptions(
  storage: Storage | undefined,
  buster: string,
): Omit<PersistQueryClientOptions, "queryClient"> | undefined {
  if (!storage) return undefined;
  return {
    persister: createAsyncStoragePersister({
      storage,
      key: QUERY_CACHE_KEY,
      throttleTime: 1000,
      retry: removeOldestQuery,
    }),
    maxAge: PERSIST_MAX_AGE_MS,
    buster,
    dehydrateOptions: {
      shouldDehydrateQuery: (query) =>
        query.meta?.persist === true && query.state.status === "success",
    },
  };
}
