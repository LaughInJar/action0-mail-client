import {
  skipToken,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from "@tanstack/react-query";
import { useAccountHandle, useAuthStatus } from "../accounts/context";
import type { AccountHandle } from "../accounts/types";
import type { AccountId, Cursor, MailboxId, MessageId } from "../core/ids";
import type { Mailbox, Message, MessageSummary, Page } from "../core/model";
import { encodeBase64 } from "../lib/base64url";
import { queryKeys } from "./keys";

/** Messages per page in the message list. */
export const PAGE_SIZE = 50;

/** The account's handle, but only while its session can make requests. */
function useReadyHandle(
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

/**
 * The messages of a mailbox, newest first, as a flat list that grows with
 * `fetchNextPage()`. Persisted briefly.
 */
export function useMessageList(
  accountId: AccountId | undefined,
  mailboxId: MailboxId | undefined,
) {
  const handle = useReadyHandle(accountId);
  return useInfiniteQuery({
    queryKey: queryKeys.messages(
      accountId ?? NO_ACCOUNT,
      mailboxId ?? NO_MAILBOX,
    ),
    queryFn:
      handle && mailboxId !== undefined
        ? ({ pageParam, signal }) =>
            handle.provider.listMessages(
              {
                mailboxId,
                limit: PAGE_SIZE,
                ...(pageParam === undefined ? {} : { cursor: pageParam }),
              },
              signal,
            )
        : skipToken,
    initialPageParam: undefined as Cursor | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: flattenPages,
    staleTime: 30_000,
    meta: { persist: true },
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
