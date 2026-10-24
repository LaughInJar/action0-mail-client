import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccounts } from "../../accounts/context";
import {
  messageKey,
  messageRef,
  type AccountId,
  type MailboxId,
  type MessageId,
  type MessageKey,
} from "../../core/ids";
import {
  inverseOf,
  type MailIntent,
  type MessageChange,
} from "../../core/intents";
import type { ProviderCapabilities } from "../../core/provider";
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
import { belongsTo, threadIdOf } from "../../data/optimistic";
import type { ListSource } from "../../data/unified";
import { useRouter, useUiStore } from "../../state/context";
import { listRoute } from "../../state/router";
import { nextAfterRemoval } from "../../state/selection";
import type {
  MailConfirmAction,
  PickerState,
  UndoStep,
} from "../../state/uiStore";
import type { Mailbox } from "../../core/model";
import { errorMessage } from "../common/errorMessage";
import { useBreakpoint } from "../layout/useBreakpoint";
import { routeOfRow, useCurrentList } from "../messages/useCurrentList";
import { useT } from "../../i18n/context";
import { mailboxName, usesFolders } from "../common/mailboxNames";

/** `exact`: the keys are messages, not rows (never whole conversations). */
export interface ExactOption {
  readonly exact?: boolean;
}

/** Options of {@link MailActions.setSeen}. */
export interface SetSeenOptions {
  /** Explicit targets; defaults to the selection or the focused message. */
  readonly keys?: readonly MessageKey[];
  /** No toast (automatic mark-as-read). */
  readonly silent?: boolean;
  /** The keys are messages, not rows (never whole conversations). */
  readonly exact?: boolean;
}

/**
 * User-level mail actions on the current list. Targets are rows by
 * {@link MessageKey}; in All inboxes they can belong to several accounts,
 * and each account gets its part (moving and labels work in one account).
 */
export interface MailActions {
  readonly canArchive: boolean;
  readonly canSetSeen: boolean;
  readonly canStar: boolean;
  readonly canMove: boolean;
  readonly canLabel: boolean;
  /** The list's labels are Outlook categories (all its accounts use folders). */
  readonly labelsAreCategories: boolean;
  /** The selection (in list order), or else the focused message. */
  readonly targets: () => MessageKey[];
  /** Archives `keys`, or the targets. */
  readonly archive: (
    keys?: readonly MessageKey[],
    options?: ExactOption,
  ) => void;
  readonly setSeen: (seen: boolean, options?: SetSeenOptions) => void;
  /**
   * Stars all of them, unless all are starred already: then unstars all.
   * Conversations: stars the newest message of those without a star, or
   * unstars every message. `exact`: the keys are messages, not rows.
   */
  readonly toggleStar: (
    keys?: readonly MessageKey[],
    options?: { readonly exact?: boolean },
  ) => void;
  /** Moves out of the listed mailbox into `to` (a mailbox of their account). */
  readonly moveTo: (
    to: MailboxId,
    keys?: readonly MessageKey[],
    options?: ExactOption,
  ) => void;
  readonly setLabels: (
    add: readonly MailboxId[],
    remove: readonly MailboxId[],
    keys?: readonly MessageKey[],
    options?: ExactOption,
  ) => void;
  /** Opens the move or label picker for `keys`, or the targets. */
  readonly openPicker: (
    mode: PickerState["mode"],
    keys?: readonly MessageKey[],
    options?: ExactOption,
  ) => void;
  readonly canTrash: boolean;
  readonly canSpam: boolean;
  readonly canDeleteForever: boolean;
  /** Role of the mailbox being shown ("trash" and "junk" change what actions do). */
  readonly view: Mailbox["role"];
  /** Move to Trash; inside Trash: restore. */
  readonly trash: (keys?: readonly MessageKey[], options?: ExactOption) => void;
  /** Report spam; inside Spam: not spam (back to the Inbox). */
  readonly spam: (keys?: readonly MessageKey[], options?: ExactOption) => void;
  /** Asks for confirmation, then deletes permanently (only inside Trash or Spam). */
  readonly requestDeleteForever: (keys?: readonly MessageKey[]) => void;
  /** Asks for confirmation, then empties the Trash or Spam being shown. */
  readonly requestEmpty: () => void;
  /** Runs a confirmed destructive action (called by the confirmation dialog). */
  readonly runConfirmed: (action: MailConfirmAction) => void;
  /** Reverts the action of the current toast. */
  readonly undo: () => void;
}

