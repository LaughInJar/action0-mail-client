import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  skipToken,
  type QueryClient,
} from "@tanstack/react-query";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import { useAccountRegistry } from "../accounts/context";
import { MailError } from "../core/errors";
import type { AccountId } from "../core/ids";
import type { Sender } from "../core/model";
import { useReadyHandle } from "./hooks";
import { queryKeys } from "./keys";

/** How long the senders stay fresh (they rarely change). */
const SENDERS_STALE_MS = 5 * 60_000;

/** The account's send-as addresses with their signatures. Memory only. */
export function useSenders(accountId: AccountId | undefined) {
  const handle = useReadyHandle(accountId);
  const supported = handle?.provider.capabilities.senders === true;
  return useQuery({
    queryKey: queryKeys.senders(accountId ?? ("" as AccountId)),
    queryFn:
      handle && supported
        ? ({ signal }) => handle.provider.listSenders(signal)
        : skipToken,
    staleTime: SENDERS_STALE_MS,
  });
}

/** The senders from the cache, or loaded now ([] if the account has none). */
export function fetchSenders(
  queryClient: QueryClient,
  registry: AccountRegistry,
  accountId: AccountId,
): Promise<readonly Sender[]> {
  const provider = registry.get(accountId)?.provider;
  if (!provider?.capabilities.senders) return Promise.resolve([]);
  return queryClient.query({
    queryKey: queryKeys.senders(accountId),
    queryFn: ({ signal }) => provider.listSenders(signal),
    staleTime: SENDERS_STALE_MS,
  });
}

/** Variables of {@link useUpdateSignature}. */
export interface SignatureVariables {
  readonly accountId: AccountId;
  readonly address: string;
  readonly html: string;
}

/**
 * Saves a signature with the provider. The cached senders show it right
 * away and go back if the provider refuses (e.g. `unavailable`: the
 * permission is missing).
 */
export function useUpdateSignature() {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useMutation({
    mutationFn: ({ accountId, address, html }: SignatureVariables) => {
      const provider = registry.get(accountId)?.provider;
      if (!provider)
        return Promise.reject(
          new MailError(
            "auth-required",
            "This account is no longer connected.",
          ),
        );
      return provider.updateSignature(address, html);
    },
    onMutate: async ({ accountId, address, html }) => {
      const key = queryKeys.senders(accountId);
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<readonly Sender[]>(key);
      queryClient.setQueryData<readonly Sender[]>(key, (senders) =>
        senders?.map((sender) =>
          sender.address === address ? { ...sender, signature: html } : sender,
        ),
      );
      return { before };
    },
    onError: (_error, { accountId }, context) => {
      queryClient.setQueryData(queryKeys.senders(accountId), context?.before);
    },
  });
}

/**
 * The senders of several accounts (for the composer's From list). Accounts
 * whose senders can't be loaded are left out.
 */
export function useSendersOf(
  accountIds: readonly AccountId[],
): ReadonlyMap<AccountId, readonly Sender[]> {
  const registry = useAccountRegistry();
  return useQueries({
    queries: accountIds.map((accountId) => {
      const provider = registry.get(accountId)?.provider;
      return {
        queryKey: queryKeys.senders(accountId),
        queryFn: provider?.capabilities.senders
          ? ({ signal }: { signal: AbortSignal }) =>
              provider.listSenders(signal)
          : skipToken,
        staleTime: SENDERS_STALE_MS,
      };
    }),
    combine: (results) =>
      new Map(
        accountIds.flatMap((accountId, index) => {
          const data = results[index]?.data;
          return data ? [[accountId, data] as const] : [];
        }),
      ),
  });
}
