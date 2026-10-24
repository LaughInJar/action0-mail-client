import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCalendarData, type PlacedEvent } from "../../data/calendar";
import { canChange } from "../../data/eventEdits";
import { useT } from "../../i18n/context";
import type { Command } from "../../keyboard/registry";
import { useCommands } from "../../keyboard/context";
import {
  useCalendarRoute,
  useRouter,
  useUi,
  useUiStore,
} from "../../state/context";
import type { CalendarRoute, CalendarView } from "../../state/router";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { useAsk } from "../common/useAsk";
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
import { EventEditor } from "./EventEditor";
import { EventMenu } from "./EventMenu";
import { eventKey, findEvent, viewTitle } from "./format";
import {
  newValues,
  spanOfValues,
  suggestedTime,
  type EditorMode,
} from "./formValues";
import { MonthView } from "./MonthView";
import type { EventTimes } from "./moves";
import { useEventActions } from "./useEventActions";
import { WeekView, type Ghost } from "./WeekView";

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

  const actions = useEventActions();
  const ask = useAsk();
  const form = useUi((state) => state.eventForm);
  const contextMenu = useUi((state) => state.contextMenu);
  const editorKey = route.create
    ? "new"
    : route.edit && route.event !== undefined
      ? route.event
      : null;

  /**
   * Goes somewhere else in the calendar: an open event closes; a new
   * event being written stays open (and moving around replaces the
   * history entry, so Back still closes it).
   */
  const go = (next: Partial<CalendarRoute>, replace = false) => {
    const { event: _event, edit: _edit, create, ...rest } = route;
    const keep =
      create && next.event === undefined && next.create === undefined;
    router.openCalendar(
      { ...rest, ...(keep ? { create } : {}), ...next },
      {
        replace:
          replace ||
          (keep ?? false) ||
          (create !== undefined && next.create !== undefined),
      },
    );
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
    else {
      const { event: _event, edit: _edit, create: _create, ...rest } = route;
      router.openCalendar(rest, { replace: true });
    }
  };
  const newEvent = (from?: string, to?: string) => {
    const times =
      from !== undefined && to !== undefined
        ? { from, to }
        : suggestedTime(day, new Date());
    go({ create: times });
  };
  const editEvent = (placed: PlacedEvent) => {
    router.openCalendar({
      view: route.view,
      date: route.date,
      event: eventKey(placed),
      edit: true,
    });
  };
  const afterDelete = () => {
    router.openCalendar(
      { view: route.view, date: route.date },
      { replace: true },
    );
  };
  const removeEvent = (placed: PlacedEvent) => {
    void actions.remove(placed).then((removed) => {
      if (removed) afterDelete();
    });
  };
  const changeTimes = (placed: PlacedEvent, times: EventTimes) => {
    void actions.update(placed, times, { moved: true });
  };

  // Leaving the editor with unsaved changes (Back, or going elsewhere):
  // back to it, and ask.
  const left = useRef({ key: editorKey, route });
  useEffect(() => {
    const before = left.current;
    left.current = { key: editorKey, route };
    if (before.key === null || before.key === editorKey) return;
    const current = store.getState().eventForm;
    if (current?.key !== before.key) return;
    if (!current.dirty) {
      store.getState().setEventForm(null);
      return;
    }
    router.openCalendar(before.route);
    void ask({
      title: t.calendar.discardTitle,
      message: t.calendar.discardMessage,
      cancelLabel: t.calendar.keepEditing,
      options: [
        { value: "discard", label: t.calendar.discard, tone: "danger" },
      ],
    }).then((answer) => {
      if (answer === null) return;
      store.getState().setEventForm(null);
      router.back();
    });
    // Only when the editor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey]);

  // Leaving the page asks too.
  const dirty = form?.dirty === true;
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);

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
        command("calendar.new", s.calNew, ["c"], () => {
          newEvent();
        }),
        {
          ...command("calendar.edit", s.calEdit, ["e"], () => {
            if (open) editEvent(open);
          }),
          when: () => open !== undefined && !route.edit && canChange(open),
        },
        {
          ...command("calendar.delete", s.calDelete, ["Delete"], () => {
            if (open) removeEvent(open);
          }),
          when: () => open !== undefined && !route.edit && canChange(open),
        },
        {
          ...command("calendar.close", s.calClose, ["Escape"], close),
          when: () => route.event !== undefined && !route.edit,
        },
      ];
      // Commands follow the route.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [route, view, breakpoint, t, open]),
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
      {breakpoint === "medium" && (
        <IconButton
          label={c.newEvent}
          icon="plus"
          onClick={() => {
            newEvent();
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

  // The new event being written, where it would go.
  let ghost: Ghost | null = null;
  if (route.create) {
    const values =
      form?.key === "new"
        ? form.values
        : route.create.from !== undefined && route.create.to !== undefined
          ? newValues(route.create.from, route.create.to, "")
          : undefined;
    if (values)
      ghost = {
        ...spanOfValues(values),
        allDay: values.allDay,
        title: values.title,
      };
  }
  const gridProps = {
    canDrag: canChange,
    onNewEvent: newEvent,
    onChangeTimes: changeTimes,
    ghost,
  };

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
        {...gridProps}
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
        {...gridProps}
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
      onNewEvent={() => {
        newEvent();
      }}
      {...(onNavigate ? { onNavigate } : {})}
    />
  );

  // The editor takes the place of the event's details.
  const mode: EditorMode | undefined = route.create
    ? {
        kind: "new",
        ...(route.create.from !== undefined && route.create.to !== undefined
          ? { from: route.create.from, to: route.create.to }
          : suggestedTime(day, new Date())),
      }
    : route.edit && open
      ? { kind: "edit", placed: open }
      : undefined;
  const panel = mode ? (
    <EventEditor
      mode={mode}
      statuses={statuses}
      onClose={close}
      onDeleted={afterDelete}
    />
  ) : route.edit && route.event !== undefined ? (
    <p className="h-full bg-white p-4 text-sm text-zinc-500 dark:bg-zinc-950">
      {c.loadingEvent}
    </p>
  ) : (
    open && (
      <EventDetails
        key={eventKey(open)}
        placed={open}
        onClose={close}
        {...(canChange(open)
          ? {
              onEdit: () => {
                editEvent(open);
              },
              onDelete: () => {
                removeEvent(open);
              },
            }
          : {})}
      />
    )
  );

  // An event's context menu (right-click, long press, the Menu key).
  const menuEvent =
    contextMenu?.kind === "event"
      ? findEvent(events, contextMenu.eventKey)
      : undefined;
  const menu = contextMenu && menuEvent && (
    <EventMenu
      key={JSON.stringify(contextMenu)}
      placed={menuEvent}
      at={contextMenu.at}
      onOpen={openEvent}
      onEdit={editEvent}
      onDelete={removeEvent}
      onClose={() => {
        store.getState().setContextMenu(null);
      }}
    />
  );

  // Phones: the open event (or the editor) is a screen of its own.
  if (breakpoint === "narrow" && panel)
    return <div className="min-h-0 min-w-0 flex-1">{panel}</div>;

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
      {panel && (
        <div
          className={
            breakpoint === "wide"
              ? "w-96 shrink-0 border-l border-zinc-200 dark:border-zinc-800"
              : "fixed inset-y-0 right-0 z-30 w-full max-w-md border-l border-zinc-200 shadow-xl dark:border-zinc-800"
          }
        >
          {panel}
        </div>
      )}
      {breakpoint === "narrow" && (
        <button
          type="button"
          aria-label={c.newEvent}
          onClick={() => {
            newEvent();
          }}
          className="fixed right-4 bottom-[calc(1.5rem+var(--safe-bottom))] z-30 grid size-14 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg"
        >
          <Icon name="plus" className="size-6" />
        </button>
      )}
      {menu}
    </>
  );
}