interface PerformOptions {
  /**
   * Toast text for the done action, given what changed ("3 messages",
   * "1 conversation"); omit for silent actions.
   */
  readonly done?: (what: string) => string;
  /** Prefix of the error toast. */
  readonly failure: string;
  /** Toast when nothing would change; omit to stay quiet. */
  readonly nothing?: string;
  /**
   * Count messages, also in conversation view (they were meant one by
   * one); by default whatever `exact` says.
   */
  readonly messages?: boolean;
}

/** The targets of one account, in list order. */
interface Group {
  readonly accountId: AccountId;
  readonly source: ListSource;
  readonly ids: readonly MessageId[];
}

/** An account's intent, ready to run. */
interface Planned {
  readonly group: Group;
  readonly intent: MailIntent;
  readonly changes: readonly MessageChange[];
}

/**
 * Turns "the current message or selection" into intents: predicts the
 * effect, moves the cursor away from rows that disappear, runs the intent
 * optimistically (one per account) and reports it in an undoable toast.
 */
export function useMailActions(): MailActions {
  const { route, rows, sources, listKey } = useCurrentList();
  const router = useRouter();
  const store = useUiStore();
  const breakpoint = useBreakpoint();
  const handles = useAccounts();
  const queryClient = useQueryClient();
  const t = useT();
  const preview = usePreviewIntent();
  // mutateAsync, not mutate: the promise settles even when the calling
  // component (picker, confirmation, reader) unmounts first, so error toasts
  // are never lost. Rollback lives in the mutation itself either way.
  const { mutateAsync: apply } = useApplyIntent();
  const { mutateAsync: empty } = useEmptyMailbox();

  return useMemo((): MailActions => {
    const orderedKeys = (rows ?? []).map((row) => row.key);
    const a = t.actions;
    const capabilitiesOf = (
      accountId: AccountId,
    ): ProviderCapabilities | undefined =>
      handles.find((handle) => handle.account.id === accountId)?.provider
        .capabilities;
    /** Some account of the list can do it. */
    const anyCan = (can: (capabilities: ProviderCapabilities) => boolean) =>
      [...sources.keys()].some((accountId) => {
        const capabilities = capabilitiesOf(accountId);
        return capabilities !== undefined && can(capabilities);
      });
    const conversationRows = [...sources.values()].some(
      (source) => source.conversations,
    );
    const count = conversationRows ? t.common.conversations : t.common.messages;
    const context = route ? sources.get(route.accountId) : undefined;
    const view = context?.scope?.role;

    /** Targets by account, keeping their order; keys of other accounts are left out. */
    const groupsOf = (keys: readonly MessageKey[]): Group[] => {
      const byAccount = new Map<AccountId, MessageId[]>();
      for (const key of keys) {
        const { accountId, messageId } = messageRef(key);
        if (!sources.has(accountId)) continue;
        byAccount.set(accountId, [
          ...(byAccount.get(accountId) ?? []),
          messageId,
        ]);
      }
      return [...byAccount].flatMap(([accountId, ids]) => {
        const source = sources.get(accountId);
        return source ? [{ accountId, source, ids }] : [];
      });
    };

    /**
     * Rows → messages: a conversation stands for all its messages. In a
     * folder (folder accounts), actions that move mail take only its
     * messages in that folder, like Outlook: sent replies stay in Sent.
     */
    const expand = (
      group: Group,
      ids: readonly MessageId[],
      kind: MailIntent["kind"] = "set-flags",
    ): MessageId[] => {
      const { accountId, source } = group;
      if (!source.conversations) return [...ids];
      const all = threadMessageIds(queryClient, accountId, ids);
      const folder = source.scope;
      // Flags and labels (categories) go on every message of it.
      if (kind === "set-flags" || kind === "set-labels") return all;
      if (folder?.kind !== "folder") return all;
      const inFolder = new Set(
        cachedSummaries(queryClient, accountId, all)
          .filter((message) => message.mailboxIds.includes(folder.id))
          .map((message) => message.id),
      );
      return all.filter((id) => inFolder.has(id));
    };

    // A label created a moment ago may not have reached the list yet.
    const mailboxOf = (accountId: AccountId, id: MailboxId) =>
      findMailbox(sources.get(accountId)?.mailboxes, id) ??
      findMailbox(cachedMailboxes(queryClient, accountId), id);
    const nameOf = (accountId: AccountId, id: MailboxId) => {
      const found = mailboxOf(accountId, id);
      const all =
        sources.get(accountId)?.mailboxes ??
        cachedMailboxes(queryClient, accountId);
      return found ? mailboxName(found, t, usesFolders(all)) : a.theMailbox;
    };

    const targets = (): MessageKey[] => {
      const { selectedIds, focusedId } = store.getState();
      if (selectedIds.size === 0) return focusedId === null ? [] : [focusedId];
      const order = new Map(orderedKeys.map((key, index) => [key, index]));
      const rank = (key: MessageKey) =>
        order.get(key) ?? Number.MAX_SAFE_INTEGER;
      return [...selectedIds].sort((x, y) => rank(x) - rank(y));
    };
    const keysOf = (explicit?: readonly MessageKey[]) =>
      explicit ? [...explicit] : targets();

    const showError = (prefix: string) => (error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error, t)}`,
        tone: "error",
      });
    };

    /**
     * Rows that leave the current list drop out of the selection; if the
     * cursor was on one, it moves to the next row below (or above at the end).
     */
    const stepAway = (planned: readonly Planned[]) => {
      if (!route) return;
      const removed = new Set<MessageKey>();
      for (const { group, changes } of planned) {
        const { scope, isolating } = group.source;
        if (!scope) continue;
        for (const key of rowsLeaving(
          rows ?? [],
          group.accountId,
          scope,
          changes,
          isolating,
        ))
          removed.add(key);
      }
      if (removed.size === 0) return;
      const state = store.getState();
      const { afterRemove } = state.settings;
      const focusLeaves =
        state.focusedId !== null && removed.has(state.focusedId);
      const next = focusLeaves
        ? nextAfterRemoval(
            orderedKeys,
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
          next === null || !open ? list : routeOfRow(list, next, sources),
          { replace: true },
        );
      }
    };

    /**
     * Preview → step away → mutate (per account) → one undo toast.
     * `intentOf` gives an account's intent for its rows (whole
     * conversations in conversation view, unless `exact`); undefined skips
     * that account (it can't do it).
     */
    const perform = (
      keys: readonly MessageKey[],
      intentOf: (group: Group) => MailIntent | undefined,
      options: PerformOptions,
      exact = false,
    ) => {
      const { showToast } = store.getState();
      const wanted = groupsOf(keys).flatMap((group) => {
        const rowIntent = intentOf(group);
        return rowIntent && rowIntent.ids.length > 0
          ? [{ group, rowIntent }]
          : [];
      });
      const planned = wanted.flatMap(({ group, rowIntent }): Planned[] => {
        const intent: MailIntent = exact
          ? rowIntent
          : { ...rowIntent, ids: expand(group, rowIntent.ids, rowIntent.kind) };
        const { changes } = preview({ accountId: group.accountId, intent });
        return changes.length > 0 ? [{ group, intent, changes }] : [];
      });
      if (planned.length === 0) {
        // Quiet when no account can do it at all.
        if (wanted.length > 0 && options.nothing)
          showToast({ message: options.nothing, tone: "info" });
        return;
      }
      stepAway(planned);
      for (const { group, intent, changes } of planned) {
        // Only what changes: folder providers would otherwise also move
        // messages an archive doesn't apply to (those outside the inbox).
        apply({
          accountId: group.accountId,
          intent: { ...intent, ids: changes.map((change) => change.id) },
        }).catch(showError(options.failure));
      }
      if (!options.done) return;
      const steps = planned.flatMap(
        ({ group, intent, changes }): UndoStep[] => {
          const inverse = inverseOf(
            intent,
            changes,
            capabilitiesOf(group.accountId)?.mailboxKinds.includes("folder")
              ? {
                  isFolder: (id) =>
                    mailboxOf(group.accountId, id)?.kind === "folder",
                }
              : {},
          );
          // Permanent deletion has nothing to undo.
          return inverse.length > 0
            ? [
                {
                  accountId: group.accountId,
                  intents: inverse,
                  known: changes.map((change) => change.after),
                },
              ]
            : [];
        },
      );
      // Conversations are counted as such, unless single messages were meant.
      const singles = options.messages ?? exact;
      const touched = planned.reduce(
        (sum, { group, changes }) =>
          sum +
          (group.source.conversations && !singles
            ? new Set(changes.map((change) => threadIdOf(change.before))).size
            : changes.length),
        0,
      );
      showToast({
        message: options.done((singles ? t.common.messages : count)(touched)),
        tone: "info",
        ...(steps.length > 0 ? { undo: steps } : {}),
      });
    };

    /** The one account of `keys` (moving and labels), or a hint if there are several. */
    const oneAccount = (keys: readonly MessageKey[]): Group | undefined => {
      const groups = groupsOf(keys);
      if (groups.length > 1) {
        store.getState().showToast({ message: a.oneAccountOnly, tone: "info" });
        return undefined;
      }
      return groups[0];
    };

    const trashIn = (group: Group) => group.source.scope?.role === "trash";
    const spamIn = (group: Group) => group.source.scope?.role === "junk";

    const toggleStar = (
      explicit?: readonly MessageKey[],
      { exact = false }: { readonly exact?: boolean } = {},
    ) => {
      const groups = groupsOf(keysOf(explicit)).filter((group) =>
        capabilitiesOf(group.accountId)?.settableFlags.includes("flagged"),
      );
      // Like Gmail: a conversation's star is on its newest message.
      const threadsOf = (group: Group) =>
        group.ids.map((id) =>
          cachedSummaries(
            queryClient,
            group.accountId,
            threadMessageIds(queryClient, group.accountId, [id]),
          ).sort((x, y) => x.receivedAt.localeCompare(y.receivedAt)),
        );
      const byConversation = (group: Group) =>
        group.source.conversations && !exact;
      // Star if any of them isn't starred yet; otherwise unstar all.
      const flagged = groups.some((group) =>
        byConversation(group)
          ? threadsOf(group).some(
              (messages) => !messages.some((m) => m.flags.flagged),
            )
          : preview({
              accountId: group.accountId,
              intent: {
                kind: "set-flags",
                ids: exact ? group.ids : expand(group, group.ids),
                flags: { flagged: true },
              },
            }).changes.length > 0,
      );
      perform(
        groups.flatMap((group) =>
          group.ids.map((id) => messageKey(group.accountId, id)),
        ),
        (group) => {
          if (!byConversation(group))
            return {
              kind: "set-flags",
              ids: exact ? group.ids : expand(group, group.ids),
              flags: { flagged },
            };
          const threads = threadsOf(group);
          const ids = flagged
            ? threads
                .filter((messages) => !messages.some((m) => m.flags.flagged))
                .flatMap((messages) => {
                  const newest = messages.at(-1);
                  return newest ? [newest.id] : [];
                })
            : threads.flatMap((messages) =>
                messages.filter((m) => m.flags.flagged).map((m) => m.id),
              );
          return { kind: "set-flags", ids, flags: { flagged } };
        },
        {
          done: (what) => a.starred(what, flagged),
          failure: a.couldntStar(flagged),
          messages: exact,
        },
        // The ids are chosen above (a conversation's newest message).
        true,
      );
    };

    return {
      canArchive: anyCan((c) => c.archive),
      canSetSeen: anyCan((c) => c.settableFlags.includes("seen")),
      canStar: anyCan((c) => c.settableFlags.includes("flagged")),
      canMove: anyCan((c) => c.move),
      canLabel: anyCan((c) => c.labels),
      labelsAreCategories: [...sources.keys()].every(
        (accountId) =>
          capabilitiesOf(accountId)?.mailboxKinds.includes("folder") === true,
      ),
      targets,

      archive: (explicit, { exact = false } = {}) => {
        perform(
          keysOf(explicit),
          (group) =>
            capabilitiesOf(group.accountId)?.archive
              ? { kind: "archive", ids: group.ids }
              : undefined,
          {
            done: (what) => a.archived(what),
            failure: a.couldntArchive,
            nothing: a.notInInbox,
          },
          exact,
        );
      },

      setSeen: (
        seen,
        { keys: explicit, silent = false, exact = false } = {},
      ) => {
        perform(
          keysOf(explicit),
          (group) =>
            capabilitiesOf(group.accountId)?.settableFlags.includes("seen")
              ? { kind: "set-flags", ids: group.ids, flags: { seen } }
              : undefined,
          {
            ...(silent ? {} : { done: (what: string) => a.marked(what, seen) }),
            failure: a.couldntMark(seen),
          },
          exact,
        );
      },

      toggleStar,

      moveTo: (to, explicit, { exact = false } = {}) => {
        const keys = keysOf(explicit);
        const group = oneAccount(keys);
        if (!group) return;
        const { accountId } = group;
        const capabilities = capabilitiesOf(accountId);
        const role = mailboxOf(accountId, to)?.role;
        // Trash and Spam have their own semantics (and Gmail its own calls).
        if (role === "trash" && capabilities?.trash) {
          perform(
            keys,
            ({ ids }) => ({ kind: "trash", ids }),
            { done: (what) => a.movedToTrash(what), failure: a.couldntTrash },
            exact,
          );
          return;
        }
        if (role === "junk" && capabilities?.spam) {
          perform(
            keys,
            ({ ids }) => ({ kind: "report-spam", ids }),
            {
              done: (what) => a.reportedSpam(what),
              failure: a.couldntReportSpam,
            },
            exact,
          );
          return;
        }
        if (!capabilities?.move || !route) return;
        const name = nameOf(accountId, to);
        const from =
          group.source.scope?.id ??
          (accountId === route.accountId ? route.mailboxId : undefined);
        if (from === undefined) return;
        perform(
          keys,
          ({ ids }) => ({ kind: "move", ids, from, to }),
          {
            done: (what) => a.moved(what, name),
            failure: a.couldntMove,
            nothing: a.alreadyIn(name),
          },
          exact,
        );
      },

      setLabels: (add, remove, explicit, { exact = false } = {}) => {
        const keys = keysOf(explicit);
        const group = oneAccount(keys);
        if (!group || !capabilitiesOf(group.accountId)?.labels) return;
        const { accountId } = group;
        const [onlyAdded] = add;
        const [onlyRemoved] = remove;
        // Outlook's labels are its categories.
        const categories =
          capabilitiesOf(accountId)?.mailboxKinds.includes("folder") === true;
        perform(
          keys,
          ({ ids }) => ({ kind: "set-labels", ids, add, remove }),
          {
            done: (what) => {
              if (add.length === 1 && remove.length === 0 && onlyAdded) {
                const name = nameOf(accountId, onlyAdded);
                return categories
                  ? a.categoryAdded(name, what)
                  : a.labelAdded(name, what);
              }
              if (remove.length === 1 && add.length === 0 && onlyRemoved) {
                const name = nameOf(accountId, onlyRemoved);
                return categories
                  ? a.categoryRemoved(name, what)
                  : a.labelRemoved(name, what);
              }
              return categories
                ? a.categoriesChanged(what)
                : a.labelsChanged(what);
            },
            failure: categories
              ? a.couldntChangeCategories
              : a.couldntChangeLabels,
          },
          exact,
        );
      },

      openPicker: (mode, explicit, { exact = false } = {}) => {
        const keys = keysOf(explicit);
        if (keys.length === 0) return;
        const group = oneAccount(keys);
        if (!group) return;
        store.getState().setPicker({
          mode,
          accountId: group.accountId,
          ids: group.ids,
          conversations: group.source.conversations && !exact,
          ...(exact ? { exact: true } : {}),
        });
      },

      canTrash: anyCan((c) => c.trash),
      canSpam: anyCan((c) => c.spam),
      canDeleteForever: anyCan((c) => c.deleteForever),
      view,

      trash: (explicit, { exact = false } = {}) => {
        const keys = keysOf(explicit);
        const groups = groupsOf(keys);
        const restoring = groups.length > 0 && groups.every(trashIn);
        perform(
          keys,
          (group) =>
            capabilitiesOf(group.accountId)?.trash
              ? { kind: trashIn(group) ? "untrash" : "trash", ids: group.ids }
              : undefined,
          restoring
            ? { done: (what) => a.restored(what), failure: a.couldntRestore }
            : {
                done: (what) => a.movedToTrash(what),
                failure: a.couldntTrash,
              },
          exact,
        );
      },

      spam: (explicit, { exact = false } = {}) => {
        const keys = keysOf(explicit);
        const groups = groupsOf(keys);
        const unspamming = groups.length > 0 && groups.every(spamIn);
        perform(
          keys,
          (group) =>
            capabilitiesOf(group.accountId)?.spam
              ? {
                  kind: spamIn(group) ? "not-spam" : "report-spam",
                  ids: group.ids,
                }
              : undefined,
          unspamming
            ? {
                done: (what) => a.notSpamMoved(what),
                failure: a.couldntNotSpam,
              }
            : {
                done: (what) => a.reportedSpam(what),
                failure: a.couldntReportSpam,
              },
          exact,
        );
      },

      requestDeleteForever: (explicit) => {
        const keys = keysOf(explicit);
        if (keys.length === 0) return;
        const group = oneAccount(keys);
        if (!group || !capabilitiesOf(group.accountId)?.deleteForever) return;
        if (!trashIn(group) && !spamIn(group)) return;
        store.getState().setConfirm({
          title: a.deleteForeverTitle(count(group.ids.length)),
          message: a.cantBeUndone,
          confirmLabel: a.deleteForever,
          action: {
            kind: "delete-forever",
            accountId: group.accountId,
            ids: group.ids,
          },
        });
      },

      requestEmpty: () => {
        // Emptying deletes everything, so not from a search's results.
        const mailbox = context?.scope;
        if (!route || route.unified || route.search || !mailbox) return;
        if (!capabilitiesOf(route.accountId)?.deleteForever) return;
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
          if (!sources.has(action.accountId)) return;
          perform(
            action.ids.map((id) => messageKey(action.accountId, id)),
            ({ ids }) => ({ kind: "delete-forever", ids }),
            {
              done: (what) => a.deletedForever(what),
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
        let restoredHere: MessageKey | undefined;
        for (const { accountId, intents, known } of toast.undo) {
          const source = sources.get(accountId);
          for (const intent of intents) {
            if (source?.scope && restoredHere === undefined) {
              const { scope, isolating } = source;
              const { changes } = preview({ accountId, intent, known });
              const back = changes.find(
                (change) =>
                  belongsTo(scope, change.after, isolating) &&
                  !belongsTo(scope, change.before, isolating),
              );
              if (back) restoredHere = messageKey(accountId, back.id);
            }
            apply({ accountId, intent, known }).catch(showError(a.couldntUndo));
          }
        }
        // Undo brings the cursor back to a message that returns to this list.
        if (restoredHere !== undefined)
          store.getState().focusOnly(restoredHere);
      },
    };
  }, [
    breakpoint,
    apply,
    empty,
    handles,
    listKey,
    preview,
    queryClient,
    route,
    router,
    rows,
    sources,
    store,
    t,
  ]);
}
