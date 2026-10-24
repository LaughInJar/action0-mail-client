import { useMarkAllRead as useMarkAllReadMutation } from "../../data/mutations";
import type { AccountId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { useT } from "../../i18n/context";

/**
 * Marks everything in a mailbox read, with a toast whose Undo marks
 * exactly those messages unread again.
 */
export function useMarkAllRead(): (
  accountId: AccountId,
  mailbox: Mailbox,
) => void {
  const { mutateAsync } = useMarkAllReadMutation();
  const store = useUiStore();
  const t = useT();
  const m = t.menus;
  return (accountId, mailbox) => {
    mutateAsync({ accountId, mailboxId: mailbox.id }).then(
      (ids) => {
        store.getState().showToast(
          ids.length === 0
            ? { message: m.nothingUnread(mailbox.name), tone: "info" }
            : {
                message: m.markedAllRead(
                  mailbox.name,
                  t.common.messages(ids.length),
                ),
                tone: "info",
                undo: [
                  {
                    accountId,
                    intents: [
                      { kind: "set-flags", ids, flags: { seen: false } },
                    ],
                    known: [],
                  },
                ],
              },
        );
      },
      (error: unknown) => {
        store.getState().showToast({
          message: `${m.couldntMarkAllRead(mailbox.name)}: ${errorMessage(error, t)}`,
          tone: "error",
        });
      },
    );
  };
}
