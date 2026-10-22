import { useMemo, useState, type ReactNode } from "react";
import { useCalendarData } from "../../data/calendar";
import { useT } from "../../i18n/context";
import type { Command } from "../../keyboard/registry";
import { useCommands } from "../../keyboard/context";
import { useCalendarRoute, useRouter, useUiStore } from "../../state/context";
import type { CalendarRoute, CalendarView } from "../../state/router";
import { IconButton } from "../common/IconButton";
import { Drawer } from "../layout/Drawer";
import type { Breakpoint } from "../layout/useBreakpoint";
import { AgendaView } from "./AgendaView";
import { CalendarSidebar } from "./CalendarSidebar";
import {
  addDays,
  dayKey,
  firstDayOfWeek,
  isoWeek,
  parseDay,
  rangeOf,
  stepView,
  viewDays,
} from "./dates";
import { EventDetails } from "./EventDetails";
import { eventKey, findEvent, viewTitle } from "./format";
import { MonthView } from "./MonthView";
import { WeekView } from "./WeekView";

/** Views offered per screen size: phones get day and agenda. */
const VIEWS: Readonly<Record<Breakpoint, readonly CalendarView[]>> = {
  wide: ["day", "week", "month", "agenda"],
  medium: ["day", "week", "month", "agenda"],
  narrow: ["day", "agenda"],
};

/**
 * The calendar: its column (a drawer on smaller screens), the toolbar and
 * the view, and the open event (a panel on wide screens, over the view on
 * medium ones, a screen of its own on phones). Everything is in the URL.
 */
export function CalendarApp({ breakpoint }: { breakpoint: Breakpoint }) {
  const route = useCalendarRoute();
  return route ? <Calendar route={route} breakpoint={breakpoint} /> : null;
}

