import type { Mailbox } from "../../core/model";
import type { MessageOrder } from "../../core/provider";
import { findMailbox, useMailboxes, useMessageList } from "../../data/hooks";
import type { ListSpec } from "../../data/keys";
import { useRoute, useUi } from "../../state/context";
import type { Route } from "../../state/router";

/** Identifies the list a route shows in an order (focus and selection belong to it). */
export const listKeyOf = (route: Route, order: MessageOrder): string | null =>
  route
    ? JSON.stringify([
        route.accountId,
        route.mailboxId,
        route.search?.text.trim() ?? "",
        route.search?.everywhere ?? false,
        order,
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

/** The list being shown: what it is, its messages and the account's mailboxes. */
export function useCurrentList() {
  const route = useRoute();
  const order = useUi((state) => state.listOrder);
  const { data: mailboxes } = useMailboxes(route?.accountId);
  const spec = listSpecOf(route, order, mailboxes);
  const list = useMessageList(route?.accountId, spec);
  return {
    route,
    order,
    spec,
    list,
    mailboxes,
    /** The mailbox in the URL (where a search started). */
    mailbox: findMailbox(mailboxes, route?.mailboxId),
    /** The mailbox being listed: the one in the URL, or All Mail when searching everywhere. */
    scope: findMailbox(mailboxes, spec?.mailboxId),
    listKey: listKeyOf(route, order),
  };
}
