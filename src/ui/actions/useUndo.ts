import { useMemo } from "react";
import { useUiStore } from "../../state/context";
import type { ComposeActions } from "../composer/useComposeActions";
import type { MailActions } from "./useMailActions";

/** The app's undo (`z` and the toasts' Undo buttons). */
export interface Undo {
  readonly canUndo: () => boolean;
  /** Undoes the most recent undoable thing: a send, a discarded draft, a mail or label action. */
  readonly undo: () => void;
}

/** {@link Undo} over mail actions, label changes, discarded drafts and queued sends. */
export function useUndo(mail: MailActions, compose: ComposeActions): Undo {
  const store = useUiStore();
  return useMemo((): Undo => {
    const toastUndo = () => {
      const { toast } = store.getState();
      return toast?.undo !== undefined ||
        toast?.restoreDraft !== undefined ||
        toast?.revert !== undefined
        ? toast
        : undefined;
    };
    return {
      canUndo: () =>
        store.getState().pendingSends.length > 0 || toastUndo() !== undefined,
      undo: () => {
        const { pendingSends, dismissToast } = store.getState();
        const toast = toastUndo();
        const send = pendingSends.at(-1);
        if (send && (!toast || send.queuedAt >= toast.createdAt)) {
          compose.undoSend(send.id);
        } else if (toast?.restoreDraft) {
          dismissToast(toast.id);
          compose.restoreDraft(toast.restoreDraft);
        } else if (toast?.revert) {
          dismissToast(toast.id);
          toast.revert();
        } else {
          mail.undo();
        }
      },
    };
  }, [compose, mail, store]);
}
