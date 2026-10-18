import type { Mailbox } from "../../core/model";
import type { MessageOrder } from "../../core/provider";
import { useMemo } from "react";
import { useAccountHandle } from "../../accounts/context";
import { findMailbox, useMessageList, useThreadList } from "../../data/hooks";
import { messageRows, threadRows } from "../../data/listRows";
import { isolatingMailboxes } from "../../data/optimistic";
import type { ListSpec } from "../../data/keys";
import { useRoute, useUi } from "../../state/context";
import type { Route } from "../../state/router";
import { useMailboxList } from "../common/mailboxNames";

/**
 * Identifies the list a route shows in an order, as messages or
 * conversations (focus and selection belong to it).
 */
export const listKeyOf = (
  route: Route,
  order: MessageOrder,
  conversations: boolean,
): string | null =>
  route
    ? JSON.stringify([
        route.accountId,
        route.mailboxId,
        route.search?.text.trim() ?? "",
        route.search?.everywhere ?? false,
        order,
        conversations,
      ])
    : null;

/** The mailbox that "search everywhere" searches (Gmail: All Mail). */
export const everywhereMailbox = (
  mailboxes: readonly Mailbox[] | undefined,
): Mailbox | undefined => mailboxes?.find((mailbox) => mailbox.role === "all");

/**
 * The list a route shows. Undefined until that is known: searching
 * everywhere needs the mailboxes (accounts without an All Mail mailbox
 * search the route's mailbox instead).
 */
export function listSpecOf(
  route: Route,
  order: MessageOrder,
  mailboxes: readonly Mailbox[] | undefined,
): ListSpec | undefined {
  if (!route) return undefined;
  const { search } = route;
  if (!search) return { mailboxId: route.mailboxId, order };
  const scope = search.everywhere
    ? mailboxes && (everywhereMailbox(mailboxes)?.id ?? route.mailboxId)
    : route.mailboxId;
  return scope === undefined
    ? undefined
    : { mailboxId: scope, search: search.text.trim(), order };
}

/**
 * The list being shown: what it is, its rows (messages, or conversations
 * in conversation view) and the account's mailboxes.
 */
export function useCurrentList() {
  const route = useRoute();
  const order = useUi((state) => state.listOrder);
  const wantsConversations = useUi((state) => state.settings.conversations);
  const supportsThreads =
    useAccountHandle(route?.accountId)?.provider.capabilities.threads === true;
  const { data: mailboxes } = useMailboxList(route?.accountId);
  const spec = listSpecOf(route, order, mailboxes);
  const scope = findMailbox(mailboxes, spec?.mailboxId);
  // Drafts open one by one in the composer, so they stay single messages.
  const conversations =
    wantsConversations && supportsThreads && scope?.role !== "drafts";
  const messageList = useMessageList(
    route?.accountId,
    conversations ? undefined : spec,
  );
  const threadList = useThreadList(
    route?.accountId,
    conversations ? spec : undefined,
  );
  const isolating = useMemo(
    () => isolatingMailboxes(mailboxes ?? []),
    [mailboxes],
  );
  const threads = threadList.data;
  const messages = messageList.data;
  const rows = useMemo(
    () =>
      conversations
        ? threads && threadRows(threads, scope, isolating)
        : messages && messageRows(messages),
    [conversations, threads, messages, scope, isolating],
  );
  const list = conversations ? threadList : messageList;
  return {
    route,
    order,
    spec,
    /** The query behind the rows (loading state, paging). */
    list,
    /** The rows, once loaded. */
    rows,
    /** Rows are conversations. */
    conversations,
    mailboxes,
    isolating,
    /** The mailbox in the URL (where a search started). */
    mailbox: findMailbox(mailboxes, route?.mailboxId),
    /** The mailbox being listed: the one in the URL, or All Mail when searching everywhere. */
    scope,
    listKey: listKeyOf(route, order, wantsConversations),
  };
}
