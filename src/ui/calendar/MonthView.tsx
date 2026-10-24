import { useRef } from "react";
import type { PlacedEvent } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { addDays, dayKey, onDay, sameDay } from "./dates";
import { EventChip } from "./EventChip";
import { dayOrder, eventKey, findEvent } from "./format";
import { movedByDays, type EventTimes } from "./moves";
import { useOpenEventMenu } from "./useEventMenu";
import { useGridGestures } from "./useGridGestures";
import { useNow } from "./useNow";
import type { Ghost } from "./WeekView";

/** Events listed per day at most before "+N more". */
const PER_DAY = 3;

/**
 * Six weeks, each day with its first few events; a day's number opens the
 * day view, its empty space starts an all-day event (dragging across days
 * makes it longer), and events can be dragged to other days.
 */
export function MonthView({
  first,
  month,
  events,
  onOpen,
  onOpenDay,
  canDrag,
  onNewEvent,
  onChangeTimes,
  ghost,
}: {
  first: Date;
  /** The month shown (days of other months are dimmed). */
  month: number;
  events: readonly PlacedEvent[];
  onOpen: (placed: PlacedEvent) => void;
  onOpenDay: (day: Date) => void;
  canDrag: (placed: PlacedEvent) => boolean;
  /** A new all-day event was asked for: "YYYY-MM-DD" days, `to` exclusive. */
  onNewEvent: (from: string, to: string) => void;
  onChangeTimes: (placed: PlacedEvent, times: EventTimes) => void;
  /** The new event being edited. */
  ghost?: Ghost | null;
}) {
  const t = useT();
  const now = useNow();
  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const weekday = new Intl.DateTimeFormat(t.locale, { weekday: "short" });
  const dayNumber = new Intl.DateTimeFormat(t.locale, { day: "numeric" });
  const label = new Intl.DateTimeFormat(t.locale, { dateStyle: "full" });

  const onMenu = useOpenEventMenu();
  const { gesture, onPointerDown } = useGridGestures({
    eventOf: (key) => findEvent(events, key),
    canDrag,
    onMenu,
    slotAt: (x, y) => {
      const index = cellRefs.current.findIndex((cell) => {
        const rect = cell?.getBoundingClientRect();
        return (
          rect !== undefined &&
          x >= rect.left &&
          x < rect.right &&
          y >= rect.top &&
          y < rect.bottom
        );
      });
      return index === -1 ? null : { day: index, minutes: 0 };
    },
    onCreate: (from, to) => {
      const low = Math.min(from.day, to?.day ?? from.day);
      const high = Math.max(from.day, to?.day ?? from.day);
      onNewEvent(dayKey(addDays(first, low)), dayKey(addDays(first, high + 1)));
    },
    onMove: (placed, grab, at) => {
      const times = movedByDays(placed.event, at.day - grab.day);
      if (times) onChangeTimes(placed, times);
    },
  });

  // Days to highlight: where a dragged event goes, or a new one is.
  let marked: { from: number; to: number } | null = null;
  if (gesture?.kind === "create")
    marked = {
      from: Math.min(gesture.from.day, gesture.to.day),
      to: Math.max(gesture.from.day, gesture.to.day),
    };
  else if (gesture?.kind === "move") {
    const shift = gesture.at.day - gesture.grab.day;
    const start = days.findIndex((day) => onDay(gesture.placed.event, day));
    const end = days.findLastIndex((day) => onDay(gesture.placed.event, day));
    if (start !== -1) marked = { from: start + shift, to: end + shift };
  } else if (ghost) {
    const start = days.findIndex(
      (day) => addDays(day, 1).getTime() > ghost.start,
    );
    const end = days.findLastIndex((day) => day.getTime() < ghost.end);
    if (start !== -1 && end !== -1) marked = { from: start, to: end };
  }
  const dragged = gesture?.kind === "move" ? gesture.placed : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto select-none">
      <div className="grid grid-cols-7 border-b border-zinc-200 text-center text-xs text-zinc-500 dark:border-zinc-800">
        {days.slice(0, 7).map((day) => (
          <div key={day.getTime()} className="py-1.5">
            {weekday.format(day)}
          </div>
        ))}
      </div>
      <div
        onPointerDown={onPointerDown}
        className="grid min-h-[36rem] flex-1 grid-cols-7 grid-rows-6"
      >
        {days.map((day, index) => {
          const list = events
            .filter((placed) => onDay(placed.event, day))
            .sort(dayOrder);
          const outside = day.getMonth() !== month;
          const highlighted =
            marked !== null && index >= marked.from && index <= marked.to;
          return (
            <div
              key={day.getTime()}
              ref={(element) => {
                cellRefs.current[index] = element;
              }}
              className={`flex min-w-0 flex-col gap-0.5 border-r border-b border-zinc-200 p-1 dark:border-zinc-800 ${
                highlighted
                  ? "bg-blue-50 dark:bg-blue-950/60"
                  : outside
                    ? "bg-zinc-50/70 dark:bg-zinc-900/50"
                    : ""
              }`}
            >
              <button
                type="button"
                aria-label={label.format(day)}
                aria-current={sameDay(day, now) ? "date" : undefined}
                onClick={() => {
                  onOpenDay(day);
                }}
                className={`grid size-6 place-items-center self-start rounded-full text-xs hover:bg-zinc-100 aria-[current=date]:bg-blue-600 aria-[current=date]:font-semibold aria-[current=date]:text-white dark:hover:bg-zinc-800 ${outside ? "text-zinc-400" : "text-zinc-700 dark:text-zinc-200"}`}
              >
                {dayNumber.format(day)}
              </button>
              {ghost && marked?.from === index && !gesture && (
                <div className="truncate rounded border border-dashed border-blue-600 bg-blue-50 px-1 py-0.5 text-xs font-medium text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-50">
                  {ghost.title || t.calendar.newEventHere}
                </div>
              )}
              {list.slice(0, PER_DAY).map((placed) => (
                <EventChip
                  key={`${placed.source.key}/${placed.event.id}`}
                  placed={placed}
                  onOpen={onOpen}
                  day={day}
                  draggable={canDrag(placed)}
                  dragging={
                    dragged !== undefined &&
                    eventKey(dragged) === eventKey(placed)
                  }
                />
              ))}
              {list.length > PER_DAY && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenDay(day);
                  }}
                  className="px-1 text-left text-xs text-zinc-600 hover:underline dark:text-zinc-300"
                >
                  {t.calendar.more(list.length - PER_DAY)}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
