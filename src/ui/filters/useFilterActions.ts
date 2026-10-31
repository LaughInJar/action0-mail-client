import { useMemo } from "react";
import type { AutoReply, FilterSpec, MailFilter } from "../../core/filters";
import type { AccountId } from "../../core/ids";
import {
  useApplyFilterToMatches,
  type FilterMatches,
} from "../../data/filterMatches";
import { useFilterChanges, type FilterTarget } from "../../data/filters";
import { useApplyIntent } from "../../data/mutations";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { useAsk } from "../common/useAsk";

/** What Settings → Filters and the notice do, each with an undo toast. */
export interface FilterActions {
  /**
   * Saves a filter, then (with `matches`) applies it to that mail. Resolves
   * once saved; rejects with the reason when the server refuses.
   */
  readonly save: (
    accountId: AccountId,
    target: FilterTarget,
    spec: FilterSpec,
    matches?: FilterMatches,
  ) => Promise<void>;
  /** Deletes a filter (asks first if it can't be brought back as it was). */
  readonly remove: (
    accountId: AccountId,
    filters: readonly MailFilter[],
    filter: MailFilter,
  ) => Promise<void>;
  readonly setEnabled: (
    accountId: AccountId,
    filter: MailFilter,
    enabled: boolean,
  ) => void;
  /** Moves a filter to `to` (an index into the filters). */
  readonly move: (
    accountId: AccountId,
    filters: readonly MailFilter[],
    from: number,
    to: number,
  ) => void;
  /** Saves the automatic reply; resolves once saved. */
  readonly setAutoReply: (
    accountId: AccountId,
    reply: AutoReply,
    before: AutoReply,
  ) => Promise<void>;
}

/** The spec a filter was made from, to put it back. */
function specOf(filter: MailFilter): FilterSpec {
  return {
    ...(filter.name === undefined ? {} : { name: filter.name }),
    enabled: filter.enabled,
    conditions: filter.conditions,
    actions: filter.actions,
  };
}

/** See {@link FilterActions}. */
export function useFilterActions(): FilterActions {
  const changes = useFilterChanges();
  const applyToMatches = useApplyFilterToMatches();
  const { mutateAsync: applyIntent } = useApplyIntent();
  const store = useUiStore();
  const ask = useAsk();
  const t = useT();
  return useMemo<FilterActions>(() => {
    const f = t.filters;
    const failed = (prefix: string) => (error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error, t)}`,
        tone: "error",
      });
    };
    const info = (message: string, revert: () => void) => {
      store.getState().showToast({ message, tone: "info", revert });
    };

    return {
      save: async (accountId, target, spec, matches) => {
        const saved = await changes.save(accountId, target, spec);
        const undoSave = () => {
          if (target.kind === "new")
            void changes
              .remove(accountId, saved.id)
              .catch(failed(t.actions.couldntUndo));
          else
            void changes
              .save(
                accountId,
                { kind: "edit", filter: saved },
                specOf(target.filter),
              )
              .catch(failed(t.actions.couldntUndo));
        };
        if (!matches) {
          info(target.kind === "new" ? f.created : f.saved, undoSave);
          return;
        }
        try {
          const applied = await applyToMatches(
            accountId,
            spec.actions,
            matches,
          );
          const count = t.common.messages(applied.changed);
          info(
            (target.kind === "new" ? f.createdApplied : f.savedApplied)(count),
            () => {
              undoSave();
              void (async () => {
                for (const intent of applied.undo)
                  await applyIntent({
                    accountId,
                    intent,
                    known: applied.known,
                  });
              })().catch(failed(t.actions.couldntUndo));
            },
          );
        } catch (error) {
          failed(f.couldntApply)(error);
        }
      },

      remove: async (accountId, filters, filter) => {
        // What action0 doesn't show couldn't be put back: ask instead.
        if (filter.more || filter.custom !== undefined) {
          const answer = await ask({
            title: f.deleteTitle,
            message: f.deleteMessage,
            options: [{ value: "delete", label: f.delete, tone: "danger" }],
          });
          if (answer === null) return;
          await changes
            .remove(accountId, filter.id)
            .catch(failed(f.couldntDelete));
          return;
        }
        const position = filters.indexOf(filter);
        try {
          await changes.remove(accountId, filter.id);
        } catch (error) {
          failed(f.couldntDelete)(error);
          return;
        }
        info(f.deleted, () => {
          void changes
            .save(accountId, { kind: "new", position }, specOf(filter))
            .catch(failed(t.actions.couldntUndo));
        });
      },

      setEnabled: (accountId, filter, enabled) => {
        changes.setEnabled(accountId, filter.id, enabled).then(() => {
          info(enabled ? f.switchedOn : f.switchedOff, () => {
            void changes
              .setEnabled(accountId, filter.id, !enabled)
              .catch(failed(t.actions.couldntUndo));
          });
        }, failed(f.couldntChange));
      },

      move: (accountId, filters, from, to) => {
        if (from === to || to < 0 || to >= filters.length) return;
        const before = filters.map((filter) => filter.id);
        const after = [...before];
        const [moved] = after.splice(from, 1);
        if (moved === undefined) return;
        after.splice(to, 0, moved);
        changes.reorder(accountId, after).then(() => {
          info(f.moved, () => {
            void changes
              .reorder(accountId, before)
              .catch(failed(t.actions.couldntUndo));
          });
        }, failed(f.couldntChange));
      },

      setAutoReply: async (accountId, reply, before) => {
        await changes.setAutoReply(accountId, reply);
        const message =
          reply.enabled === before.enabled
            ? f.autoReplySavedToast
            : reply.enabled
              ? f.autoReplyOnToast
              : f.autoReplyOffToast;
        info(message, () => {
          void changes
            .setAutoReply(accountId, before)
            .catch(failed(t.actions.couldntUndo));
        });
      },
    };
  }, [applyIntent, applyToMatches, ask, changes, store, t]);
}
