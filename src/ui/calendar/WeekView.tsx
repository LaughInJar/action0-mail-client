import { useEffect, useRef, type CSSProperties } from "react";
import { isAllDay } from "../../core/calendar";
import type { PlacedEvent } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { addDays, dayKey, sameDay, spanOf } from "./dates";
import { EventChip } from "./EventChip";
import { clockRange, eventKey, findEvent, titleOf } from "./format";
import { localStamp } from "./formValues";
import { layoutBars, layoutDay } from "./layout";
import {
  movedByDays,
  movedInGrid,
  pickedRange,
  resizedInGrid,
  type EventTimes,
} from "./moves";
import { useGridGestures } from "./useGridGestures";
import { useNow } from "./useNow";

/** Height of one hour in the time grid, in px. */
const HOUR_PX = 48;

/** Bars shown at most in the all-day row before "+N more". */
const MAX_BAR_ROWS = 3;

/** Multi-day timed events count as all-day bars (like other calendars). */
function isBar(placed: PlacedEvent): boolean {
  if (isAllDay(placed.event)) return true;
  const { start, end } = spanOf(placed.event);
  return end - start >= 24 * 60 * 60 * 1000;
}

/** A new event's place before it exists: while it's being edited, or picked. */
export interface Ghost {
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
  readonly title?: string;
}

/** Props of {@link WeekView}. */
export interface WeekViewProps {
  readonly first: Date;
  readonly days: number;
  readonly events: readonly PlacedEvent[];
  readonly onOpen: (placed: PlacedEvent) => void;
  readonly onOpenDay: (day: Date) => void;
  /** The event can be dragged (moved, resized). */
  readonly canDrag: (placed: PlacedEvent) => boolean;
  /** A new event was asked for: local "YYYY-MM-DDTHH:MM" times, or days (`to` exclusive). */
  readonly onNewEvent: (from: string, to: string) => void;
  /** An event was dragged to new times. */
  readonly onChangeTimes: (placed: PlacedEvent, times: EventTimes) => void;
  /** The new event being edited. */
  readonly ghost?: Ghost | null;
}

/**
 * Days side by side (one for the day view, seven for the week): all-day
 * events as bars on top, timed events in a 24-hour grid, overlapping ones
 * side by side, and a line at the current time. Events can be dragged to
 * other times (and their bottom edge to change their length); clicking or
 * dragging across empty time starts a new event.
 */
