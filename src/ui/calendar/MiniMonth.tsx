import { useState, type KeyboardEvent } from "react";
import { useT } from "../../i18n/context";
import { IconButton } from "../common/IconButton";
import { addDays, addMonths, sameDay, startOfWeek } from "./dates";

/**
 * A small month to jump to a date: arrow keys move between days (Page Up /
 * Page Down between months), Enter or a click chooses. Today and the
 * selected day are marked.
 */
export function MiniMonth({
  selected,
  firstDay,
  onChoose,
}: {
  selected: Date;
  firstDay: number;
  onChoose: (day: Date) => void;
}) {
  const t = useT();
  const [shown, setShown] = useState(
    () => new Date(selected.getFullYear(), selected.getMonth(), 1),
  );
  const [focus, setFocus] = useState(selected);
  const [lastSelected, setLastSelected] = useState(selected);
  // Follow the calendar when it moves elsewhere.
  if (!sameDay(lastSelected, selected)) {
    setLastSelected(selected);
    setFocus(selected);
    setShown(new Date(selected.getFullYear(), selected.getMonth(), 1));
  }
  const first = startOfWeek(shown, firstDay);
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const title = new Intl.DateTimeFormat(t.locale, {
    month: "long",
    year: "numeric",
  }).format(shown);
  const weekday = new Intl.DateTimeFormat(t.locale, { weekday: "narrow" });
  const full = new Intl.DateTimeFormat(t.locale, { dateStyle: "full" });
  const today = new Date();

  const move = (day: Date) => {
    setFocus(day);
    if (
      day.getMonth() !== shown.getMonth() ||
      day.getFullYear() !== shown.getFullYear()
    )
      setShown(new Date(day.getFullYear(), day.getMonth(), 1));
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-mini-day="${String(day.getTime())}"]`,
        )
        ?.focus();
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const steps: Readonly<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const step = steps[event.key];
    if (step !== undefined) move(addDays(focus, step));
    else if (event.key === "PageUp") move(addMonths(focus, -1));
    else if (event.key === "PageDown") move(addMonths(focus, 1));
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="px-3 pb-2">
      <div className="flex items-center">
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <IconButton
          label={t.calendar.previousMonth}
          icon="chevron-left"
          onClick={() => {
            setShown(addMonths(shown, -1));
          }}
        />
        <IconButton
          label={t.calendar.nextMonth}
          icon="chevron-right"
          onClick={() => {
            setShown(addMonths(shown, 1));
          }}
        />
      </div>
      <div
        role="grid"
        tabIndex={-1}
        aria-label={t.calendar.chooseDate}
        onKeyDown={onKeyDown}
        className="grid grid-cols-7 text-center text-xs"
      >
        <div role="row" className="contents">
          {days.slice(0, 7).map((day) => (
            <span
              key={day.getTime()}
              role="columnheader"
              className="py-1 text-zinc-500"
            >
              {weekday.format(day)}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} role="row" className="contents">
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const isSelected = sameDay(day, selected);
              return (
                <span
                  key={day.getTime()}
                  role="gridcell"
                  aria-selected={isSelected}
                >
                  <button
                    type="button"
                    data-mini-day={day.getTime()}
                    tabIndex={sameDay(day, focus) ? 0 : -1}
                    aria-label={full.format(day)}
                    aria-current={sameDay(day, today) ? "date" : undefined}
                    onClick={() => {
                      setFocus(day);
                      onChoose(day);
                    }}
                    className={`mx-auto grid size-7 place-items-center rounded-full hover:bg-zinc-200 aria-[current=date]:font-bold aria-[current=date]:text-blue-700 dark:hover:bg-zinc-800 dark:aria-[current=date]:text-blue-300 pointer-coarse:size-10 ${
                      isSelected
                        ? "bg-blue-100 text-blue-900 dark:bg-blue-500/30 dark:text-blue-100"
                        : day.getMonth() === shown.getMonth()
                          ? "text-zinc-800 dark:text-zinc-100"
                          : "text-zinc-400"
                    }`}
                  >
                    {day.getDate()}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
