import type { MessageId } from "../../core/ids";
import type { Arrivals } from "../../data/sync";
import type { NotificationsPort } from "../../platform/types";
import type { HashRouter } from "../../state/router";
import type { I18n } from "../../i18n/context";

/** The app is visible and focused: new mail shows up in it anyway. */
const appInFront = () => !document.hidden && document.hasFocus();

/**
 * Notifies about new mail while the app isn't in front: one notification
 * per message, or one for all when several arrive at once. A click brings
 * the app forward and opens the message (or the Inbox).
 */
export function notifyArrivals(
  arrivals: Arrivals,
  router: HashRouter,
  t: I18n,
  notifications: NotificationsPort,
): void {
  if (!notifications.allowed() || appInFront()) return;
  const { accountId, inboxId, messages } = arrivals;
  const open = (messageId?: MessageId) => () => {
    router.navigate({
      accountId,
      mailboxId: inboxId,
      ...(messageId === undefined ? {} : { messageId }),
    });
  };

  if (messages.length > 3) {
    const senders = [
      ...new Set(messages.map((m) => m.from?.name ?? m.from?.address ?? "")),
    ].filter(Boolean);
    notifications.show({
      title: t.layout.notifyMany(messages.length),
      body: senders.join(", "),
      tag: `a0-${accountId}`,
      onClick: open(),
    });
    return;
  }
  for (const message of messages)
    notifications.show({
      title: message.from?.name ?? message.from?.address ?? t.layout.notifyOne,
      body: [message.subject, message.snippet].filter(Boolean).join("\n"),
      // The same mail never notifies twice.
      tag: `a0-${message.id}`,
      onClick: open(message.id),
    });
}
