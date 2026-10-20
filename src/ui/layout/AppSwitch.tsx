import { useCalendarRoute, useRouter, useUi } from "../../state/context";
import { useT } from "../../i18n/context";
import { Icon } from "../common/Icon";
import { dayKey } from "../calendar/dates";
import { useBreakpoint } from "./useBreakpoint";

/** Mail or calendar: the two halves of the app, as a segmented switch. */
export function AppSwitch({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const calendar = useCalendarRoute();
  const view = useUi((state) => state.settings.calendarView);
  const breakpoint = useBreakpoint();
  const t = useT();
  const button =
    "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium aria-pressed:bg-white aria-pressed:text-zinc-900 aria-pressed:shadow-sm dark:aria-pressed:bg-zinc-700 dark:aria-pressed:text-zinc-50 pointer-coarse:min-h-11";
  return (
    <div
      role="group"
      aria-label={t.calendar.switchLabel}
      className="mx-2 mb-1 flex gap-1 rounded-lg bg-zinc-200/70 p-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
    >
      <button
        type="button"
        aria-pressed={calendar === null}
        className={button}
        onClick={() => {
          onNavigate?.();
          if (calendar !== null) router.navigate(router.getLastMailRoute());
        }}
      >
        <Icon name="mail" className="size-3.5" />
        {t.calendar.mail}
      </button>
      <button
        type="button"
        aria-pressed={calendar !== null}
        className={button}
        onClick={() => {
          onNavigate?.();
          if (calendar === null)
            router.openCalendar({
              view: breakpoint === "narrow" ? "day" : view,
              date: dayKey(new Date()),
            });
        }}
      >
        <Icon name="calendar" className="size-3.5" />
        {t.calendar.calendar}
      </button>
    </div>
  );
}
