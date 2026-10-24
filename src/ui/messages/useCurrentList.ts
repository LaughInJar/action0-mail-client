import {
  messageKey,
  messageRef,
  type AccountId,
  type MessageKey,
} from "../../core/ids";
import type { Mailbox } from "../../core/model";
import type { MessageOrder } from "../../core/provider";
import { useMemo } from "react";
import { useAccountHandle } from "../../accounts/context";
import { findMailbox, useMessageList, useThreadList } from "../../data/hooks";
import { messageRows, threadRows } from "../../data/listRows";
import { isolatingMailboxes } from "../../data/optimistic";
import type { ListSpec } from "../../data/keys";
import {
  useUnifiedList,
  type ListQuery,
  type ListSource,
} from "../../data/unified";
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
        // All inboxes is one list, whichever account is in context.
        ...(route.unified ? ["all"] : [route.accountId, route.mailboxId]),
        route.search?.text.trim() ?? "",
        route.search?.everywhere ?? false,
        order,
        conversations,
      ])
    : null;

/** The row key of the message a route opens, if any. */
export const keyOfRoute = (route: Route): MessageKey | null =>
  route?.messageId === undefined
    ? null
    : messageKey(route.accountId, route.messageId);

/**
 * The route that opens a row of the list `route` shows. In All inboxes the
 * row's account becomes the account in context.
 */
export function routeOfRow(
  route: NonNullable<Route>,
  key: MessageKey,
  sources: ReadonlyMap<AccountId, ListSource>,
): NonNullable<Route> {
  const { accountId, messageId } = messageRef(key);
  if (!route.unified) return { ...route, messageId };
  const inbox = sources
    .get(accountId)
    ?.mailboxes?.find((mailbox) => mailbox.role === "inbox");
  return {
    ...route,
    accountId,
    mailboxId: inbox?.id ?? route.mailboxId,
    messageId,
  };
}

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

const NO_SOURCES: ReadonlyMap<AccountId, ListSource> = new Map();

/**
 * The list being shown: what it is, its rows (messages, or conversations
 * in conversation view) and, per account in it, the mailboxes. All inboxes
 * merges several accounts; the single-account fields then describe the
 * account in context (the open message's).
 */
export function useCurrentList() {
  const route = useRoute();
  const order = useUi((state) => state.listOrder);
  const wantsConversations = useUi((state) => state.settings.conversations);
  const unified = route?.unified === true;
  const supportsThreads =
    useAccountHandle(route?.accountId)?.provider.capabilities.threads === true;
  const { data: mailboxes } = useMailboxList(route?.accountId);
  const spec = unified ? undefined : listSpecOf(route, order, mailboxes);
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
  const searchText = route?.search?.text.trim();
  const everywhere = route?.search?.everywhere ?? false;
  const unifiedSpec = useMemo(
    () =>
      unified
        ? {
            order,
            everywhere,
            conversations: wantsConversations,
            ...(searchText ? { search: searchText } : {}),
          }
        : undefined,
    [unified, order, everywhere, wantsConversations, searchText],
  );
  const merged = useUnifiedList(unifiedSpec);
  const isolating = useMemo(
    () => isolatingMailboxes(mailboxes ?? []),
    [mailboxes],
  );
  const accountId = route?.accountId;
  const threads = threadList.data;
  const messages = messageList.data;
  const single = useMemo(
    () =>
      accountId === undefined
        ? undefined
        : conversations
          ? threads && threadRows(accountId, threads, scope, isolating)
          : messages && messageRows(accountId, messages),
    [accountId, conversations, threads, messages, scope, isolating],
  );
  const sources = useMemo(
    () =>
      accountId === undefined
        ? NO_SOURCES
        : new Map([
            [
              accountId,
              { accountId, mailboxes, scope, isolating, conversations },
            ],
          ]),
    [accountId, mailboxes, scope, isolating, conversations],
  );
  const list: ListQuery = unified
    ? merged.list
    : conversations
      ? threadList
      : messageList;
  const context = unified ? merged.sources.get(route.accountId) : undefined;
  return {
    route,
    order,
    spec,
    /** All inboxes: every account's Inbox, merged. */
    unified,
    /** The query behind the rows (loading state, paging). */
    list,
    /** The rows, once loaded. */
    rows: unified ? merged.rows : single,
    /** Each account in the list: its mailboxes and what's listed of it. */
    sources: unified ? merged.sources : sources,
    /** All inboxes: accounts left out (they need reconnecting, or failed). */
    unavailable: unified ? merged.unavailable : [],
    /** Rows are conversations (in All inboxes: the context account's). */
    conversations: context ? context.conversations : conversations,
    mailboxes,
    isolating: context ? context.isolating : isolating,
    /** The mailbox in the URL (where a search started). */
    mailbox: findMailbox(mailboxes, route?.mailboxId),
    /** The mailbox being listed: the one in the URL, or All Mail when searching everywhere. */
    scope: context ? context.scope : scope,
    listKey: listKeyOf(route, order, wantsConversations),
  };
}
