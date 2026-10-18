import type { MessageId } from "../../core/ids";
import type { Arrivals } from "../../data/sync";
import type { HashRouter } from "../../state/router";
import { COARSE_POINTER_QUERY } from "../layout/useBreakpoint";
import type { I18n } from "../../i18n/context";

/**
 * Desktop notifications can be offered. Phones only show notifications from
 * installed apps (service worker), so they aren't offered on touch devices.
 */
export function notificationsSupported(): boolean {
  return (
    typeof Notification !== "undefined" &&
    !window.matchMedia(COARSE_POINTER_QUERY).matches
  );
}

/** Desktop notifications exist and may be shown. */
export function notificationsAllowed(): boolean {
  return (
    typeof Notification !== "undefined" && Notification.permission === "granted"
  );
}

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
): void {
  if (!notificationsAllowed() || appInFront()) return;
  try {
    show(arrivals, router, t);
  } catch {
    // Some browsers (Chrome on Android) only notify through a service worker.
  }
}

function show(arrivals: Arrivals, router: HashRouter, t: I18n): void {
  const { accountId, inboxId, messages } = arrivals;
  const open = (notification: Notification, messageId?: MessageId) => {
    notification.onclick = () => {
      window.focus();
      router.navigate({
        accountId,
        mailboxId: inboxId,
        ...(messageId === undefined ? {} : { messageId }),
      });
      notification.close();
    };
  };

  if (messages.length > 3) {
    const senders = [
      ...new Set(messages.map((m) => m.from?.name ?? m.from?.address ?? "")),
    ].filter(Boolean);
    const notification = new Notification(
      t.layout.notifyMany(messages.length),
      {
        body: senders.join(", "),
        tag: `a0-${accountId}`,
        icon: "/favicon.svg",
      },
    );
    open(notification);
    return;
  }
  for (const message of messages) {
    const notification = new Notification(
      message.from?.name ?? message.from?.address ?? t.layout.notifyOne,
      {
        body: [message.subject, message.snippet].filter(Boolean).join("\n"),
        // The same mail never notifies twice.
        tag: `a0-${message.id}`,
        icon: "/favicon.svg",
      },
    );
    open(notification, message.id);
  }
}
