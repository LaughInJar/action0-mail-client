import { useEffect, useRef } from "react";
import { isAllDay } from "../../core/calendar";
import type { PlacedEvent } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { addDays, sameDay, spanOf } from "./dates";
import { EventChip } from "./EventChip";
import { layoutBars, layoutDay } from "./layout";
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

/**
 * Days side by side (one for the day view, seven for the week): all-day
 * events as bars on top, timed events in a 24-hour grid, overlapping ones
 * side by side, and a line at the current time.
 */
export function WeekView({
  first,
  days,
  events,
  onOpen,
  onOpenDay,
}: {
  first: Date;
  days: number;
  events: readonly PlacedEvent[];
  onOpen: (placed: PlacedEvent) => void;
  onOpenDay: (day: Date) => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
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

  const columns = {
    gridTemplateColumns: `3.5rem repeat(${String(days)}, minmax(0, 1fr))`,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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

      {/* All-day bars */}
      {bars.length > 0 && (
        <div
          className="relative grid border-b border-zinc-200 py-1 dark:border-zinc-800"
          style={{ ...columns, minHeight: `${String(rows * 1.5 + 0.5)}rem` }}
        >
          <div className="pr-1 text-right text-[0.65rem] leading-6 text-zinc-500">
            {t.calendar.allDay}
          </div>
          {bars
            .filter((bar) => bar.row < MAX_BAR_ROWS)
            .map((bar) => (
              <div
                key={`${bar.item.source.key}/${bar.item.event.id}`}
                className="px-0.5"
                style={{
                  gridColumn: `${String(bar.first + 2)} / ${String(bar.last + 3)}`,
                  gridRow: String(bar.row + 1),
                }}
              >
                <EventChip placed={bar.item} onOpen={onOpen} compact />
              </div>
            ))}
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
      )}

      {/* The time grid */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
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
          {dates.map((date) => {
            const placements = layoutDay(date, timed, (placed) =>
              spanOf(placed.event),
            );
            const today = sameDay(date, now);
            const minutes = now.getHours() * 60 + now.getMinutes();
            return (
              <div
                key={date.getTime()}
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
                    />
                  </div>
                ))}
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
