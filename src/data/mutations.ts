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
import type { AccountId, MailboxId, MessageId, ThreadId } from "../core/ids";
import { runIntent, type MailIntent } from "../core/intents";
import type {
  Mailbox,
  Message,
  MessageSummary,
  Thread,
  ThreadSummary,
} from "../core/model";
import { listSpecOfKey, queryKeys } from "./keys";
import {
  isolatingMailboxes,
  patchCounts,
  patchList,
  patchMessage,
  patchThreadList,
  planChanges,
  type MessageChange,
  type MessageListData,
  type ThreadListData,
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

/** All cached conversation lists of an account. */
export const threadListsKey = (accountId: AccountId): QueryKey => [
  ...queryKeys.account(accountId),
  "threads",
];

/** All cached complete conversations of an account. */
const threadsKey = (accountId: AccountId): QueryKey => [
  ...queryKeys.account(accountId),
  "thread",
];

/** Most conversations remembered for bringing rows back on undo. */
const MAX_REMEMBERED_THREADS = 500;

/** Conversations as last seen in a list, per query client (for undo). */
const rememberedThreads = new WeakMap<
  QueryClient,
  Map<ThreadId, ThreadSummary>
>();

/** Remembers the listed conversations of an account and returns all remembered ones. */
function rememberThreads(
  queryClient: QueryClient,
  accountId: AccountId,
): ReadonlyMap<ThreadId, ThreadSummary> {
  let memory = rememberedThreads.get(queryClient);
  if (!memory) {
    memory = new Map();
    rememberedThreads.set(queryClient, memory);
  }
  for (const [, data] of queryClient.getQueriesData<ThreadListData>({
    queryKey: threadListsKey(accountId),
  }))
    for (const page of data?.pages ?? [])
      for (const thread of page.items) {
        memory.delete(thread.id);
        memory.set(thread.id, thread);
      }
  for (const id of memory.keys()) {
    if (memory.size <= MAX_REMEMBERED_THREADS) break;
    memory.delete(id);
  }
  return memory;
}

/**
 * Every message of the conversations that contain the given messages (as
 * far as the cache knows them); messages of unknown conversations stand
 * for themselves.
 */
export function threadMessageIds(
  queryClient: QueryClient,
  accountId: AccountId,
  ids: readonly MessageId[],
): MessageId[] {
  const threads = [
    ...queryClient
      .getQueriesData<ThreadListData>({ queryKey: threadListsKey(accountId) })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? []),
    ...queryClient
      .getQueriesData<Thread>({ queryKey: threadsKey(accountId) })
      .flatMap(([, thread]) => (thread ? [thread] : [])),
  ];
  const result = new Set<MessageId>();
  for (const id of ids) {
    const thread = threads.find((candidate) =>
      candidate.messages.some((message) => message.id === id),
    );
    if (thread) for (const message of thread.messages) result.add(message.id);
    else result.add(id);
  }
  return [...result];
}

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
  // Messages inside conversations: listed ones, then opened ones.
  for (const [, data] of queryClient.getQueriesData<ThreadListData>({
    queryKey: threadListsKey(accountId),
  }))
    for (const page of data?.pages ?? [])
      for (const thread of page.items)
        for (const message of thread.messages)
          if (wanted.has(message.id) && !found.has(message.id))
            found.set(message.id, message);
  for (const [, thread] of queryClient.getQueriesData<Thread>({
    queryKey: threadsKey(accountId),
  }))
    for (const message of thread?.messages ?? [])
      if (wanted.has(message.id) && !found.has(message.id))
        found.set(message.id, message);
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
  const mailboxes = cachedMailboxes(queryClient, accountId);
  const isolating = isolatingMailboxes(mailboxes);
  for (const [key, data] of queryClient.getQueriesData<MessageListData>({
    queryKey: listsKey(accountId),
  })) {
    const spec = listSpecOfKey(key);
    const mailbox = mailboxes.find(
      (candidate) => candidate.id === spec?.mailboxId,
    );
    if (data && spec && mailbox)
      queryClient.setQueryData(
        key,
        patchList(data, mailbox, changes, isolating, spec.order),
      );
  }
  const known = rememberThreads(queryClient, accountId);
  for (const [key, data] of queryClient.getQueriesData<ThreadListData>({
    queryKey: threadListsKey(accountId),
  })) {
    const spec = listSpecOfKey(key);
    const mailbox = mailboxes.find(
      (candidate) => candidate.id === spec?.mailboxId,
    );
    if (data && spec && mailbox)
      queryClient.setQueryData(
        key,
        patchThreadList(data, mailbox, changes, isolating, spec.order, known),
      );
  }
  const byId = new Map(changes.map((change) => [change.id, change]));
  queryClient.setQueriesData<Thread>(
    { queryKey: threadsKey(accountId) },
    (thread) => {
      if (!thread?.messages.some((message) => byId.has(message.id)))
        return thread;
      return {
        ...thread,
        messages: thread.messages.flatMap((message) => {
          const change = byId.get(message.id);
          if (!change) return [message];
          return change.deleted === true ? [] : [patchMessage(message, change)];
        }),
      };
    },
  );
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
 * state, so marking a message read doesn't re-download the list. Search
 * results are patched the same way, but whether a changed message still
 * matches is up to the provider, so they are marked stale and reload the
 * next time they are shown.
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
            { reason: "notConnected" },
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
        queryClient.cancelQueries({ queryKey: threadListsKey(accountId) }),
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
      void queryClient.invalidateQueries({
        queryKey: threadListsKey(accountId),
      });
    },
    onSettled: (_data, _error, { accountId }) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.mailboxes(accountId),
        }),
        queryClient.invalidateQueries({
          queryKey: listsKey(accountId),
          predicate: (query) =>
            listSpecOfKey(query.queryKey)?.search !== undefined,
          refetchType: "none",
        }),
        queryClient.invalidateQueries({
          queryKey: threadListsKey(accountId),
          predicate: (query) =>
            listSpecOfKey(query.queryKey)?.search !== undefined,
          refetchType: "none",
        }),
      ]),
  });
}

