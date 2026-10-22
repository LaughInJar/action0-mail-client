import type { PlacedEvent } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { addDays, onDay, sameDay } from "./dates";
import { EventChip } from "./EventChip";
import { dayOrder } from "./format";

/** The days with events, one after the other (also the phone's list). */
export function AgendaView({
  first,
  days,
  events,
  onOpen,
  onLater,
}: {
  first: Date;
  days: number;
  events: readonly PlacedEvent[];
  onOpen: (placed: PlacedEvent) => void;
  onLater: () => void;
}) {
  const t = useT();
  const heading = new Intl.DateTimeFormat(t.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const today = new Date();
  const groups = Array.from({ length: days }, (_, i) => addDays(first, i))
    .map((day) => ({
      day,
      list: events.filter((placed) => onDay(placed.event, day)).sort(dayOrder),
    }))
    .filter((group) => group.list.length > 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {groups.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">
          {days === 1 ? t.calendar.noEvents : t.calendar.agendaEmpty}
        </p>
      )}
      {groups.map(({ day, list }) => (
        <section key={day.getTime()} className="mb-3">
          <h3
            className={`sticky top-0 bg-white py-1 text-xs font-semibold tracking-wide uppercase dark:bg-zinc-950 ${sameDay(day, today) ? "text-blue-700 dark:text-blue-300" : "text-zinc-500"}`}
          >
            {heading.format(day)}
          </h3>
          <ul className="space-y-1">
            {list.map((placed) => (
              <li
                key={`${placed.source.key}/${placed.event.id}`}
                className="pointer-coarse:min-h-11"
              >
                <EventChip placed={placed} onOpen={onOpen} day={day} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {days > 1 && (
        <button
          type="button"
          onClick={onLater}
          className="my-2 w-full rounded-md py-2 text-sm text-blue-700 hover:bg-zinc-100 dark:text-blue-300 dark:hover:bg-zinc-900"
        >
          {t.calendar.laterInAgenda}
        </button>
      )}
    </div>
  );
}
