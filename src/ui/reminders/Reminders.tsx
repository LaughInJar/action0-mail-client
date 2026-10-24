import { useEffect, useRef, useState } from "react";
import { isAllDay, timeOf } from "../../core/calendar";
import { minutesUntil, upcomingRange } from "../../core/reminders";
import type { PlacedEvent } from "../../data/calendar";
import {
  useDueReminders,
  useReminderActions,
  type DueEventReminder,
} from "../../data/reminders";
import { useT, type I18n } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useRouter, useUi, useUiStore } from "../../state/context";
import { dayKey } from "../calendar/dates";
import { eventColor, eventKey, titleOf, whenText } from "../calendar/format";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";

/** How often due reminders are looked at (ms). */
const TICK_MS = 15_000;

/** Snooze choices, in minutes from now. */
const SNOOZES = [5, 10, 60] as const;

/** "In 10 minutes", "Started 5 minutes ago", or the date for later ones. */
function whenOf(placed: PlacedEvent, now: number, t: I18n): string {
  const { event } = placed;
  const r = t.calendar.reminders;
  const minutes = minutesUntil(timeOf(event.start), now);
  if (isAllDay(event) || minutes > 120) return whenText(event, t);
  return minutes >= 0 ? r.inMinutes(minutes) : r.startedAgo(-minutes);
}

/** A due reminder for each event (the latest one, with all keys due for it). */
interface EventReminders {
  readonly placed: PlacedEvent;
  readonly reminders: readonly DueEventReminder[];
}

function byEvent(due: readonly DueEventReminder[]): EventReminders[] {
  const groups = new Map<string, EventReminders>();
  for (const reminder of due) {
    const key = eventKey(reminder.item);
    const group = groups.get(key);
    groups.set(key, {
      placed: reminder.item,
      reminders: [...(group?.reminders ?? []), reminder],
    });
  }
  return [...groups.values()];
}

/**
 * Event reminders (when they're on in Settings): a panel at the bottom
 * left with what's due, and a system notification when one comes due
 * while the app isn't in front.
 */
export function Reminders() {
  const enabled = useUi((state) => state.settings.eventReminders);
  return enabled ? <ActiveReminders /> : null;
}

function ActiveReminders() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const marks = useUi((state) => state.reminderMarks);
  const due = useDueReminders(upcomingRange(now), marks, now);
  const t = useT();
  const r = t.calendar.reminders;
  const store = useUiStore();
  const router = useRouter();
  const platform = usePlatform();
  const actions = useReminderActions();

  const open = (placed: PlacedEvent) => {
    router.openCalendar({
      view: "day",
      date: dayKey(new Date(timeOf(placed.event.start))),
      event: eventKey(placed),
    });
  };

  // A notification for each reminder that comes due while the app runs
  // (not for ones missed while it was closed); a snooze notifies again.
  const [started] = useState(Date.now);
  const notified = useRef(new Set<string>());
  useEffect(() => {
    const inFront = !document.hidden && document.hasFocus();
    for (const reminder of due) {
      const id = `${reminder.key}@${String(reminder.fireAt)}`;
      if (notified.current.has(id)) continue;
      notified.current.add(id);
      if (reminder.fireAt < started - 60_000 || inFront) continue;
      if (!platform.notifications.allowed()) continue;
      const placed = reminder.item;
      platform.notifications.show({
        title: titleOf(placed.event, t),
        body: r.notifyBody(
          whenOf(placed, Date.now(), t),
          placed.event.location,
        ),
        tag: `a0-reminder-${reminder.key}`,
        onClick: () => {
          open(placed);
        },
      });
    }
    // Only when what's due changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due]);

  const failed = (error: unknown) => {
    store.getState().showToast({
      message: `${r.couldntUpdate}: ${errorMessage(error, t)}`,
      tone: "error",
    });
  };
  const dismiss = (group: EventReminders) => {
    for (const reminder of group.reminders)
      actions.dismiss(reminder).catch(failed);
  };
  const snooze = (group: EventReminders, until: number) => {
    for (const reminder of group.reminders)
      actions.snooze(reminder, until).catch(failed);
  };

  const groups = byEvent(due);
  if (groups.length === 0) return null;
  return (
    <section
      aria-label={r.panel}
      // Phones: full width, above the new mail / new event button.
      className="fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-3 z-40 flex max-h-[50dvh] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl max-sm:right-3 max-sm:bottom-[calc(5.75rem+env(safe-area-inset-bottom))] max-sm:w-auto dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <Icon name="bell" className="size-4 text-zinc-500" />
        <h2 className="flex-1 text-sm font-semibold">{r.panel}</h2>
        {groups.length > 1 && (
          <button
            type="button"
            onClick={() => {
              for (const group of groups) dismiss(group);
            }}
            className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            {r.dismissAll}
          </button>
        )}
      </div>
      <ul aria-live="polite" className="min-h-0 overflow-y-auto">
        {groups.map((group) => (
          <ReminderItem
            key={eventKey(group.placed)}
            group={group}
            now={now}
            onOpen={() => {
              open(group.placed);
            }}
            onDismiss={() => {
              dismiss(group);
            }}
            onSnooze={(until) => {
              snooze(group, until);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function ReminderItem({
  group,
  now,
  onOpen,
  onDismiss,
  onSnooze,
}: {
  group: EventReminders;
  now: number;
  onOpen: () => void;
  onDismiss: () => void;
  onSnooze: (until: number) => void;
}) {
  const t = useT();
  const r = t.calendar.reminders;
  const { openExternal } = usePlatform();
  const [snoozing, setSnoozing] = useState(false);
  const { event } = group.placed;
  const title = titleOf(event, t);
  const start = timeOf(event.start);
  const meeting =
    event.meetingUrl && /^https:\/\//i.test(event.meetingUrl)
      ? event.meetingUrl
      : undefined;
  const small =
    "rounded-md px-2 py-1 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";

  return (
    <li
      aria-label={title}
      className="border-b border-zinc-100 px-3 py-2 last:border-b-0 dark:border-zinc-800"
      style={eventColor(group.placed)}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-1.5 size-2.5 shrink-0 rounded-full bg-[var(--event-color)]"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-zinc-500">
            {r.notifyBody(whenOf(group.placed, now, t), event.location)}
          </p>
        </div>
        <IconButton
          label={`${r.dismiss}: ${title}`}
          icon="x"
          onClick={onDismiss}
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-4.5">
        {meeting && (
          <button
            type="button"
            onClick={() => {
              openExternal(meeting);
            }}
            className="flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
          >
            <Icon name="video" className="size-3.5" />
            {r.join}
          </button>
        )}
        <button type="button" onClick={onOpen} className={small}>
          {r.open}
        </button>
        <button
          type="button"
          aria-expanded={snoozing}
          onClick={() => {
            setSnoozing(!snoozing);
          }}
          className={small}
        >
          {r.snooze}
        </button>
      </div>
      {snoozing && (
        <div
          role="group"
          aria-label={r.snooze}
          className="mt-1 flex flex-wrap gap-1 pl-4.5"
        >
          {SNOOZES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              aria-label={r.snoozeFor(r.snoozeChoices[minutes])}
              onClick={() => {
                onSnooze(Date.now() + minutes * 60_000);
              }}
              className={`${small} border border-zinc-200 dark:border-zinc-700`}
            >
              {r.snoozeChoices[minutes]}
            </button>
          ))}
          {start - now > 60_000 && (
            <button
              type="button"
              onClick={() => {
                onSnooze(start);
              }}
              className={`${small} border border-zinc-200 dark:border-zinc-700`}
            >
              {r.untilStart}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
