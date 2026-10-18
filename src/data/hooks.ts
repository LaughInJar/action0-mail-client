import { useCallback, useMemo } from "react";
import {
  skipToken,
  useQueryClient,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  useAccountHandle,
  useAccountRegistry,
  useAuthStatus,
} from "../accounts/context";
import type { AccountHandle } from "../accounts/types";
import { MailError } from "../core/errors";
import type {
  AccountId,
  AttachmentId,
  Cursor,
  MailboxId,
  MessageId,
  ThreadId,
} from "../core/ids";
import type {
  Mailbox,
  Message,
  MessageSummary,
  Page,
  ThreadSummary,
} from "../core/model";
import { encodeBase64 } from "../lib/base64url";
import { queryKeys, type ListSpec } from "./keys";

/** Messages per page in the message list. */
export const PAGE_SIZE = 50;

/** The account's handle, but only while its session can make requests. */
export function useReadyHandle(
  accountId: AccountId | undefined,
): AccountHandle | undefined {
  const handle = useAccountHandle(accountId);
  const status = useAuthStatus(handle?.auth);
  return status === "signed-in" ? handle : undefined;
}

const NO_ACCOUNT = "" as AccountId;
const NO_MAILBOX = "" as MailboxId;
const NO_MESSAGE = "" as MessageId;

/** All mailboxes of an account, in provider display order. Persisted briefly. */
export function useMailboxes(accountId: AccountId | undefined) {
  const handle = useReadyHandle(accountId);
  return useQuery({
    queryKey: queryKeys.mailboxes(accountId ?? NO_ACCOUNT),
    queryFn: handle
      ? ({ signal }) => handle.provider.listMailboxes(signal)
      : skipToken,
    staleTime: 60_000,
    meta: { persist: true },
  });
}

const flattenPages = (
  data: InfiniteData<Page<MessageSummary>, Cursor | undefined>,
) => data.pages.flatMap((page) => page.items);

const NO_LIST: ListSpec = { mailboxId: NO_MAILBOX, order: "newest" };

/**
 * Lists don't refetch on mount or focus while a change of the app's own is
 * on its way: the server may not have it yet, and the old state would
 * bring back rows that just left (e.g. a list observed anew by the reader
 * right after archiving). Like the live sync, they catch up afterwards.
 */
function useNotWhileMutating() {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const idle = () => queryClient.isMutating() === 0;
    return { refetchOnMount: idle, refetchOnWindowFocus: idle };
  }, [queryClient]);
}

/**
 * The messages of a list (a mailbox, or a search in it) as a flat list that
 * grows with `fetchNextPage()`. Mailbox lists are persisted briefly; search
 * results stay in memory.
 */
export function useMessageList(
  accountId: AccountId | undefined,
  spec: ListSpec | undefined,
) {
  const handle = useReadyHandle(accountId);
  const quiet = useNotWhileMutating();
  return useInfiniteQuery({
    ...quiet,
    queryKey: queryKeys.messageList(accountId ?? NO_ACCOUNT, spec ?? NO_LIST),
    queryFn:
      handle && spec
        ? ({ pageParam, signal }) =>
            handle.provider.listMessages(
              {
                mailboxId: spec.mailboxId,
                order: spec.order,
                limit: PAGE_SIZE,
                ...(spec.search === undefined ? {} : { search: spec.search }),
                ...(pageParam === undefined ? {} : { cursor: pageParam }),
              },
              signal,
            )
        : skipToken,
    initialPageParam: undefined as Cursor | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: flattenPages,
    staleTime: 30_000,
    meta: { persist: spec?.search === undefined },
  });
}

/**
 * The conversations of a list, like {@link useMessageList} (one page of
 * conversations at a time, each with its messages as summaries).
 */
export function useThreadList(
  accountId: AccountId | undefined,
  spec: ListSpec | undefined,
) {
  const handle = useReadyHandle(accountId);
  const supported = handle?.provider.capabilities.threads === true;
  const quiet = useNotWhileMutating();
  return useInfiniteQuery({
    ...quiet,
    queryKey: queryKeys.threadList(accountId ?? NO_ACCOUNT, spec ?? NO_LIST),
    queryFn:
      handle && spec && supported
        ? ({ pageParam, signal }) =>
            handle.provider.listThreads(
              {
                mailboxId: spec.mailboxId,
                order: spec.order,
                limit: PAGE_SIZE,
                ...(spec.search === undefined ? {} : { search: spec.search }),
                ...(pageParam === undefined ? {} : { cursor: pageParam }),
              },
              signal,
            )
        : skipToken,
    initialPageParam: undefined as Cursor | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: flattenThreadPages,
    staleTime: 30_000,
    meta: { persist: spec?.search === undefined },
  });
}

