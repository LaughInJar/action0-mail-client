import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { DateRange } from "../core/calendar";
import {
  dueReminders,
  type DueReminder,
  type ReminderMark,
} from "../core/reminders";
import { useUiStore } from "../state/context";
import { useCalendarData, type PlacedEvent } from "./calendar";
import { queryKeys } from "./keys";

/** Due reminders, with their events. */
export type DueEventReminder = DueReminder<PlacedEvent>;

/**
 * What reminders are worked out from: the events of the ticked calendars
 * in `range`, and, for providers that keep reminders themselves (Outlook),
 * their lists (due times by event id, by source).
 */
export function useReminderSources(range: DateRange) {
  const { statuses, events } = useCalendarData(range);
  const synced = statuses.filter(
    (status) =>
      status.source.provider.reminderSync !== undefined &&
      status.signedIn &&
      status.access === "granted",
  );
  const lists = useQueries({
    queries: synced.map(({ source }) => ({
      queryKey: queryKeys.reminders(source.key, range),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        source.provider.reminderSync
          ? source.provider.reminderSync.list(range, signal)
          : Promise.resolve([]),
      staleTime: 60_000,
      refetchInterval: 5 * 60_000,
    })),
  });
  const bySource = new Map<string, Map<string, number>>(
    synced.map(({ source }, index) => [
      source.key,
      new Map(
        (lists[index]?.data ?? []).map(({ eventId, fireAt }) => [
          eventId as string,
          Date.parse(fireAt),
        ]),
      ),
    ]),
  );
  return { events, synced: bySource };
}

/** The reminders due at `now` (see `dueReminders`). */
export function useDueReminders(
  range: DateRange,
  marks: Readonly<Record<string, ReminderMark>>,
  now: number,
): readonly DueEventReminder[] {
  const { events, synced } = useReminderSources(range);
  return dueReminders(
    events,
    (placed) => placed.source.key,
    synced,
    marks,
    now,
  );
}

/**
 * Dismisses and snoozes reminders: at once on this device, and at the
 * provider too where it keeps reminders (Outlook, on every device). A
 * provider's refusal takes the mark back and rejects.
 */
export function useReminderActions() {
  const store = useUiStore();
  const queryClient = useQueryClient();
  return useMemo(() => {
    const apply = async (
      due: DueEventReminder,
      mark: ReminderMark,
      remote: (() => Promise<void>) | undefined,
    ) => {
      const { markReminder, reminderMarks } = store.getState();
      const before = reminderMarks[due.key] ?? null;
      markReminder(due.key, mark);
      if (!remote) return;
      try {
        await remote();
      } catch (error) {
        store.getState().markReminder(due.key, before);
        throw error;
      } finally {
        void queryClient.invalidateQueries({
          queryKey: [
            ...queryKeys.calendarSource(due.item.source.key),
            "reminders",
          ],
        });
      }
    };
    const ends = (due: DueEventReminder) => {
      const { end } = due.item.event;
      return "date" in end
        ? new Date(`${end.date}T00:00:00`).getTime()
        : Date.parse(end.dateTime);
    };
    return {
      dismiss: (due: DueEventReminder) => {
        const sync = due.item.source.provider.reminderSync;
        return apply(
          due,
          { dismissed: true, ends: ends(due) },
          sync && (() => sync.dismiss(due.item.event.id)),
        );
      },
      snooze: (due: DueEventReminder, until: number) => {
        const sync = due.item.source.provider.reminderSync;
        return apply(
          due,
          { snoozedUntil: until, ends: ends(due) },
          sync &&
            (() =>
              sync.snooze(due.item.event.id, new Date(until).toISOString())),
        );
      },
    };
  }, [store, queryClient]);
}
