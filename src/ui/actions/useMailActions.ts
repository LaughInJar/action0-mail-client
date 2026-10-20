import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccountHandle } from "../../accounts/context";
import type { MailboxId, MessageId } from "../../core/ids";
import {
  inverseOf,
  type MailIntent,
  type MessageChange,
} from "../../core/intents";
import { findMailbox } from "../../data/hooks";
import {
  cachedMailboxes,
  cachedSummaries,
  threadMessageIds,
  useApplyIntent,
  useEmptyMailbox,
  usePreviewIntent,
} from "../../data/mutations";
import { rowsLeaving } from "../../data/listRows";
import {
  belongsTo,
  isolatingMailboxes,
  threadIdOf,
} from "../../data/optimistic";
import { useRouter, useUiStore } from "../../state/context";
import { listRoute } from "../../state/router";
import { nextAfterRemoval } from "../../state/selection";
import type { MailConfirmAction, PickerState } from "../../state/uiStore";
import type { Mailbox } from "../../core/model";
import { errorMessage } from "../common/errorMessage";
import { useBreakpoint } from "../layout/useBreakpoint";
import { useCurrentList } from "../messages/useCurrentList";
import { useT } from "../../i18n/context";
import { mailboxName, usesFolders } from "../common/mailboxNames";

