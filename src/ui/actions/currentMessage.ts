import { messageRef, type MessageRef } from "../../core/ids";
import type { HashRouter } from "../../state/router";
import type { UiStore } from "../../state/uiStore";

/**
 * The message keyboard commands act on (answering, showing its original):
 * the one at the open conversation's cursor, else the one shown in the
 * reader (or under the list's cursor), of its account.
 */
export function currentMessage(
  store: UiStore,
  router: HashRouter,
): MessageRef | undefined {
  const { readerCursor, focusedId } = store.getState();
  const route = router.getRoute();
  const focused = focusedId === null ? undefined : messageRef(focusedId);
  const accountId = focused?.accountId ?? route?.accountId;
  const messageId = readerCursor ?? focused?.messageId ?? route?.messageId;
  return accountId === undefined || messageId === undefined
    ? undefined
    : { accountId, messageId };
}
