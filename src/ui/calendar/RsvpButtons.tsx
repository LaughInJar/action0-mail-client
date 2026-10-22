import type { CalendarEvent, Rsvp } from "../../core/calendar";
import type { CalendarSource } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { useAnswer } from "./useAnswer";

const ANSWERS: readonly Rsvp[] = ["accepted", "tentative", "declined"];

/** "Going? Yes · Maybe · No", with the current answer pressed. */
export function RsvpButtons({
  source,
  event,
}: {
  source: CalendarSource;
  event: CalendarEvent;
}) {
  const t = useT();
  const answer = useAnswer();
  return (
    <div
      role="group"
      aria-label={t.calendar.going}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {t.calendar.going}
      </span>
      {ANSWERS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={event.myResponse === value}
          onClick={() => {
            answer(source, event, value);
          }}
          className="rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 aria-pressed:border-blue-600 aria-pressed:bg-blue-600 aria-pressed:text-white dark:border-zinc-700 dark:hover:bg-zinc-800 dark:aria-pressed:border-blue-500 dark:aria-pressed:bg-blue-500 pointer-coarse:min-h-11"
        >
          {t.calendar.answers[value]}
        </button>
      ))}
    </div>
  );
}
