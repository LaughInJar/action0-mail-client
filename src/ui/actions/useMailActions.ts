import { useMemo } from "react";
import { useAccountHandle } from "../../accounts/context";
import type { MailboxId, MessageId } from "../../core/ids";
import {
  inverseOf,
  type MailIntent,
  type MessageChange,
} from "../../core/intents";
import { findMailbox, useMailboxes, useMessageList } from "../../data/hooks";
import { useApplyIntent, usePreviewIntent } from "../../data/mutations";
import { belongsTo } from "../../data/optimistic";
import { useRoute, useRouter, useUiStore } from "../../state/context";
import { nextAfterRemoval } from "../../state/selection";
import type { PickerState } from "../../state/uiStore";
import { errorMessage } from "../common/errorMessage";
import { useBreakpoint } from "../layout/useBreakpoint";

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
  readonly canStar: boolean;
  readonly canMove: boolean;
  readonly canLabel: boolean;
  /** The selection (in list order), or else the focused message. */
  readonly targets: () => MessageId[];
  /** Archives `ids`, or the targets. */
  readonly archive: (ids?: readonly MessageId[]) => void;
  readonly setSeen: (seen: boolean, options?: SetSeenOptions) => void;
  /** Stars all of them, unless all are starred already: then unstars all. */
  readonly toggleStar: (ids?: readonly MessageId[]) => void;
  /** Moves out of the current mailbox into `to`. */
  readonly moveTo: (to: MailboxId, ids?: readonly MessageId[]) => void;
  readonly setLabels: (
    add: readonly MailboxId[],
    remove: readonly MailboxId[],
    ids?: readonly MessageId[],
  ) => void;
  /** Opens the move or label picker for `ids`, or the targets. */
  readonly openPicker: (
    mode: PickerState["mode"],
    ids?: readonly MessageId[],
  ) => void;
  /** Reverts the action of the current toast. */
  readonly undo: () => void;
}

interface PerformOptions {
  /** Toast text for the done action; omit for silent actions. */
  readonly done?: (count: number) => string;
  /** Prefix of the error toast. */
  readonly failure: string;
  /** Toast when nothing would change; omit to stay quiet. */
  readonly nothing?: string;
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
    const nameOf = (id: MailboxId) =>
      findMailbox(mailboxes, id)?.name ?? "the mailbox";

    const targets = (): MessageId[] => {
      const { selectedIds, focusedId } = store.getState();
      if (selectedIds.size === 0) return focusedId === null ? [] : [focusedId];
      const order = new Map(orderedIds.map((id, index) => [id, index]));
      const rank = (id: MessageId) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
      return [...selectedIds].sort((a, b) => rank(a) - rank(b));
    };

