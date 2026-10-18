import { useMemo } from "react";
import { useAccountRegistry } from "../../accounts/context";
import { textToHtml } from "../../compose/html";
import type { AccountId } from "../../core/ids";
import type { Message, Unsubscribe } from "../../core/model";
import { useDraftSync } from "../../data/drafts";
import { useUiStore } from "../../state/context";
import type { ConfirmAction } from "../../state/uiStore";
import { errorMessage } from "../common/errorMessage";
import { displayName } from "../common/format";

/** The confirmed action of an unsubscribe confirmation. */
export type UnsubscribeAction = Extract<
  ConfirmAction,
  { readonly kind: "unsubscribe" }
>;

/** Leaving mailing lists, from the reader. */
export interface UnsubscribeActions {
  /** Asks for confirmation (unsubscribing can't be undone). */
  readonly request: (accountId: AccountId, message: Message) => void;
  /**
   * Unsubscribes, after the user confirmed: one-click if offered, else the
   * unsubscribe mail, else the sender's page. Must run inside the click, so
   * a page can open in a new tab without the popup blocker stopping it.
   */
  readonly run: (action: UnsubscribeAction) => void;
}

/** Keys for the draft sync; composers use positive ones. */
let nextMailKey = -1;

/** The host name of a URL, for messages ("news.example"). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the confirmation says will happen. */
function confirmText(sender: string, unsubscribe: Unsubscribe) {
  if (unsubscribe.oneClick)
    return {
      message: `${sender} will be asked to stop sending you mail. This can’t be undone.`,
      confirmLabel: "Unsubscribe",
    };
  if (unsubscribe.mail)
    return {
      message: `An unsubscribe request will be mailed from your address to ${unsubscribe.mail.to}. This can’t be undone.`,
      confirmLabel: "Unsubscribe",
    };
  return {
    message: `${sender}’s unsubscribe page (${hostOf(unsubscribe.page ?? "")}) opens in a new tab, where you finish unsubscribing.`,
    confirmLabel: "Open page",
  };
}

/** The app's {@link UnsubscribeActions}. */
export function useUnsubscribe(): UnsubscribeActions {
  const store = useUiStore();
  const registry = useAccountRegistry();
  const drafts = useDraftSync();

  return useMemo((): UnsubscribeActions => {
    const openPage = (url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
    };

    return {
      request: (accountId, message) => {
        const { unsubscribe } = message;
        if (!unsubscribe) return;
        const sender = displayName(message.from);
        store.getState().setConfirm({
          title: `Unsubscribe from ${sender}?`,
          ...confirmText(sender, unsubscribe),
          action: {
            kind: "unsubscribe",
            accountId,
            messageId: message.id,
            sender,
            unsubscribe,
          },
        });
      },

      run: ({ accountId, messageId, sender, unsubscribe }) => {
        const state = store.getState();
        state.setConfirm(null);
        const { oneClick, mail, page } = unsubscribe;
        const provider = registry.get(accountId)?.provider;
        const canMail = !!mail && provider?.capabilities.compose === true;
        const done = (message: string) => {
          store.getState().markUnsubscribed(messageId);
          store.getState().showToast({ message, tone: "info" });
        };

        // Only a page: open it now, while the click still counts.
        if (!oneClick && !canMail) {
          if (page) {
            openPage(page);
            done(`Opened the unsubscribe page of ${sender}`);
          }
          return;
        }

        state.showToast({
          message: `Unsubscribing from ${sender}…`,
          tone: "info",
        });
        const attempt = async () => {
          let failure: unknown;
          if (oneClick && provider) {
            try {
              await provider.oneClickUnsubscribe(oneClick);
              done(`Unsubscribed from ${sender}`);
              return;
            } catch (error) {
              failure = error;
            }
          }
          if (mail && canMail) {
            try {
              await drafts.send(
                nextMailKey--,
                accountId,
                {
                  to: [{ address: mail.to }],
                  cc: [],
                  bcc: [],
                  subject: mail.subject ?? "Unsubscribe",
                  body: textToHtml(mail.body ?? "Please unsubscribe me."),
                  attachments: [],
                },
                undefined,
              );
              done(`Unsubscribe mail sent to ${mail.to}`);
              return;
            } catch (error) {
              failure = error;
            }
          }
          if (page) {
            // Too late for a popup: offer the page as a link instead.
            store.getState().showToast({
              message: `Couldn’t unsubscribe from ${sender} automatically.`,
              tone: "error",
              link: { label: "Open their page", href: page },
            });
            return;
          }
          throw failure;
        };
        attempt().catch((error: unknown) => {
          store.getState().showToast({
            message: `Couldn’t unsubscribe from ${sender}: ${errorMessage(error)}`,
            tone: "error",
          });
        });
      },
    };
  }, [drafts, registry, store]);
}
