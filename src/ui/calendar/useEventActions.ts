import { useMemo } from "react";
import type {
  EventChanges,
  EventDraft,
  SeriesScope,
} from "../../core/calendar";
import type { CalendarSource, PlacedEvent } from "../../data/calendar";
import {
  hasGuests,
  useEventWrites,
  type EventEdit,
} from "../../data/eventEdits";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { useAsk } from "../common/useAsk";
import { titleOf } from "./format";

/** Creating, changing and deleting events, with the questions they need. */
export interface EventActions {
  /** Creates an event; false if a question was cancelled. */
  readonly create: (
    source: CalendarSource,
    draft: EventDraft,
  ) => Promise<boolean>;
  /**
   * Changes an event (asking which occurrences, and whether guests hear
   * about it); false if a question was cancelled.
   */
  readonly update: (
    placed: PlacedEvent,
    changes: EventChanges,
    options?: {
      /** It's the first of its series ("this and following" is everything). */
      readonly firstOccurrence?: boolean;
      /** The toast says "Moved" (dragging) rather than "Saved". */
      readonly moved?: boolean;
    },
  ) => Promise<boolean>;
  /** Deletes an event (asking as {@link update} does); false if cancelled. */
  readonly remove: (
    placed: PlacedEvent,
    options?: { readonly firstOccurrence?: boolean },
  ) => Promise<boolean>;
}

/**
 * Runs event changes the way every change in action0 runs: questions
 * first (which occurrences; Google: tell the guests?), then at once in the
 * calendar with a toast whose Undo (and `z`) takes it back, asking about
 * the guests again. Deleting a meeting from a calendar that always tells
 * the guests (Microsoft) asks first and can't be undone.
 */
export function useEventActions(): EventActions {
  const writes = useEventWrites();
  const ask = useAsk();
  const store = useUiStore();
  const t = useT();

  return useMemo((): EventActions => {
    const c = t.calendar;
    const showError = (prefix: string, error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error, t)}`,
        tone: "error",
      });
    };

    const askScope = async (
      kind: "change" | "delete",
      firstOccurrence: boolean,
      repeatChanged: boolean,
    ): Promise<SeriesScope | null> => {
      const options = [
        ...(repeatChanged ? [] : [{ value: "this", label: c.scopeThis }]),
        ...(firstOccurrence
          ? []
          : [
              {
                value: "following",
                label: c.scopeFollowing,
                ...(kind === "change"
                  ? { description: c.scopeFollowingHint }
                  : {}),
              },
            ]),
        { value: "all", label: c.scopeAll },
      ];
      if (options.length === 1) return "all";
      const answer = await ask({ title: c.scopeTitle(kind), options });
      return answer === "this" || answer === "following" || answer === "all"
        ? answer
        : null;
    };

    /** Whether guests hear about it: `null` if the question was cancelled. */
    const askNotify = async (
      source: CalendarSource,
      guests: boolean,
      kind: "create" | "change" | "delete",
    ): Promise<boolean | null> => {
      if (!guests) return false;
      if (source.provider.guestNotices === "always") return true;
      const answer = await ask({
        title: c.notifyTitle(kind),
        message: c.notifyMessage,
        options: [
          { value: "send", label: c.send, tone: "primary" },
          { value: "none", label: c.dontSend },
        ],
      });
      return answer === null ? null : answer === "send";
    };

    /**
     * The toast's Undo: waits for the change, asks about the guests again
     * (`kind`: what undoing means for them), takes it back.
     */
    const undoOf =
      (
        pending: Promise<EventEdit>,
        source: CalendarSource,
        guests: boolean,
        kind: "create" | "change" | "delete",
      ) =>
      () => {
        void (async () => {
          let edit: EventEdit;
          try {
            edit = await pending;
          } catch {
            return; // It failed and was rolled back already.
          }
          const notify = await askNotify(source, guests, kind);
          if (notify === null) return;
          try {
            await edit.undo({ notify });
          } catch (error) {
            showError(t.actions.couldntUndo, error);
          }
        })();
      };

    return {
      create: async (source, draft) => {
        const guests = draft.guests.length > 0;
        const notify = await askNotify(source, guests, "create");
        if (notify === null) return false;
        const pending = writes.create(source, draft, { notify });
        pending.catch((error: unknown) => {
          showError(c.couldntSave, error);
        });
        store.getState().showToast({
          message: c.created(draft.title || c.noTitle),
          tone: "info",
          revert: undoOf(pending, source, guests, "delete"),
        });
        return true;
      },

      update: async (placed, changes, options = {}) => {
        const { source, event } = placed;
        const scope = event.recurring
          ? await askScope(
              "change",
              options.firstOccurrence ?? false,
              changes.repeat !== undefined,
            )
          : "all";
        if (scope === null) return false;
        const guests = hasGuests(event) || (changes.guests?.length ?? 0) > 0;
        const notify = await askNotify(source, guests, "change");
        if (notify === null) return false;
        const pending = writes.update(placed, changes, scope, { notify });
        pending.catch((error: unknown) => {
          showError(c.couldntSave, error);
        });
        const title = titleOf(
          { ...event, title: changes.title ?? event.title },
          t,
        );
        store.getState().showToast({
          message: options.moved ? c.moved(title) : c.saved(title),
          tone: "info",
          revert: undoOf(pending, source, guests, "change"),
        });
        return true;
      },

      remove: async (placed, options = {}) => {
        const { source, event } = placed;
        const title = titleOf(event, t);
        const scope = event.recurring
          ? await askScope("delete", options.firstOccurrence ?? false, false)
          : "all";
        if (scope === null) return false;
        const guests = hasGuests(event);
        // Microsoft tells the guests whatever happens: that can't be undone.
        const final = guests && source.provider.guestNotices === "always";
        if (final) {
          const answer = await ask({
            title: c.deleteMeetingTitle(title),
            message: c.deleteMeetingMessage,
            options: [
              { value: "delete", label: t.common.delete, tone: "danger" },
            ],
          });
          if (answer === null) return false;
        }
        const notify = final ? true : await askNotify(source, guests, "delete");
        if (notify === null) return false;
        const pending = writes.remove(placed, scope, { notify });
        pending.catch((error: unknown) => {
          showError(c.couldntDelete, error);
        });
        store.getState().showToast({
          message: c.deleted(title),
          tone: "info",
          ...(final
            ? {}
            : { revert: undoOf(pending, source, guests, "create") }),
        });
        return true;
      },
    };
  }, [writes, ask, store, t]);
}
