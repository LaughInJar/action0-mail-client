import {
  keepPreviousData,
  skipToken,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccountRegistry } from "../accounts/context";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import { draftInputOf, type ComposerContent } from "../compose/session";
import type { Draft, OutgoingAttachment } from "../core/compose";
import { isMailError, MailError } from "../core/errors";
import type { AccountId, DraftId, MessageId } from "../core/ids";
import type { EmailAddress, Mailbox, Message, Sender } from "../core/model";
import type { MailProvider } from "../core/provider";
import { foldText } from "../lib/text";
import { useReadyHandle } from "./hooks";
import { queryKeys } from "./keys";
import { fetchCatchAll, fetchSenders } from "./senders";
import type { MessageListData } from "./optimistic";

/** A saved draft: its id and its message's current id. */
export interface SavedDraft {
  readonly id: DraftId;
  readonly messageId: MessageId;
}

/**
 * Saves, sends and discards drafts for composers. Calls for the same
 * composer (`key`) run one after another, and later calls reuse the draft
 * that an earlier one created, so a composer never ends up with two drafts,
 * even when it closes or sends while a save is still running.
 */
export interface DraftSync {
  readonly save: (
    key: number,
    accountId: AccountId,
    content: ComposerContent,
    draftId: DraftId | undefined,
  ) => Promise<SavedDraft>;
  /** Saves the final content if needed and sends it. */
  readonly send: (
    key: number,
    accountId: AccountId,
    content: ComposerContent,
    draftId: DraftId | undefined,
  ) => Promise<MessageId>;
  /** Deletes the composer's draft, if it has one. */
  readonly discard: (
    key: number,
    accountId: AccountId,
    draftId: DraftId | undefined,
  ) => Promise<void>;
  /** The draft behind a message in the drafts mailbox. */
  readonly draftOf: (
    accountId: AccountId,
    messageId: MessageId,
  ) => Promise<Draft>;
  readonly getDraft: (accountId: AccountId, id: DraftId) => Promise<Draft>;
  /** A complete message, from the cache or the provider. */
  readonly getMessage: (
    accountId: AccountId,
    id: MessageId,
  ) => Promise<Message>;
  /** The addresses the account sends from, with signatures ([] if none). */
  readonly senders: (accountId: AccountId) => Promise<readonly Sender[]>;
  /** Catch-all domains; `undefined` if the account's addresses aren't managed in action0. */
  readonly catchAll: (
    accountId: AccountId,
  ) => Promise<readonly string[] | undefined>;
  /** The parts with their bytes loaded (kept in memory while composing). */
  readonly loadParts: (
    accountId: AccountId,
    parts: readonly OutgoingAttachment[],
  ) => Promise<OutgoingAttachment[]>;
}

const instances = new WeakMap<QueryClient, DraftSync>();

/** The app's {@link DraftSync}. */
export function useDraftSync(): DraftSync {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useMemo(() => {
    let sync = instances.get(queryClient);
    if (!sync) {
      sync = createDraftSync(queryClient, registry);
      instances.set(queryClient, sync);
    }
    return sync;
  }, [queryClient, registry]);
}