    const run = (intent: MailIntent, failure: string) => {
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

    /**
     * Rows that leave the current list drop out of the selection; if the
     * cursor was on one, it moves to the next row below (or above at the end).
     */
    const stepAway = (changes: readonly MessageChange[]) => {
      if (!route || !mailbox) return;
      const removed = new Set(
        changes
          .filter((change) => !belongsTo(mailbox, change.after))
          .map((change) => change.id),
      );
      if (removed.size === 0) return;
      const state = store.getState();
      const focusLeaves =
        state.focusedId !== null && removed.has(state.focusedId);
      const next = focusLeaves ? nextAfterRemoval(orderedIds, removed) : null;
      state.removeFromList(removed, next);
      // On phones the reader is a screen of its own: follow along or go back.
      if (
        focusLeaves &&
        breakpoint === "narrow" &&
        route.messageId !== undefined
      ) {
        const list = { accountId: route.accountId, mailboxId: route.mailboxId };
        router.navigate(next === null ? list : { ...list, messageId: next }, {
          replace: true,
        });
      }
    };

    /** Preview → step away → mutate → undo toast. */
    const perform = (intent: MailIntent, options: PerformOptions) => {
      if (!route || intent.ids.length === 0) return;
      const { showToast } = store.getState();
      const { changes } = preview({ accountId: route.accountId, intent });
      if (changes.length === 0) {
        if (options.nothing)
          showToast({ message: options.nothing, tone: "info" });
        return;
      }
      stepAway(changes);
      run(intent, options.failure);
      if (!options.done) return;
      showToast({
        message: options.done(changes.length),
        tone: "info",
        undo: {
          accountId: route.accountId,
          intents: inverseOf(intent, changes, {
            labels: capabilities?.labels ?? false,
          }),
          known: changes.map((change) => change.after),
        },
      });
    };

    const ids = (explicit?: readonly MessageId[]) =>
      explicit ? [...explicit] : targets();

    return {
      canArchive: capabilities?.archive ?? false,
      canSetSeen: capabilities?.settableFlags.includes("seen") ?? false,
      canStar: capabilities?.settableFlags.includes("flagged") ?? false,
      canMove: capabilities?.move ?? false,
      canLabel: capabilities?.labels ?? false,
      targets,

      archive: (explicit) => {
        if (!capabilities?.archive) return;
        perform(
          { kind: "archive", ids: ids(explicit) },
          {
            done: (n) => `Archived ${count(n)}`,
            failure: "Couldn’t archive",
            nothing: "Not in the Inbox, nothing to archive.",
          },
        );
      },

      setSeen: (seen, { ids: explicit, silent = false } = {}) => {
        if (!capabilities?.settableFlags.includes("seen")) return;
        perform(
          { kind: "set-flags", ids: ids(explicit), flags: { seen } },
          {
            ...(silent
              ? {}
              : {
                  done: (n: number) =>
                    `Marked ${count(n)} as ${seen ? "read" : "unread"}`,
                }),
            failure: `Couldn’t mark as ${seen ? "read" : "unread"}`,
          },
        );
      },

      toggleStar: (explicit) => {
        if (!route || !capabilities?.settableFlags.includes("flagged")) return;
        const targetIds = ids(explicit);
        const star: MailIntent = {
          kind: "set-flags",
          ids: targetIds,
          flags: { flagged: true },
        };
        // Star if any of them isn't starred yet; otherwise unstar all.
        const flagged =
          preview({ accountId: route.accountId, intent: star }).changes.length >
          0;
        perform(
          { kind: "set-flags", ids: targetIds, flags: { flagged } },
          {
            done: (n) => `${flagged ? "Starred" : "Unstarred"} ${count(n)}`,
            failure: `Couldn’t ${flagged ? "star" : "unstar"}`,
          },
        );
      },

      moveTo: (to, explicit) => {
        if (!route || !capabilities?.move) return;
        const name = nameOf(to);
        perform(
          { kind: "move", ids: ids(explicit), from: route.mailboxId, to },
          {
            done: (n) => `Moved ${count(n)} to ${name}`,
            failure: "Couldn’t move",
            nothing: `Already in ${name}.`,
          },
        );
      },

      setLabels: (add, remove, explicit) => {
        if (!capabilities?.labels) return;
        const [onlyAdded] = add;
        const [onlyRemoved] = remove;
        perform(
          { kind: "set-labels", ids: ids(explicit), add, remove },
          {
            done: (n) => {
              if (add.length === 1 && remove.length === 0 && onlyAdded)
                return `Added label ${nameOf(onlyAdded)} to ${count(n)}`;
              if (remove.length === 1 && add.length === 0 && onlyRemoved)
                return `Removed label ${nameOf(onlyRemoved)} from ${count(n)}`;
              return `Changed labels of ${count(n)}`;
            },
            failure: "Couldn’t change labels",
          },
        );
      },

      openPicker: (mode, explicit) => {
        if (!route) return;
        const targetIds = ids(explicit);
        if (targetIds.length === 0) return;
        store
          .getState()
          .setPicker({ mode, accountId: route.accountId, ids: targetIds });
      },

      undo: () => {
        const { toast, dismissToast } = store.getState();
        if (!toast?.undo) return;
        dismissToast(toast.id);
        const { accountId, intents, known } = toast.undo;
        let restoredHere: MessageId | undefined;
        for (const intent of intents) {
          if (route?.accountId === accountId && mailbox) {
            const { changes } = preview({ accountId, intent, known });
            restoredHere ??= changes.find(
              (change) =>
                belongsTo(mailbox, change.after) &&
                !belongsTo(mailbox, change.before),
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
        // Undo brings the cursor back to a message that returns to this list.
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