const flattenThreadPages = (
  data: InfiniteData<Page<ThreadSummary>, Cursor | undefined>,
) => data.pages.flatMap((page) => page.items);

/** A complete conversation. Kept in memory only, never persisted. */
export function useThread(
  accountId: AccountId | undefined,
  threadId: ThreadId | undefined,
) {
  const handle = useReadyHandle(accountId);
  return useQuery({
    queryKey: queryKeys.thread(
      accountId ?? NO_ACCOUNT,
      threadId ?? ("" as ThreadId),
    ),
    queryFn:
      handle && threadId !== undefined
        ? ({ signal }) => handle.provider.getThread(threadId, signal)
        : skipToken,
    staleTime: 60_000,
  });
}

/** A complete message. Kept in memory only, never persisted. */
export function useMessage(
  accountId: AccountId | undefined,
  messageId: MessageId | undefined,
) {
  const handle = useReadyHandle(accountId);
  return useQuery({
    queryKey: queryKeys.message(
      accountId ?? NO_ACCOUNT,
      messageId ?? NO_MESSAGE,
    ),
    queryFn:
      handle && messageId !== undefined
        ? ({ signal }) => handle.provider.getMessage(messageId, signal)
        : skipToken,
    staleTime: 5 * 60_000,
  });
}

/** Content IDs of image parts that the HTML body references as `cid:`. */
export function referencedInlineImages(
  message: Message,
): Message["attachments"] {
  const html = message.body.html;
  if (html === undefined) return [];
  return message.attachments.filter(
    (attachment) =>
      attachment.contentId !== undefined &&
      attachment.mimeType.toLowerCase().startsWith("image/") &&
      html.includes(`cid:${attachment.contentId}`),
  );
}

/**
 * Inline (`cid:`) images of a message as `data:` URLs keyed by content ID.
 * `data:` URLs work inside the sandboxed mail iframe, unlike blob URLs.
 * Memory only.
 */
export function useInlineImages(
  accountId: AccountId | undefined,
  message: Message | undefined,
) {
  const handle = useReadyHandle(accountId);
  const images = message ? referencedInlineImages(message) : [];
  return useQuery({
    queryKey: queryKeys.inlineImages(
      accountId ?? NO_ACCOUNT,
      message?.id ?? NO_MESSAGE,
    ),
    queryFn:
      handle && message && images.length > 0
        ? async ({ signal }) => {
            const entries = await Promise.all(
              images.map(async (image) => {
                const blob = await handle.provider.getAttachment(
                  message.id,
                  image.id,
                  signal,
                );
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const url = `data:${image.mimeType};base64,${encodeBase64(bytes)}`;
                return [image.contentId ?? "", url] as const;
              }),
            );
            const urls: Readonly<Record<string, string>> =
              Object.fromEntries(entries);
            return urls;
          }
        : skipToken,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

/** Mailbox with the given id from a mailbox list. */
export function findMailbox(
  mailboxes: readonly Mailbox[] | undefined,
  id: MailboxId | undefined,
): Mailbox | undefined {
  return id === undefined
    ? undefined
    : mailboxes?.find((mailbox) => mailbox.id === id);
}

/**
 * Loads an account's mailboxes into the cache (or returns the cached ones),
 * e.g. to open the Inbox of an account that was just connected.
 */
export function useFetchMailboxes(): (
  accountId: AccountId,
) => Promise<readonly Mailbox[]> {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useCallback(
    async (accountId: AccountId) => {
      const handle = registry.get(accountId);
      if (!handle) return [];
      return queryClient.query({
        queryKey: queryKeys.mailboxes(accountId),
        queryFn: ({ signal }) => handle.provider.listMailboxes(signal),
        staleTime: 60_000,
        meta: { persist: true },
      });
    },
    [queryClient, registry],
  );
}

/**
 * Loads an attachment's bytes. Memory only; kept for a few minutes, so
 * paging back and forth in the image viewer doesn't download again.
 */
export function useFetchAttachment(): (
  accountId: AccountId,
  messageId: MessageId,
  attachmentId: AttachmentId,
) => Promise<Blob> {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useCallback(
    (accountId, messageId, attachmentId) => {
      const handle = registry.get(accountId);
      if (!handle)
        return Promise.reject(
          new MailError(
            "auth-required",
            "This account is no longer connected.",
            { reason: "notConnected" },
          ),
        );
      return queryClient.query({
        queryKey: queryKeys.attachment(accountId, messageId, attachmentId),
        queryFn: ({ signal }) =>
          handle.provider.getAttachment(messageId, attachmentId, signal),
        staleTime: Infinity,
        gcTime: 5 * 60_000,
      });
    },
    [queryClient, registry],
  );
}