/** Creates a {@link DraftSync}; see {@link useDraftSync}. */
export function createDraftSync(
  queryClient: QueryClient,
  registry: AccountRegistry,
): DraftSync {
  const chains = new Map<number, Promise<unknown>>();
  /** The draft each composer saved last. */
  const saved = new Map<number, SavedDraft>();

  /** Runs `task` after everything queued for `key` before it. */
  const queue = <T>(key: number, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };

  const providerOf = (accountId: AccountId): MailProvider => {
    const provider = registry.get(accountId)?.provider;
    if (!provider)
      throw new MailError(
        "auth-required",
        "This account is no longer connected.",
        { reason: "notConnected" },
      );
    return provider;
  };

  const bytesOf = (accountId: AccountId, part: OutgoingAttachment) => {
    if (!part.source)
      throw new MailError("provider", `No content for "${part.filename}".`, {
        reason: "noContent",
        params: { name: part.filename },
      });
    return providerOf(accountId).getAttachment(
      part.source.messageId,
      part.source.attachmentId,
    );
  };

  const loadParts = (
    accountId: AccountId,
    parts: readonly OutgoingAttachment[],
  ) =>
    Promise.all(
      parts.map(async (part) =>
        part.content
          ? part
          : {
              ...part,
              content: await bytesOf(accountId, part),
            },
      ),
    );

  /** The content ready to upload: attachment bytes loaded first (a draft's own parts vanish when it's replaced). */
  const prepared = async (accountId: AccountId, content: ComposerContent) => ({
    ...content,
    attachments: await loadParts(accountId, content.attachments),
  });

  const drafts = (accountId: AccountId) =>
    queryClient
      .getQueryData<readonly Mailbox[]>(queryKeys.mailboxes(accountId))
      ?.find((mailbox) => mailbox.role === "drafts");

  const refresh = (accountId: AccountId, everything: boolean) => {
    const draftsMailbox = drafts(accountId);
    void queryClient.invalidateQueries({
      queryKey:
        everything || !draftsMailbox
          ? [...queryKeys.account(accountId), "messages"]
          : queryKeys.messages(accountId, draftsMailbox.id),
    });
    // Drafts and replies show inside their conversations: the open one
    // reloads; lists only after sending (each would reload 50 of them).
    void queryClient.invalidateQueries({
      queryKey: [...queryKeys.account(accountId), "thread"],
    });
    void queryClient.invalidateQueries({
      queryKey: [...queryKeys.account(accountId), "threads"],
      refetchType: everything ? "active" : "none",
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.mailboxes(accountId),
    });
  };

  /** Takes a draft's old message out of cached lists right away. */
  const dropRow = (accountId: AccountId, messageId: MessageId) => {
    queryClient.setQueriesData<MessageListData>(
      { queryKey: [...queryKeys.account(accountId), "messages"] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== messageId),
          })),
        },
    );
  };

  const getMessage = (accountId: AccountId, id: MessageId) =>
    queryClient.query({
      queryKey: queryKeys.message(accountId, id),
      queryFn: ({ signal }) => providerOf(accountId).getMessage(id, signal),
      staleTime: 5 * 60_000,
    });

  return {
    save: (key, accountId, content, draftId) =>
      queue(key, async () => {
        const id = draftId ?? saved.get(key)?.id;
        const ready = await prepared(accountId, content);
        const result = await providerOf(accountId).saveDraft(
          draftInputOf(ready, id),
        );
        saved.set(key, result);
        refresh(accountId, false);
        return result;
      }),

    send: (key, accountId, content, draftId) =>
      queue(key, async () => {
        const provider = providerOf(accountId);
        const ready = await prepared(accountId, content);
        let id = draftId ?? saved.get(key)?.id;
        id ??= (await provider.saveDraft(draftInputOf(ready))).id;
        const previous = saved.get(key);
        const { messageId } = await provider.sendDraft({
          ...draftInputOf(ready, id),
          id,
        });
        saved.delete(key);
        if (previous) dropRow(accountId, previous.messageId);
        refresh(accountId, true);
        return messageId;
      }),

    discard: (key, accountId, draftId) =>
      queue(key, async () => {
        const id = draftId ?? saved.get(key)?.id;
        const previous = saved.get(key);
        saved.delete(key);
        if (previous) dropRow(accountId, previous.messageId);
        if (id === undefined) return;
        await providerOf(accountId).deleteDraft(id);
        refresh(accountId, false);
      }),

    draftOf: async (accountId, messageId) => {
      const provider = providerOf(accountId);
      const id = await provider.draftIdOf(messageId);
      if (id === undefined)
        throw new MailError("not-found", "This draft no longer exists.", {
          reason: "draftGone",
        });
      return provider.getDraft(id);
    },

    getDraft: (accountId, id) => providerOf(accountId).getDraft(id),
    getMessage,
    senders: (accountId) => fetchSenders(queryClient, registry, accountId),
    catchAll: (accountId) => fetchCatchAll(queryClient, registry, accountId),
    loadParts,
  };
}