/** Options of {@link MailActions.setSeen}. */
export interface SetSeenOptions {
  /** Explicit targets; defaults to the selection or the focused message. */
  readonly ids?: readonly MessageId[];
  /** No toast (automatic mark-as-read). */
  readonly silent?: boolean;
  /** The ids are messages, not rows (never whole conversations). */
  readonly exact?: boolean;
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
  /**
   * Stars all of them, unless all are starred already: then unstars all.
   * Conversations: stars the newest message of those without a star, or
   * unstars every message. `exact`: the ids are messages, not rows.
   */
  readonly toggleStar: (
    ids?: readonly MessageId[],
    options?: { readonly exact?: boolean },
  ) => void;
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
  readonly canTrash: boolean;
  readonly canSpam: boolean;
  readonly canDeleteForever: boolean;
  /** Role of the mailbox being shown ("trash" and "junk" change what actions do). */
  readonly view: Mailbox["role"];
  /** Move to Trash; inside Trash: restore. */
  readonly trash: (ids?: readonly MessageId[]) => void;
  /** Report spam; inside Spam: not spam (back to the Inbox). */
  readonly spam: (ids?: readonly MessageId[]) => void;
  /** Asks for confirmation, then deletes permanently (only inside Trash or Spam). */
  readonly requestDeleteForever: (ids?: readonly MessageId[]) => void;
  /** Asks for confirmation, then empties the Trash or Spam being shown. */
  readonly requestEmpty: () => void;
  /** Runs a confirmed destructive action (called by the confirmation dialog). */
  readonly runConfirmed: (action: MailConfirmAction) => void;
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

/**
 * Turns "the current message or selection" into intents: predicts the
 * effect, moves the cursor away from rows that disappear, runs the intent
 * optimistically and reports it in an undoable toast.
 */
export function useMailActions(): MailActions {
  const {
    route,
    rows,
    conversations,
    mailboxes,
    scope: mailbox,
    listKey,
  } = useCurrentList();
  const router = useRouter();
  const store = useUiStore();
  const breakpoint = useBreakpoint();
  const handle = useAccountHandle(route?.accountId);
  const queryClient = useQueryClient();
  const t = useT();
  const preview = usePreviewIntent();
  // mutateAsync, not mutate: the promise settles even when the calling
  // component (picker, confirmation, reader) unmounts first, so error toasts
  // are never lost. Rollback lives in the mutation itself either way.
  const { mutateAsync: apply } = useApplyIntent();
  const { mutateAsync: empty } = useEmptyMailbox();
  const capabilities = handle?.provider.capabilities;

  return useMemo((): MailActions => {
    const orderedIds = (rows ?? []).map((row) => row.id);
    const isolating = isolatingMailboxes(mailboxes ?? []);
    const a = t.actions;
    const count = conversations ? t.common.conversations : t.common.messages;
    /**
     * Rows → messages: a conversation stands for all its messages. In a
     * folder (folder accounts), actions that move mail take only its
     * messages in that folder, like Outlook: sent replies stay in Sent.
     */
    const expand = (
      ids: readonly MessageId[],
      kind: MailIntent["kind"] = "set-flags",
    ): MessageId[] => {
      if (!conversations || !route) return [...ids];
      const all = threadMessageIds(queryClient, route.accountId, ids);
      if (kind === "set-flags" || mailbox?.kind !== "folder") return all;
      const here = mailbox.id;
      const inFolder = new Set(
        cachedSummaries(queryClient, route.accountId, all)
          .filter((message) => message.mailboxIds.includes(here))
          .map((message) => message.id),
      );
      return all.filter((id) => inFolder.has(id));
    };
    /** How many rows the changes touch (conversations, or messages). */
    const touched = (changes: readonly MessageChange[]) =>
      conversations
        ? new Set(changes.map((change) => threadIdOf(change.before))).size
        : changes.length;
    const view = mailbox?.role;
    // A label created a moment ago may not have reached `mailboxes` yet.
    const mailboxOf = (id: MailboxId) =>
      findMailbox(mailboxes, id) ??
      (route && findMailbox(cachedMailboxes(queryClient, route.accountId), id));
    const roleOf = (id: MailboxId) => mailboxOf(id)?.role;
    const nameOf = (id: MailboxId) => {
      const found = mailboxOf(id);
      return found
        ? mailboxName(found, t, usesFolders(mailboxes ?? []))
        : a.theMailbox;
    };

    const targets = (): MessageId[] => {
      const { selectedIds, focusedId } = store.getState();
      if (selectedIds.size === 0) return focusedId === null ? [] : [focusedId];
      const order = new Map(orderedIds.map((id, index) => [id, index]));
      const rank = (id: MessageId) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
      return [...selectedIds].sort((a, b) => rank(a) - rank(b));
    };

    const showError = (prefix: string) => (error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error, t)}`,
        tone: "error",
      });
    };

    const run = (intent: MailIntent, failure: string) => {
      if (!route) return;
      apply({ accountId: route.accountId, intent }).catch(showError(failure));
    };

    /**
     * Rows that leave the current list drop out of the selection; if the
     * cursor was on one, it moves to the next row below (or above at the end).
     */
    const stepAway = (changes: readonly MessageChange[]) => {
      if (!route || !mailbox) return;
      const removed = rowsLeaving(rows ?? [], mailbox, changes, isolating);
      if (removed.size === 0) return;
      const state = store.getState();
      const { afterRemove } = state.settings;
      const focusLeaves =
        state.focusedId !== null && removed.has(state.focusedId);
      const next = focusLeaves
        ? nextAfterRemoval(
            orderedIds,
            removed,
            afterRemove === "above" ? "above" : "below",
          )
        : null;
      const open = afterRemove !== "list";
      state.removeFromList(removed, next, { open });
      // On phones the reader is a screen of its own: follow along or go back.
      if (
        focusLeaves &&
        breakpoint === "narrow" &&
        route.messageId !== undefined
      ) {
        const list = listRoute(route);
        router.navigate(
          next === null || !open ? list : { ...list, messageId: next },
          { replace: true },
        );
      }
    };

    /**
     * Preview → step away → mutate → undo toast. The intent's ids are rows
     * (whole conversations in conversation view), unless `exact`.
     */
    const perform = (
      rowIntent: MailIntent,
      options: PerformOptions,
      exact = false,
    ) => {
      if (!route || rowIntent.ids.length === 0) return;
      const intent: MailIntent = exact
        ? rowIntent
        : { ...rowIntent, ids: expand(rowIntent.ids, rowIntent.kind) };
      const { showToast } = store.getState();
      const { changes } = preview({ accountId: route.accountId, intent });
      if (changes.length === 0) {
        if (options.nothing)
          showToast({ message: options.nothing, tone: "info" });
        return;
      }
      stepAway(changes);
      // Only what changes: folder providers would otherwise also move
      // messages an archive doesn't apply to (those outside the inbox).
      run(
        { ...intent, ids: changes.map((change) => change.id) },
        options.failure,
      );
      if (!options.done) return;
      const inverse = inverseOf(intent, changes, {
        labels: capabilities?.labels ?? false,
      });
      showToast({
        message: options.done(touched(changes)),
        tone: "info",
        // Permanent deletion has nothing to undo.
        ...(inverse.length > 0
          ? {
              undo: {
                accountId: route.accountId,
                intents: inverse,
                known: changes.map((change) => change.after),
              },
            }
          : {}),
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
            done: (n) => a.archived(count(n)),
            failure: a.couldntArchive,
            nothing: a.notInInbox,
          },
        );
      },

      setSeen: (
        seen,
        { ids: explicit, silent = false, exact = false } = {},
      ) => {
        if (!capabilities?.settableFlags.includes("seen")) return;
        perform(
          { kind: "set-flags", ids: ids(explicit), flags: { seen } },
          {
            ...(silent
              ? {}
              : {
                  done: (n: number) => a.marked(count(n), seen),
                }),
            failure: a.couldntMark(seen),
          },
          exact,
        );
      },

      toggleStar: (explicit, { exact = false } = {}) => {
        if (!route || !capabilities?.settableFlags.includes("flagged")) return;
        const targetIds = ids(explicit);
        const done = (flagged: boolean) => (n: number) =>
          a.starred(count(n), flagged);
        const failure = (flagged: boolean) => a.couldntStar(flagged);

        if (conversations && !exact) {
          // Like Gmail: a conversation's star is on its newest message.
          const threads = targetIds.map((id) =>
            cachedSummaries(
              queryClient,
              route.accountId,
              threadMessageIds(queryClient, route.accountId, [id]),
            ).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
          );
          const unstarred = threads.filter(
            (messages) => !messages.some((m) => m.flags.flagged),
          );
          const flagged = unstarred.length > 0;
          const messageIds = flagged
            ? unstarred.flatMap((messages) => {
                const newest = messages.at(-1);
                return newest ? [newest.id] : [];
              })
            : threads.flatMap((messages) =>
                messages.filter((m) => m.flags.flagged).map((m) => m.id),
              );
          perform(
            { kind: "set-flags", ids: messageIds, flags: { flagged } },
            { done: done(flagged), failure: failure(flagged) },
            true,
          );
          return;
        }

        const star: MailIntent = {
          kind: "set-flags",
          ids: exact ? targetIds : expand(targetIds),
          flags: { flagged: true },
        };
        // Star if any of them isn't starred yet; otherwise unstar all.
        const flagged =
          preview({ accountId: route.accountId, intent: star }).changes.length >
          0;
        perform(
          { kind: "set-flags", ids: targetIds, flags: { flagged } },
          { done: done(flagged), failure: failure(flagged) },
          exact,
        );
      },

      moveTo: (to, explicit) => {
        if (!route) return;
        // Trash and Spam have their own semantics (and Gmail its own calls).
        if (roleOf(to) === "trash" && capabilities?.trash) {
          perform(
            { kind: "trash", ids: ids(explicit) },
            {
              done: (n) => a.movedToTrash(count(n)),
              failure: a.couldntTrash,
            },
          );
          return;
        }
        if (roleOf(to) === "junk" && capabilities?.spam) {
          perform(
            { kind: "report-spam", ids: ids(explicit) },
            {
              done: (n) => a.reportedSpam(count(n)),
              failure: a.couldntReportSpam,
            },
          );
          return;
        }
        if (!capabilities?.move) return;
        const name = nameOf(to);
        perform(
          {
            kind: "move",
            ids: ids(explicit),
            from: mailbox?.id ?? route.mailboxId,
            to,
          },
          {
            done: (n) => a.moved(count(n), name),
            failure: a.couldntMove,
            nothing: a.alreadyIn(name),
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
                return a.labelAdded(nameOf(onlyAdded), count(n));
              if (remove.length === 1 && add.length === 0 && onlyRemoved)
                return a.labelRemoved(nameOf(onlyRemoved), count(n));
              return a.labelsChanged(count(n));
            },
            failure: a.couldntChangeLabels,
          },
        );
      },

      openPicker: (mode, explicit) => {
        if (!route) return;
        const targetIds = ids(explicit);
        if (targetIds.length === 0) return;
        store.getState().setPicker({
          mode,
          accountId: route.accountId,
          ids: targetIds,
          conversations,
        });
      },

      canTrash: capabilities?.trash ?? false,
      canSpam: capabilities?.spam ?? false,
      canDeleteForever: capabilities?.deleteForever ?? false,
      view,

      trash: (explicit) => {
        if (!capabilities?.trash) return;
        if (view === "trash") {
          perform(
            { kind: "untrash", ids: ids(explicit) },
            {
              done: (n) => a.restored(count(n)),
              failure: a.couldntRestore,
            },
          );
        } else {
          perform(
            { kind: "trash", ids: ids(explicit) },
            {
              done: (n) => a.movedToTrash(count(n)),
              failure: a.couldntTrash,
            },
          );
        }
      },

      spam: (explicit) => {
        if (!capabilities?.spam) return;
        if (view === "junk") {
          perform(
            { kind: "not-spam", ids: ids(explicit) },
            {
              done: (n) => a.notSpamMoved(count(n)),
              failure: a.couldntNotSpam,
            },
          );
        } else {
          perform(
            { kind: "report-spam", ids: ids(explicit) },
            {
              done: (n) => a.reportedSpam(count(n)),
              failure: a.couldntReportSpam,
            },
          );
        }
      },

      requestDeleteForever: (explicit) => {
        if (!route || !capabilities?.deleteForever) return;
        if (view !== "trash" && view !== "junk") return;
        const targetIds = ids(explicit);
        if (targetIds.length === 0) return;
        store.getState().setConfirm({
          title: a.deleteForeverTitle(count(targetIds.length)),
          message: a.cantBeUndone,
          confirmLabel: a.deleteForever,
          action: {
            kind: "delete-forever",
            accountId: route.accountId,
            ids: targetIds,
          },
        });
      },

      requestEmpty: () => {
        // Emptying deletes everything, so not from a search's results.
        if (!route || route.search || !mailbox || !capabilities?.deleteForever)
          return;
        if (view !== "trash" && view !== "junk") return;
        store.getState().setConfirm({
          title: a.emptyTitle(mailbox.name),
          message: a.emptyMessage(mailbox.name),
          confirmLabel: a.empty(mailbox.name),
          action: {
            kind: "empty",
            accountId: route.accountId,
            mailboxId: mailbox.id,
            name: mailbox.name,
          },
        });
      },

      runConfirmed: (action) => {
        store.getState().setConfirm(null);
        if (action.kind === "delete-forever") {
          if (route?.accountId !== action.accountId) return;
          perform(
            { kind: "delete-forever", ids: action.ids },
            {
              done: (n) => a.deletedForever(count(n)),
              failure: a.couldntDelete,
            },
          );
          return;
        }
        store.getState().enterList(listKey ?? "", null);
        empty({
          accountId: action.accountId,
          mailboxId: action.mailboxId,
        }).then(
          ({ deleted }) => {
            store.getState().showToast({
              message: a.emptied(action.name, t.common.messages(deleted)),
              tone: "info",
            });
          },
          showError(a.couldntEmpty(action.name)),
        );
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
                belongsTo(mailbox, change.after, isolating) &&
                !belongsTo(mailbox, change.before, isolating),
            )?.id;
          }
          apply({ accountId, intent, known }).catch(showError(a.couldntUndo));
        }
        // Undo brings the cursor back to a message that returns to this list.
        if (restoredHere !== undefined)
          store.getState().focusOnly(restoredHere);
      },
    };
  }, [
    breakpoint,
    apply,
    capabilities,
    empty,
    listKey,
    mailbox,
    mailboxes,
    preview,
    queryClient,
    route,
    router,
    rows,
    conversations,
    store,
    t,
  ]);
}