export function WeekView({
  first,
  days,
  events,
  onOpen,
  onOpenDay,
  canDrag,
  onNewEvent,
  onChangeTimes,
  ghost,
}: WeekViewProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const barRowRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const now = useNow();
  const dates = Array.from({ length: days }, (_, i) => addDays(first, i));
  const bars = layoutBars(first, days, events.filter(isBar), (placed) =>
    spanOf(placed.event),
  );
  const rows = Math.min(
    MAX_BAR_ROWS,
    Math.max(0, ...bars.map((bar) => bar.row + 1)),
  );
  const timed = events.filter((placed) => !isBar(placed));
  const dayFormat = new Intl.DateTimeFormat(t.locale, { weekday: "short" });
  const dateFormat = new Intl.DateTimeFormat(t.locale, { day: "numeric" });

  // Start at 7:00, or an hour before now when today is shown.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const showsToday = dates.some((date) => sameDay(date, new Date()));
    const hour = showsToday ? Math.max(0, new Date().getHours() - 1) : 7;
    element.scrollTop = hour * HOUR_PX;
    // Only when the shown days change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.getTime(), days]);

  /** The day column under `x`, if any. */
  const dayAt = (x: number): number | null => {
    const index = columnRefs.current.findIndex((column) => {
      const rect = column?.getBoundingClientRect();
      return rect !== undefined && x >= rect.left && x < rect.right;
    });
    return index === -1 || index >= days ? null : index;
  };

  const eventOf = (key: string) => findEvent(events, key);

  const grid = useGridGestures({
    scroller: scrollRef,
    eventOf,
    canDrag,
    slotAt: (x, y) => {
      const view = scrollRef.current?.getBoundingClientRect();
      const rect = gridRef.current?.getBoundingClientRect();
      const day = dayAt(x);
      if (!view || !rect || day === null) return null;
      if (y < view.top || y > view.bottom) return null;
      const minutes = ((y - rect.top) / rect.height) * 24 * 60;
      return { day, minutes: Math.min(24 * 60, Math.max(0, minutes)) };
    },
    onCreate: (from, to) => {
      const { start, end } = pickedRange(first, from, to);
      onNewEvent(localStamp(start), localStamp(end));
    },
    onMove: (placed, grab, at) => {
      const times = movedInGrid(placed.event, grab, at);
      if (times) onChangeTimes(placed, times);
    },
    onResize: (placed, at) => {
      const times = resizedInGrid(placed.event, first, at);
      if (times) onChangeTimes(placed, times);
    },
  });

  const barGestures = useGridGestures({
    eventOf,
    canDrag,
    slotAt: (x, y) => {
      const rect = barRowRef.current?.getBoundingClientRect();
      const day = dayAt(x);
      if (!rect || day === null || y < rect.top - 8 || y > rect.bottom + 8)
        return null;
      return { day, minutes: 0 };
    },
    onCreate: (from) => {
      const day = addDays(first, from.day);
      onNewEvent(dayKey(day), dayKey(addDays(day, 1)));
    },
    onMove: (placed, grab, at) => {
      const times = movedByDays(placed.event, at.day - grab.day);
      if (times) onChangeTimes(placed, times);
    },
  });

  // Where things go while dragging, or the new event being edited.
  const gesture = grid.gesture;
  let preview: { start: number; end: number; title: string } | null = null;
  if (gesture?.kind === "create") {
    const { start, end } = pickedRange(first, gesture.from, gesture.to);
    preview = { start: start.getTime(), end: end.getTime(), title: "" };
  } else if (gesture) {
    const times =
      gesture.kind === "move"
        ? movedInGrid(gesture.placed.event, gesture.grab, gesture.at)
        : resizedInGrid(gesture.placed.event, first, gesture.at);
    const span = times ? spanOf({ ...gesture.placed.event, ...times }) : null;
    if (span) preview = { ...span, title: titleOf(gesture.placed.event, t) };
  } else if (ghost && !ghost.allDay)
    preview = { start: ghost.start, end: ghost.end, title: ghost.title ?? "" };
  const dragged =
    gesture && gesture.kind !== "create" ? gesture.placed : undefined;
  const barDrag =
    barGestures.gesture?.kind === "move" ? barGestures.gesture : null;
  const barShift = barDrag ? barDrag.at.day - barDrag.grab.day : 0;
  const ghostBar =
    ghost?.allDay === true
      ? layoutBars(first, days, [ghost], (item) => item)[0]
      : undefined;

  const columns = {
    gridTemplateColumns: `3.5rem repeat(${String(days)}, minmax(0, 1fr))`,
  };
  const draggedKey = (placed: PlacedEvent) =>
    dragged !== undefined && eventKey(dragged) === eventKey(placed);

  return (
    <div className="flex min-h-0 flex-1 flex-col select-none">
      {/* Day headers */}
      <div
        className="grid border-b border-zinc-200 dark:border-zinc-800"
        style={columns}
      >
        <div />
        {dates.map((date) => {
          const today = sameDay(date, now);
          return (
            <button
              key={date.getTime()}
              type="button"
              onClick={() => {
                onOpenDay(date);
              }}
              className="flex flex-col items-center py-1.5 text-xs text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              <span>{dayFormat.format(date)}</span>
              <span
                aria-current={today ? "date" : undefined}
                className="grid size-7 place-items-center rounded-full text-base font-semibold text-zinc-800 aria-[current=date]:bg-blue-600 aria-[current=date]:text-white dark:text-zinc-100"
              >
                {dateFormat.format(date)}
              </span>
            </button>
          );
        })}
      </div>

      {/* All-day bars (also where all-day events are started) */}
      <div
        ref={barRowRef}
        onPointerDown={barGestures.onPointerDown}
        className="relative grid border-b border-zinc-200 py-1 dark:border-zinc-800"
        style={{
          ...columns,
          minHeight: `${String(Math.max(rows, ghostBar ? ghostBar.row + 1 : 0, 1) * 1.5 + 0.5)}rem`,
        }}
      >
        <div className="pr-1 text-right text-[0.65rem] leading-6 text-zinc-500">
          {t.calendar.allDay}
        </div>
        {bars
          .filter((bar) => bar.row < MAX_BAR_ROWS)
          .map((bar) => {
            const moving =
              barDrag !== null &&
              eventKey(barDrag.placed) === eventKey(bar.item);
            const shift = moving ? barShift : 0;
            return (
              <div
                key={`${bar.item.source.key}/${bar.item.event.id}`}
                className="px-0.5"
                style={{
                  gridColumn: `${String(Math.max(0, bar.first + shift) + 2)} / ${String(Math.min(days - 1, bar.last + shift) + 3)}`,
                  gridRow: String(bar.row + 1),
                }}
              >
                <EventChip
                  placed={bar.item}
                  onOpen={onOpen}
                  compact
                  draggable={canDrag(bar.item)}
                  dragging={moving && barShift !== 0}
                />
              </div>
            );
          })}
        {ghostBar && (
          <div
            className="px-0.5"
            style={{
              gridColumn: `${String(ghostBar.first + 2)} / ${String(ghostBar.last + 3)}`,
              gridRow: String(Math.max(rows, 0) + 1),
            }}
          >
            <GhostBlock title={ghost?.title ?? ""} />
          </div>
        )}
        {dates.map((date, index) => {
          const hidden = bars.filter(
            (bar) =>
              bar.row >= MAX_BAR_ROWS &&
              bar.first <= index &&
              bar.last >= index,
          ).length;
          return hidden > 0 ? (
            <button
              key={date.getTime()}
              type="button"
              onClick={() => {
                onOpenDay(date);
              }}
              className="px-1 text-left text-xs text-zinc-600 hover:underline dark:text-zinc-300"
              style={{
                gridColumn: String(index + 2),
                gridRow: String(MAX_BAR_ROWS + 1),
              }}
            >
              {t.calendar.more(hidden)}
            </button>
          ) : null;
        })}
      </div>

      {/* The time grid */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          ref={gridRef}
          onPointerDown={grid.onPointerDown}
          className="relative grid"
          style={{ ...columns, height: `${String(24 * HOUR_PX)}px` }}
        >
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => (
              <span
                key={i}
                className="absolute right-1.5 -translate-y-1/2 text-[0.65rem] text-zinc-500"
                style={{ top: `${String((i + 1) * HOUR_PX)}px` }}
              >
                {new Intl.DateTimeFormat(t.locale, { hour: "numeric" }).format(
                  new Date(2000, 0, 1, i + 1),
                )}
              </span>
            ))}
          </div>
          {dates.map((date, index) => {
            const placements = layoutDay(date, timed, (placed) =>
              spanOf(placed.event),
            );
            const today = sameDay(date, now);
            const minutes = now.getHours() * 60 + now.getMinutes();
            const dayStart = date.getTime();
            const dayEnd = addDays(date, 1).getTime();
            const shown =
              preview && preview.start < dayEnd && preview.end > dayStart
                ? preview
                : null;
            return (
              <div
                key={date.getTime()}
                ref={(element) => {
                  columnRefs.current[index] = element;
                }}
                className="relative border-l border-zinc-200 bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_47px,var(--color-zinc-200)_47px,var(--color-zinc-200)_48px)] dark:border-zinc-800 dark:bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_47px,var(--color-zinc-800)_47px,var(--color-zinc-800)_48px)]"
              >
                {placements.map((placement) => (
                  <div
                    key={`${placement.item.source.key}/${placement.item.event.id}`}
                    className="absolute px-px"
                    style={{
                      top: `${String(placement.top * 100)}%`,
                      height: `${String(placement.height * 100)}%`,
                      left: `${String((placement.lane / placement.lanes) * 100)}%`,
                      width: `${String(100 / placement.lanes)}%`,
                    }}
                  >
                    <EventChip
                      placed={placement.item}
                      onOpen={onOpen}
                      fill
                      short={placement.height * 24 * HOUR_PX < 36}
                      draggable={canDrag(placement.item)}
                      resizable={canDrag(placement.item)}
                      dragging={draggedKey(placement.item)}
                    />
                  </div>
                ))}
                {shown && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-20 px-px"
                    style={blockStyle(shown, dayStart, dayEnd)}
                  >
                    <GhostBlock
                      title={shown.title}
                      time={clockRange(shown.start, shown.end, t.locale)}
                    />
                  </div>
                )}
                {today && (
                  <div
                    aria-label={t.calendar.now}
                    role="img"
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                    style={{ top: `${String((minutes / 1440) * 100)}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Top and height of a span within a day column. */
function blockStyle(
  span: { start: number; end: number },
  dayStart: number,
  dayEnd: number,
): CSSProperties {
  const length = dayEnd - dayStart;
  const start = Math.max(span.start, dayStart);
  const end = Math.min(span.end, dayEnd);
  return {
    top: `${String(((start - dayStart) / length) * 100)}%`,
    height: `${String(Math.max((end - start) / length, 1 / 96) * 100)}%`,
  };
}

/** Where a new or moved event goes. */
function GhostBlock({ title, time }: { title: string; time?: string }) {
  const t = useT();
  return (
    <div className="flex h-full min-h-5 flex-col overflow-hidden rounded border-2 border-dashed border-blue-600 bg-blue-50/90 px-1 py-0.5 text-xs leading-tight text-blue-950 shadow-sm dark:border-blue-400 dark:bg-blue-950/90 dark:text-blue-50">
      <span className="truncate font-medium">
        {title || t.calendar.newEventHere}
      </span>
      {time && <span className="truncate text-[0.65rem]">{time}</span>}
    </div>
  );
}
