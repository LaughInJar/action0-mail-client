import type { PlacedEvent } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { addDays, onDay, sameDay } from "./dates";
import { EventChip } from "./EventChip";
import { dayOrder } from "./format";
import { useNow } from "./useNow";

/** Events listed per day at most before "+N more". */
const PER_DAY = 3;

/** Six weeks, each day with its first few events; a day opens the day view. */
export function MonthView({
  first,
  month,
  events,
  onOpen,
  onOpenDay,
}: {
  first: Date;
  /** The month shown (days of other months are dimmed). */
  month: number;
  events: readonly PlacedEvent[];
  onOpen: (placed: PlacedEvent) => void;
  onOpenDay: (day: Date) => void;
}) {
  const t = useT();
  const now = useNow();
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const weekday = new Intl.DateTimeFormat(t.locale, { weekday: "short" });
  const dayNumber = new Intl.DateTimeFormat(t.locale, { day: "numeric" });
  const label = new Intl.DateTimeFormat(t.locale, { dateStyle: "full" });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="grid grid-cols-7 border-b border-zinc-200 text-center text-xs text-zinc-500 dark:border-zinc-800">
        {days.slice(0, 7).map((day) => (
          <div key={day.getTime()} className="py-1.5">
            {weekday.format(day)}
          </div>
        ))}
      </div>
      <div className="grid min-h-[36rem] flex-1 grid-cols-7 grid-rows-6">
        {days.map((day) => {
          const list = events
            .filter((placed) => onDay(placed.event, day))
            .sort(dayOrder);
          const outside = day.getMonth() !== month;
          return (
            <div
              key={day.getTime()}
              className={`flex min-w-0 flex-col gap-0.5 border-r border-b border-zinc-200 p-1 dark:border-zinc-800 ${outside ? "bg-zinc-50/70 dark:bg-zinc-900/50" : ""}`}
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
              {list.slice(0, PER_DAY).map((placed) => (
                <EventChip
                  key={`${placed.source.key}/${placed.event.id}`}
                  placed={placed}
                  onOpen={onOpen}
                  day={day}
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
