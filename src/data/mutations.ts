import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { useAccountRegistry } from "../accounts/context";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import { MailError } from "../core/errors";
import type { AccountId, MessageId } from "../core/ids";
import { runIntent, type MailIntent } from "../core/intents";
import type { Mailbox, Message, MessageSummary } from "../core/model";
import { queryKeys } from "./keys";
import {
  patchCounts,
  patchList,
  patchMessage,
  planChanges,
  type MessageChange,
  type MessageListData,
} from "./optimistic";

/** Variables of {@link useApplyIntent}. */
export interface IntentVariables {
  readonly accountId: AccountId;
  readonly intent: MailIntent;
  /**
   * Last known state of messages that may no longer be in any cached list
   * (e.g. archived ones an undo brings back). The cache takes precedence.
   */
  readonly known?: readonly MessageSummary[];
}

/** What an intent would change, based on the cached data. */
export interface IntentPreview {
  /** Cached state of the targeted messages before the change. */
  readonly before: readonly MessageSummary[];
  readonly changes: readonly MessageChange[];
}

/** All cached message lists of an account (prefix of the list query keys). */
const listsKey = (accountId: AccountId): QueryKey => [
  ...queryKeys.account(accountId),
  "messages",
];

/** The latest cached summaries of the given messages (lists first, then full messages). */
export function cachedSummaries(
  queryClient: QueryClient,
  accountId: AccountId,
  ids: readonly MessageId[],
): MessageSummary[] {
  const wanted = new Set(ids);
  const found = new Map<MessageId, MessageSummary>();
  for (const [, data] of queryClient.getQueriesData<MessageListData>({
    queryKey: listsKey(accountId),
  })) {
    for (const page of data?.pages ?? []) {
      for (const item of page.items) {
        if (wanted.has(item.id) && !found.has(item.id))
          found.set(item.id, item);
      }
    }
  }
  for (const id of wanted) {
    if (found.has(id)) continue;
    const message = queryClient.getQueryData<Message>(
      queryKeys.message(accountId, id),
    );
    if (message) found.set(id, message);
  }
  return ids.flatMap((id) => {
    const summary = found.get(id);
    return summary ? [summary] : [];
  });
}

/** Predicts an intent's effect from the cache. */
export function previewIntent(
  queryClient: QueryClient,
  registry: AccountRegistry,
  { accountId, intent, known = [] }: IntentVariables,
): IntentPreview {
  const handle = registry.get(accountId);
  const cached = cachedSummaries(queryClient, accountId, intent.ids);
  const cachedIds = new Set(cached.map((summary) => summary.id));
  const wanted = new Set(intent.ids);
  const before = [
    ...cached,
    ...known.filter(
      (summary) => wanted.has(summary.id) && !cachedIds.has(summary.id),
    ),
  ];
  if (!handle) return { before, changes: [] };
  const mailboxes =
    queryClient.getQueryData<readonly Mailbox[]>(
      queryKeys.mailboxes(accountId),
    ) ?? [];
  return {
    before,
    changes: planChanges(
      intent,
      before,
      mailboxes,
      handle.provider.capabilities,
    ),
  };
}

/** Hook form of {@link previewIntent}. */
export function usePreviewIntent(): (
  variables: IntentVariables,
) => IntentPreview {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useCallback(
    (variables: IntentVariables) =>
      previewIntent(queryClient, registry, variables),
    [queryClient, registry],
  );
}

/** Writes changes into every cached list, message and the mailbox counts of an account. */
function applyChanges(
  queryClient: QueryClient,
  accountId: AccountId,
  changes: readonly MessageChange[],
): void {
  const mailboxes =
    queryClient.getQueryData<readonly Mailbox[]>(
      queryKeys.mailboxes(accountId),
    ) ?? [];
  for (const [key, data] of queryClient.getQueriesData<MessageListData>({
    queryKey: listsKey(accountId),
  })) {
    const mailbox = mailboxes.find((candidate) => candidate.id === key[3]);
    if (data && mailbox)
      queryClient.setQueryData(key, patchList(data, mailbox, changes));
  }
  for (const change of changes) {
    queryClient.setQueryData<Message>(
      queryKeys.message(accountId, change.id),
      (message) => (message ? patchMessage(message, change) : message),
    );
  }
  queryClient.setQueryData<readonly Mailbox[]>(
    queryKeys.mailboxes(accountId),
    (current) => (current ? patchCounts(current, changes) : current),
  );
}

/**
 * Runs a {@link MailIntent} with an optimistic update: the cache changes
 * immediately and is rolled back if the provider rejects the change.
 * Afterwards only the mailbox counts are refetched; lists keep their patched
 * state, so marking a message read doesn't re-download the list.
 */
export function useApplyIntent() {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();

  return useMutation({
    mutationFn: ({ accountId, intent }: IntentVariables) => {
      const handle = registry.get(accountId);
      if (!handle) {
        return Promise.reject(
          new MailError(
            "auth-required",
            "This account is no longer connected.",
          ),
        );
      }
      return runIntent(handle.provider, intent);
    },
    onMutate: async (variables) => {
      const { accountId } = variables;
      // Stop in-flight refetches from overwriting the optimistic state.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: listsKey(accountId) }),
        queryClient.cancelQueries({ queryKey: queryKeys.mailboxes(accountId) }),
      ]);
      const snapshot = queryClient.getQueriesData({
        queryKey: queryKeys.account(accountId),
      });
      const { changes } = previewIntent(queryClient, registry, variables);
      applyChanges(queryClient, accountId, changes);
      return { snapshot };
    },
    onError: (_error, { accountId }, context) => {
      for (const [key, data] of context?.snapshot ?? [])
        queryClient.setQueryData(key, data);
      // Other writes may have overlapped with this one; get the truth.
      void queryClient.invalidateQueries({ queryKey: listsKey(accountId) });
    },
    onSettled: (_data, _error, { accountId }) =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.mailboxes(accountId),
      }),
  });
}
