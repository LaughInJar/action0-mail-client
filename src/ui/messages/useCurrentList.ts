import {
  messageKey,
  messageRef,
  type AccountId,
  type MessageKey,
} from "../../core/ids";
import { pinRows, useBackFromSnooze } from "../../data/scheduled";
import type { Mailbox } from "../../core/model";
import type { MessageOrder } from "../../core/provider";
import { useMemo } from "react";
import { useAccountHandle } from "../../accounts/context";
import { findMailbox, useMessageList, useThreadList } from "../../data/hooks";
import { messageRows, threadRows } from "../../data/listRows";
import { isolatingMailboxes } from "../../data/optimistic";
import type { ListSpec } from "../../data/keys";
import {
  unifiedRoleOf,
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
        // A combined view is one list, whichever account is in context.
        ...(route.unified
          ? ["all", unifiedRoleOf(route)]
          : [route.accountId, route.mailboxId]),
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
 * The route that opens a row of the list `route` shows. In a combined view
 * the row's account (and its mailbox of that kind) becomes the context.
 */
export function routeOfRow(
  route: NonNullable<Route>,
  key: MessageKey,
  sources: ReadonlyMap<AccountId, ListSource>,
): NonNullable<Route> {
  const { accountId, messageId } = messageRef(key);
  if (!route.unified) return { ...route, messageId };
  const role = unifiedRoleOf(route);
  const own = sources
    .get(accountId)
    ?.mailboxes?.find((mailbox) => mailbox.role === role);
  return {
    ...route,
    accountId,
    mailboxId: own?.id ?? route.mailboxId,
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
  // Drafts open one by one in the composer, so they stay single messages;
  // scheduled mail too (each has its own time).
  const conversations =
    wantsConversations &&
    supportsThreads &&
    scope?.role !== "drafts" &&
    scope?.role !== "scheduled" &&
    scope?.role !== "snoozed";
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
  const role = unifiedRoleOf(route);
  const unifiedSpec = useMemo(
    () =>
      unified
        ? {
            role,
            order,
            everywhere,
            conversations: wantsConversations,
            ...(searchText ? { search: searchText } : {}),
          }
        : undefined,
    [unified, role, order, everywhere, wantsConversations, searchText],
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
  // The Inbox (and All inboxes) show mail back from snooze first.
  const inInbox =
    !searchText && (unified ? role === "inbox" : scope?.role === "inbox");
  const listedAccounts = useMemo(
    () => (unified ? [...merged.sources.keys()] : accountId ? [accountId] : []),
    [unified, merged.sources, accountId],
  );
  const pinned = useBackFromSnooze(listedAccounts, inInbox);
  const listed = unified ? merged.rows : single;
  const rows = useMemo(
    () => (listed && pinned.length > 0 ? pinRows(listed, pinned) : listed),
    [listed, pinned],
  );
  const context = unified ? merged.sources.get(route.accountId) : undefined;
  return {
    route,
    order,
    spec,
    /** A combined view: every account's mailbox of a kind, merged. */
    unified,
    /** The combined view's kind (only meaningful with `unified`). */
    unifiedRole: role,
    /** The query behind the rows (loading state, paging). */
    list,
    /** The rows, once loaded. */
    rows,
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
