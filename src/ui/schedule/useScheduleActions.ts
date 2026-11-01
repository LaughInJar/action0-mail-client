import { useMemo } from "react";
import type { ScheduledEntry } from "../../core/schedule";
import { useDraftSync } from "../../data/drafts";
import { useT } from "../../i18n/context";
import { deviceIdOf } from "../../state/device";
import { useUiStore } from "../../state/context";
import type { ToolbarItem } from "../actions/mailActionItems";
import { errorMessage } from "../common/errorMessage";
import { formatSendAt } from "../common/format";
import { useComposeActions } from "../composer/useComposeActions";
import type { I18n } from "../../i18n/context";

/** What can be done with a scheduled mail. */
export interface ScheduleActions {
  /** Sends it now (after the undo-send wait). */
  readonly sendNow: (entry: ScheduledEntry) => void;
  /** Opens it in the composer, still scheduled. */
  readonly edit: (entry: ScheduledEntry) => void;
  /** Schedules it for another time (undoable). */
  readonly reschedule: (entry: ScheduledEntry, sendAt: Date) => void;
  /** Picks another time in a dialog (from menus without a place for the times). */
  readonly pickTime: (entry: ScheduledEntry) => void;
  /** Takes it back into Drafts (undoable). */
  readonly cancel: (entry: ScheduledEntry) => void;
}

/** {@link ScheduleActions} with toasts and Undo. */
export function useScheduleActions(): ScheduleActions {
  const compose = useComposeActions();
  const sync = useDraftSync();
  const store = useUiStore();
  const t = useT();
  return useMemo((): ScheduleActions => {
    const s = t.schedule;
    const fail = (prefix: string) => (error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error, t)}`,
        tone: "error",
      });
    };
    const when = (date: Date) =>
      formatSendAt(date.toISOString(), { locale: t.locale });
    const ref = (entry: ScheduledEntry) => ({
      accountId: entry.accountId,
      messageId: entry.message.id,
    });
    const reschedule = (entry: ScheduledEntry, sendAt: Date) => {
      const before = new Date(entry.message.sendAt);
      const by = deviceIdOf(store);
      sync
        .reschedule(entry.accountId, entry.message.id, { sendAt, by })
        .then((messageId) => {
          store.getState().showToast({
            message: s.rescheduled(when(sendAt)),
            tone: "info",
            revert: () => {
              sync
                .reschedule(entry.accountId, messageId, {
                  sendAt: before,
                  by,
                })
                .catch(fail(s.couldntSchedule));
            },
          });
        }, fail(s.couldntSchedule));
    };
    return {
      sendNow: (entry) => {
        compose.sendScheduledNow(ref(entry), entry.message.sendAt);
      },
      edit: (entry) => {
        compose.editScheduled(ref(entry), entry.message.sendAt);
      },
      reschedule,
      pickTime: (entry) => {
        store.getState().setSendLaterFor(entry);
      },
      cancel: (entry) => {
        const sendAt = new Date(entry.message.sendAt);
        sync.unschedule(entry.accountId, entry.message.id).then(({ id }) => {
          store.getState().showToast({
            message: s.unscheduled,
            tone: "info",
            revert: () => {
              sync
                .scheduleSaved(entry.accountId, id, {
                  sendAt,
                  by: deviceIdOf(store),
                })
                .catch(fail(s.couldntSchedule));
            },
          });
        }, fail(s.couldntUnschedule));
      },
    };
  }, [compose, store, sync, t]);
}

/** A scheduled mail's actions as toolbar (and context menu) items. */
export function scheduleItems(
  actions: ScheduleActions,
  entry: ScheduledEntry,
  t: I18n,
): ToolbarItem[] {
  const s = t.schedule;
  return [
    {
      id: "schedule-send-now",
      label: s.sendNow,
      icon: "send",
      group: "mail",
      run: () => {
        actions.sendNow(entry);
      },
    },
    {
      id: "schedule-change",
      label: s.changeTime,
      icon: "clock",
      group: "mail",
      run: () => {
        actions.pickTime(entry);
      },
    },
    {
      id: "schedule-edit",
      label: s.edit,
      icon: "pencil",
      group: "mail",
      run: () => {
        actions.edit(entry);
      },
    },
    {
      id: "schedule-cancel",
      label: s.cancelSend,
      icon: "x",
      group: "mail",
      run: () => {
        actions.cancel(entry);
      },
    },
  ];
}
