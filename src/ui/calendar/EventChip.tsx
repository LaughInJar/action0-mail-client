import { isAllDay } from "../../core/calendar";
import type { PlacedEvent } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { eventColor, eventKey, shortTime, titleOf } from "./format";

/**
 * An event in a view, in its calendar's colour: a bar (`compact`), a block
 * that fills its place in the time grid (`fill`), or a line in a list.
 * Unanswered invitations are outlined, declined ones struck through.
 */
export function EventChip({
  placed,
  onOpen,
  compact = false,
  fill = false,
  short = false,
  day,
  dragging = false,
  draggable = false,
  resizable = false,
}: {
  placed: PlacedEvent;
  onOpen: (placed: PlacedEvent) => void;
  compact?: boolean;
  fill?: boolean;
  /** Too short for two lines in the time grid: title and start on one. */
  short?: boolean;
  /** The day it's listed under (month view), for multi-day events. */
  day?: Date;
  /** It's being dragged elsewhere (shown faded). */
  dragging?: boolean;
  /** It can be dragged; `resizable` adds a handle on its bottom edge. */
  draggable?: boolean;
  resizable?: boolean;
}) {
  const t = useT();
  const { event } = placed;
  const title = titleOf(event, t);
  const time = shortTime(event, t, day);
  const answer = event.myResponse;
  const solid = isAllDay(event) || compact || fill;
  const tone =
    answer === "needsAction"
      ? "border border-dashed border-[var(--event-color)] bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
      : solid
        ? "border-l-4 border-[var(--event-color)] bg-[color-mix(in_srgb,var(--event-color)_22%,white)] text-zinc-900 dark:bg-[color-mix(in_srgb,var(--event-color)_35%,black)] dark:text-zinc-50"
        : "text-zinc-800 dark:text-zinc-100";
  return (
    <button
      type="button"
      onClick={() => {
        onOpen(placed);
      }}
      style={eventColor(placed)}
      aria-label={`${title}, ${time}`}
      data-event-key={eventKey(placed)}
      className={`@container relative flex w-full min-w-0 overflow-hidden rounded text-left text-xs leading-tight hover:brightness-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${tone} ${
        answer === "declined" ? "line-through opacity-60" : ""
      } ${dragging ? "opacity-40" : ""} ${draggable ? "touch-manipulation [-webkit-touch-callout:none]" : ""} ${fill && !short ? "h-full flex-col items-start px-1 py-0.5" : fill ? "h-full items-start gap-1 px-1 py-px text-[0.65rem]" : "items-center gap-1 px-1 py-0.5"}`}
    >
      {!solid && (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-[var(--event-color)]"
        />
      )}
      {!compact && !isAllDay(event) && !fill && (
        <span className="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400">
          {time.split(/[–-]/)[0]?.trim()}
        </span>
      )}
      <span className="min-w-0 truncate font-medium">{title}</span>
      {fill && (
        <span
          className={`truncate opacity-80 ${short ? "hidden shrink-0 @min-[7rem]:inline" : "text-[0.65rem]"}`}
        >
          {short ? time.split(/[–-]/)[0]?.trim() : time}
        </span>
      )}
      {resizable && (
        <span
          aria-hidden="true"
          data-resize=""
          className="absolute inset-x-0 bottom-0 flex h-1.5 cursor-ns-resize justify-center pointer-coarse:h-3"
        >
          <span className="mt-auto mb-0.5 hidden h-0.5 w-6 rounded-full bg-current opacity-50 pointer-coarse:block" />
        </span>
      )}
    </button>
  );
}