/** The cached mailbox list of an account (empty if not loaded). */
export function cachedMailboxes(
  queryClient: QueryClient,
  accountId: AccountId,
): readonly Mailbox[] {
  return (
    queryClient.getQueryData<readonly Mailbox[]>(
      queryKeys.mailboxes(accountId),
    ) ?? []
  );
}

/** Variables of {@link useEmptyMailbox}. */
export interface EmptyMailboxVariables {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
}

/**
 * Permanently deletes everything in Trash or Spam. The list empties right
 * away and comes back if the provider refuses. Can't be undone, so callers
 * confirm first.
 */
export function useEmptyMailbox() {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();

  return useMutation({
    mutationFn: ({ accountId, mailboxId }: EmptyMailboxVariables) => {
      const handle = registry.get(accountId);
      if (!handle) {
        return Promise.reject(
          new MailError(
            "auth-required",
            "This account is no longer connected.",
            { reason: "notConnected" },
          ),
        );
      }
      return handle.provider.emptyMailbox(mailboxId);
    },
    onMutate: async ({ accountId, mailboxId }) => {
      // Every list of the mailbox, searched ones included.
      const lists = queryKeys.messages(accountId, mailboxId);
      const threadLists = queryKeys.threads(accountId, mailboxId);
      await queryClient.cancelQueries({ queryKey: lists });
      await queryClient.cancelQueries({ queryKey: threadLists });
      const snapshot = queryClient.getQueriesData({
        queryKey: queryKeys.account(accountId),
      });
      for (const queryKey of [lists, threadLists])
        queryClient.setQueriesData<MessageListData | ThreadListData>(
          { queryKey },
          (data) =>
            data
              ? {
                  pages: [{ items: [] }],
                  pageParams: data.pageParams.slice(0, 1),
                }
              : data,
        );
      queryClient.setQueryData<readonly Mailbox[]>(
        queryKeys.mailboxes(accountId),
        (mailboxes) =>
          mailboxes?.map((mailbox) =>
            mailbox.id === mailboxId && mailbox.counts
              ? { ...mailbox, counts: { unread: 0, total: 0 } }
              : mailbox,
          ),
      );
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.snapshot ?? [])
        queryClient.setQueryData(key, data);
    },
    onSettled: (_data, _error, { accountId, mailboxId }) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.mailboxes(accountId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.messages(accountId, mailboxId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.threads(accountId, mailboxId),
        }),
      ]),
  });
}
