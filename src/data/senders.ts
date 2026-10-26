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
import type { SenderSettings } from "../core/provider";
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

/**
 * Domains whose every address is the user's; `undefined` for accounts
 * whose addresses aren't managed in action0 (no `+tag` or catch-all
 * replies there).
 */
export function useCatchAll(accountId: AccountId | undefined) {
  const handle = useReadyHandle(accountId);
  const supported = handle?.provider.capabilities.editSenders === true;
  return useQuery({
    queryKey: queryKeys.catchAll(accountId ?? ("" as AccountId)),
    queryFn:
      handle && supported
        ? ({ signal }) => handle.provider.catchAllDomains(signal)
        : skipToken,
    staleTime: SENDERS_STALE_MS,
  });
}

/** {@link useCatchAll} outside React: cached, or loaded now. */
export function fetchCatchAll(
  queryClient: QueryClient,
  registry: AccountRegistry,
  accountId: AccountId,
): Promise<readonly string[] | undefined> {
  const provider = registry.get(accountId)?.provider;
  if (!provider?.capabilities.editSenders) return Promise.resolve(undefined);
  return queryClient.query({
    queryKey: queryKeys.catchAll(accountId),
    queryFn: ({ signal }) => provider.catchAllDomains(signal),
    staleTime: SENDERS_STALE_MS,
  });
}

/** An account's From addresses as the user set them up, and its catch-all domains. */
export interface SenderSetup {
  readonly senders: readonly SenderSettings[];
  readonly catchAll: readonly string[];
}

/** Variables of {@link useChangeSenders}. */
export interface ChangeSendersVariables {
  readonly accountId: AccountId;
  /** The new setup, from the current one (read fresh from the provider). */
  readonly change: (current: SenderSetup) => SenderSetup;
}

/** A sender's settings (without its signature). */
export function settingsOf(sender: Sender): SenderSettings {
  return {
    address: sender.address,
    ...(sender.name ? { name: sender.name } : {}),
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    ...(sender.bccSelf ? { bccSelf: true } : {}),
    isDefault: sender.isDefault,
  };
}

/**
 * Changes an account's From addresses or catch-all domains (accounts with
 * `editSenders`), then loads them again, signatures included.
 */
export function useChangeSenders() {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useMutation({
    mutationFn: async ({ accountId, change }: ChangeSendersVariables) => {
      const provider = registry.get(accountId)?.provider;
      if (!provider) throw notConnected();
      const [senders, catchAll] = await Promise.all([
        provider.listSenders(),
        provider.catchAllDomains(),
      ]);
      const next = change({ senders: senders.map(settingsOf), catchAll });
      await provider.saveSenders(next.senders, next.catchAll);
    },
    onSettled: async (_result, _error, { accountId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.senders(accountId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.catchAll(accountId),
        }),
      ]);
    },
  });
}

const notConnected = () =>
  new MailError("auth-required", "This account is no longer connected.", {
    reason: "notConnected",
  });

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
      if (!provider) return Promise.reject(notConnected());
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
