import { useMemo } from "react";
import { useAccountHandle } from "../../accounts/context";
import type { MessageId } from "../../core/ids";
import { inverseOf, type MailIntent } from "../../core/intents";
import { findMailbox, useMailboxes, useMessageList } from "../../data/hooks";
import { useApplyIntent, usePreviewIntent } from "../../data/mutations";
import { belongsTo, type MessageChange } from "../../data/optimistic";
import { useRoute, useRouter, useUiStore } from "../../state/context";
import { nextAfterRemoval } from "../../state/selection";
import { errorMessage } from "../common/errorMessage";
import { useBreakpoint } from "../layout/useBreakpoint";
import { listKeyOf } from "../messages/useListController";

/** Options of {@link MailActions.setSeen}. */
export interface SetSeenOptions {
  /** Explicit targets; defaults to the selection or the focused message. */
  readonly ids?: readonly MessageId[];
  /** No toast (automatic mark-as-read). */
  readonly silent?: boolean;
}

/** User-level mail actions on the current list. */
export interface MailActions {
  readonly canArchive: boolean;
  readonly canSetSeen: boolean;
  /** The selection (in list order), or else the focused message. */
  readonly targets: () => MessageId[];
  /** Archives `ids`, or the targets. */
  readonly archive: (ids?: readonly MessageId[]) => void;
  readonly setSeen: (seen: boolean, options?: SetSeenOptions) => void;
  /** Reverts the action of the current toast. */
  readonly undo: () => void;
}

const count = (n: number) => (n === 1 ? "1 message" : `${n} messages`);

/**
 * Turns "the current message or selection" into intents: predicts the
 * effect, moves the cursor away from rows that disappear, runs the intent
 * optimistically and reports it in an undoable toast.
 */
export function useMailActions(): MailActions {
  const route = useRoute();
  const router = useRouter();
  const store = useUiStore();
  const breakpoint = useBreakpoint();
  const handle = useAccountHandle(route?.accountId);
  const { data: mailboxes } = useMailboxes(route?.accountId);
  const { data: items } = useMessageList(route?.accountId, route?.mailboxId);
  const preview = usePreviewIntent();
  const { mutate } = useApplyIntent();
  const capabilities = handle?.provider.capabilities;

  return useMemo((): MailActions => {
    const orderedIds = (items ?? []).map((item) => item.id);
    const mailbox = findMailbox(mailboxes, route?.mailboxId);

    const targets = (): MessageId[] => {
      const { selectedIds, focusedId } = store.getState();
      if (selectedIds.size === 0) return focusedId === null ? [] : [focusedId];
      const order = new Map(orderedIds.map((id, index) => [id, index]));
      const rank = (id: MessageId) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
      return [...selectedIds].sort((a, b) => rank(a) - rank(b));
    };

    const apply = (intent: MailIntent, failure: string) => {
      if (!route) return;
      mutate(
        { accountId: route.accountId, intent },
        {
          onError: (error) => {
            store.getState().showToast({
              message: `${failure}: ${errorMessage(error)}`,
              tone: "error",
            });
          },
        },
      );
    };

    /** Moves the cursor off rows that are about to leave the current list. */
    const stepAway = (changes: readonly MessageChange[]) => {
      if (!route || !mailbox) return;
      const removed = new Set(
        changes
          .filter((change) => !belongsTo(mailbox, change.after))
          .map((change) => change.id),
      );
      const state = store.getState();
      if (
        removed.size === 0 ||
        state.focusedId === null ||
        !removed.has(state.focusedId)
      ) {
        state.clearSelection();
        return;
      }
      const next = nextAfterRemoval(orderedIds, removed);
      if (next === null) state.enterList(listKeyOf(route) ?? "", null);
      else state.focusOnly(next);
      // On phones the reader is a screen of its own: follow along or go back.
      if (breakpoint === "narrow" && route.messageId !== undefined) {
        const list = { accountId: route.accountId, mailboxId: route.mailboxId };
        router.navigate(next === null ? list : { ...list, messageId: next }, {
          replace: true,
        });
      }
    };

    return {
      canArchive: capabilities?.archive ?? false,
      canSetSeen: capabilities?.settableFlags.includes("seen") ?? false,
      targets,

      archive: (ids) => {
        if (!route || !capabilities?.archive) return;
        const intent: MailIntent = {
          kind: "archive",
          ids: ids ? [...ids] : targets(),
        };
        if (intent.ids.length === 0) return;
        const { before, changes } = preview({
          accountId: route.accountId,
          intent,
        });
        const { showToast } = store.getState();
        if (changes.length === 0) {
          showToast({
            message: "Not in the Inbox, nothing to archive.",
            tone: "info",
          });
          return;
        }
        stepAway(changes);
        apply(intent, "Couldn’t archive");
        showToast({
          message: `Archived ${count(changes.length)}`,
          tone: "info",
          undo: {
            accountId: route.accountId,
            intents: inverseOf(intent, before),
            known: changes.map((change) => change.after),
          },
        });
      },

      setSeen: (seen, { ids, silent = false } = {}) => {
        if (!route || !capabilities?.settableFlags.includes("seen")) return;
        const intent: MailIntent = {
          kind: "set-flags",
          ids: ids ? [...ids] : targets(),
          flags: { seen },
        };
        const { before, changes } = preview({
          accountId: route.accountId,
          intent,
        });
        if (changes.length === 0) return;
        apply(intent, `Couldn’t mark as ${seen ? "read" : "unread"}`);
        if (!silent) {
          store.getState().showToast({
            message: `Marked ${count(changes.length)} as ${seen ? "read" : "unread"}`,
            tone: "info",
            undo: {
              accountId: route.accountId,
              intents: inverseOf(intent, before),
              known: changes.map((change) => change.after),
            },
          });
        }
      },

      undo: () => {
        const { toast, dismissToast } = store.getState();
        if (!toast?.undo) return;
        dismissToast(toast.id);
        const { accountId, intents, known } = toast.undo;
        let restoredHere: MessageId | undefined;
        for (const intent of intents) {
          if (
            intent.kind === "unarchive" &&
            route?.accountId === accountId &&
            mailbox
          ) {
            const { changes } = preview({ accountId, intent, known });
            restoredHere ??= changes.find((change) =>
              belongsTo(mailbox, change.after),
            )?.id;
          }
          mutate(
            { accountId, intent, known },
            {
              onError: (error) => {
                store.getState().showToast({
                  message: `Couldn’t undo: ${errorMessage(error)}`,
                  tone: "error",
                });
              },
            },
          );
        }
        // Undoing an archive brings the cursor back to the restored message.
        if (restoredHere !== undefined)
          store.getState().focusOnly(restoredHere);
      },
    };
  }, [
    breakpoint,
    capabilities,
    items,
    mailboxes,
    mutate,
    preview,
    route,
    router,
    store,
  ]);
}