/** Result of {@link useAddressSuggestions}. */
export interface AddressSuggestions {
  readonly suggestions: readonly EmailAddress[];
  /** Why suggestions come from recent mail instead of the contacts. */
  readonly notice?: MailError;
}

const MAX_SUGGESTIONS = 8;

/**
 * Addresses matching `text`: from the account's contacts when the provider
 * has them, otherwise (or if they're unavailable) from recent mail. Memory
 * only; never persisted.
 */
export function useAddressSuggestions(
  accountId: AccountId | undefined,
  text: string,
): AddressSuggestions {
  const handle = useReadyHandle(accountId);
  const query = text.trim();
  const provider = handle?.provider;
  const contacts = useQuery({
    queryKey: [
      ...queryKeys.account(handle?.account.id ?? ("" as AccountId)),
      "contacts",
      foldText(query),
    ],
    queryFn:
      provider?.capabilities.contacts && query
        ? ({ signal }) => provider.searchContacts(query, signal)
        : skipToken,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: (count, error) => !isMailError(error, "unavailable") && count < 1,
    placeholderData: keepPreviousData,
  });

  const fallback =
    provider !== undefined &&
    (!provider.capabilities.contacts || contacts.isError);
  const recent = useQuery({
    queryKey: [
      ...queryKeys.account(handle?.account.id ?? ("" as AccountId)),
      "recent-addresses",
    ],
    queryFn:
      provider && fallback
        ? ({ signal }) => recentCorrespondents(provider, signal)
        : skipToken,
    staleTime: 10 * 60_000,
  });

  return useMemo(() => {
    if (!query) return { suggestions: [] };
    const notice =
      contacts.isError && isMailError(contacts.error, "unavailable")
        ? contacts.error
        : undefined;
    if (!fallback)
      return {
        suggestions: (contacts.data ?? []).slice(0, MAX_SUGGESTIONS),
      };
    const needle = foldText(query);
    return {
      suggestions: (recent.data ?? [])
        .filter((address) =>
          foldText(`${address.name ?? ""} ${address.address}`).includes(needle),
        )
        .slice(0, MAX_SUGGESTIONS),
      ...(notice ? { notice } : {}),
    };
  }, [
    query,
    fallback,
    contacts.data,
    contacts.isError,
    contacts.error,
    recent.data,
  ]);
}

/**
 * People from recent mail, most frequent first: recipients of the newest
 * sent mail count fully, senders of the newest incoming mail half.
 */
async function recentCorrespondents(
  provider: MailProvider,
  signal: AbortSignal,
): Promise<EmailAddress[]> {
  const mailboxes = await provider.listMailboxes(signal);
  const role = (name: Mailbox["role"]) =>
    mailboxes.find((mailbox) => mailbox.role === name)?.id;
  const [sent, inbox] = [role("sent"), role("inbox")];
  const list = (mailboxId: Mailbox["id"] | undefined) =>
    mailboxId === undefined
      ? Promise.resolve([])
      : provider
          .listMessages({ mailboxId, limit: 100 }, signal)
          .then((page) => page.items);
  const [sentItems, inboxItems] = await Promise.all([list(sent), list(inbox)]);

  const scores = new Map<string, { address: EmailAddress; score: number }>();
  const add = (address: EmailAddress, score: number) => {
    const key = address.address.toLowerCase();
    const entry = scores.get(key);
    if (entry) {
      entry.score += score;
      if (!entry.address.name && address.name) entry.address = address;
    } else {
      scores.set(key, { address, score });
    }
  };
  for (const message of sentItems) for (const to of message.to) add(to, 1);
  for (const message of inboxItems) if (message.from) add(message.from, 0.5);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.address);
}