function Calendar({
  route,
  breakpoint,
}: {
  route: CalendarRoute;
  breakpoint: Breakpoint;
}) {
  const t = useT();
  const c = t.calendar;
  const router = useRouter();
  const store = useUiStore();
  const [drawer, setDrawer] = useState(false);
  const offered = VIEWS[breakpoint];
  const view: CalendarView = offered.includes(route.view)
    ? route.view
    : breakpoint === "narrow"
      ? "day"
      : "week";
  const day = parseDay(route.date);
  const firstDay = firstDayOfWeek(t.locale);
  const days = viewDays(view, day, firstDay);
  // Query keys compare by value: a new object per render is fine.
  const range = rangeOf(days);
  const { statuses, events, pending } = useCalendarData(range);
  const open = findEvent(events, route.event);

  const go = (next: Partial<CalendarRoute>, replace = false) => {
    const { event: _event, ...rest } = route;
    const target = { ...rest, ...next };
    router.openCalendar(target, { replace });
  };
  const goDay = (date: Date, nextView?: CalendarView) => {
    go({ date: dayKey(date), ...(nextView ? { view: nextView } : {}) });
  };
  const setView = (next: CalendarView) => {
    if (breakpoint !== "narrow" && next !== "day")
      store.getState().updateSettings({ calendarView: next });
    go({ view: next });
  };
  const close = () => {
    if (router.canGoBack()) router.back();
    else go({});
  };

  useCommands(
    useMemo((): Command[] => {
      const command = (
        id: string,
        description: string,
        keys: readonly string[],
        run: () => void,
      ): Command => ({ id, group: "calendar", description, keys, run });
      const s = t.shortcuts;
      return [
        command("calendar.today", s.calToday, ["t"], () => {
          goDay(new Date());
        }),
        command("calendar.previous", s.calPrevious, ["ArrowLeft", "k"], () => {
          goDay(stepView(view, day, -1));
        }),
        command("calendar.next", s.calNext, ["ArrowRight", "j"], () => {
          goDay(stepView(view, day, 1));
        }),
        command("calendar.day", s.calDay, ["d"], () => {
          setView("day");
        }),
        ...(breakpoint === "narrow"
          ? []
          : [
              command("calendar.week", s.calWeek, ["w"], () => {
                setView("week");
              }),
              command("calendar.month", s.calMonth, ["m"], () => {
                setView("month");
              }),
            ]),
        command("calendar.agenda", s.calAgenda, ["a"], () => {
          setView("agenda");
        }),
        {
          ...command("calendar.close", s.calClose, ["Escape"], close),
          when: () => route.event !== undefined,
        },
      ];
      // Commands follow the route.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [route, view, breakpoint, t]),
  );

  const openEvent = (placed: (typeof events)[number]) => {
    go({ event: eventKey(placed) });
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      {breakpoint !== "wide" && (
        <IconButton
          label={c.showCalendars}
          icon="menu"
          onClick={() => {
            setDrawer(true);
          }}
        />
      )}
      <button
        type="button"
        onClick={() => {
          goDay(new Date());
        }}
        className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
      >
        {c.today}
      </button>
      <IconButton
        label={c.previous}
        icon="chevron-left"
        onClick={() => {
          goDay(stepView(view, day, -1));
        }}
      />
      <IconButton
        label={c.next}
        icon="chevron-right"
        onClick={() => {
          goDay(stepView(view, day, 1));
        }}
      />
      <h2
        className={`min-w-0 truncate px-1 text-base font-semibold ${breakpoint === "narrow" ? "order-last basis-full" : "flex-1"}`}
        aria-live="polite"
      >
        {viewTitle(view, days, t)}
        {view === "week" && (
          <span className="ml-2 text-xs font-normal text-zinc-500">
            {c.week(isoWeek(days.first))}
          </span>
        )}
      </h2>
      {pending && <span className="sr-only">{c.loading}</span>}
      {breakpoint === "narrow" && <span className="flex-1" />}
      <div
        role="group"
        aria-label={c.viewLabel}
        className="flex rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700"
      >
        {offered.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => {
              setView(option);
            }}
            className="rounded px-2 py-0.5 text-sm hover:bg-zinc-100 aria-pressed:bg-blue-600 aria-pressed:text-white dark:hover:bg-zinc-800 dark:aria-pressed:bg-blue-500 pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            {c.views[option]}
          </button>
        ))}
      </div>
    </div>
  );

  let content: ReactNode;
  if (view === "month")
    content = (
      <MonthView
        first={days.first}
        month={day.getMonth()}
        events={events}
        onOpen={openEvent}
        onOpenDay={(date) => {
          goDay(date, "day");
        }}
      />
    );
  else if (view === "agenda")
    content = (
      <AgendaView
        first={days.first}
        days={30}
        events={events}
        onOpen={openEvent}
        onLater={() => {
          goDay(addDays(day, 30));
        }}
      />
    );
  else
    content = (
      <WeekView
        first={days.first}
        days={view === "day" ? 1 : 7}
        events={events}
        onOpen={openEvent}
        onOpenDay={(date) => {
          goDay(date, "day");
        }}
      />
    );

  const sidebar = (onNavigate?: () => void) => (
    <CalendarSidebar
      statuses={statuses}
      selected={day}
      firstDay={firstDay}
      onChooseDay={(date) => {
        goDay(date);
      }}
      {...(onNavigate ? { onNavigate } : {})}
    />
  );
  const details = open && (
    <EventDetails key={eventKey(open)} placed={open} onClose={close} />
  );

  // Phones: the open event is a screen of its own.
  if (breakpoint === "narrow" && open)
    return <div className="min-h-0 min-w-0 flex-1">{details}</div>;

  return (
    <>
      {breakpoint === "wide" ? (
        <div className="w-64 shrink-0 border-r border-zinc-200 dark:border-zinc-800">
          {sidebar()}
        </div>
      ) : (
        <Drawer
          open={drawer}
          label={c.calendars}
          onClose={() => {
            setDrawer(false);
          }}
        >
          {sidebar(() => {
            setDrawer(false);
          })}
        </Drawer>
      )}
      <main
        aria-label={c.calendar}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-zinc-950"
      >
        {toolbar}
        {content}
      </main>
      {details && (
        <div
          className={
            breakpoint === "wide"
              ? "w-96 shrink-0 border-l border-zinc-200 dark:border-zinc-800"
              : "fixed inset-y-0 right-0 z-30 w-full max-w-md border-l border-zinc-200 shadow-xl dark:border-zinc-800"
          }
        >
          {details}
        </div>
      )}
    </>
  );
}
