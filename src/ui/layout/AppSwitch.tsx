import { useAppPart, useRouter, useUi } from "../../state/context";
import { ALL_CONTACTS } from "../../state/router";
import { useT } from "../../i18n/context";
import { Icon } from "../common/Icon";
import { dayKey } from "../calendar/dates";
import { useBreakpoint } from "./useBreakpoint";

/**
 * Mail, calendar or contacts: the three parts of the app, as a segmented
 * switch (with icons where it's wide enough, e.g. in the phones' drawer).
 */
export function AppSwitch({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const part = useAppPart();
  const view = useUi((state) => state.settings.calendarView);
  const breakpoint = useBreakpoint();
  const t = useT();
  const button =
    "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium aria-pressed:bg-white aria-pressed:text-zinc-900 aria-pressed:shadow-sm dark:aria-pressed:bg-zinc-700 dark:aria-pressed:text-zinc-50 pointer-coarse:min-h-11";
  return (
    <div
      role="group"
      aria-label={t.calendar.switchLabel}
      className="@container mx-2 mb-1 flex gap-1 rounded-lg bg-zinc-200/70 p-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
    >
      <button
        type="button"
        aria-pressed={part === "mail"}
        className={button}
        onClick={() => {
          onNavigate?.();
          if (part !== "mail") router.navigate(router.getLastMailRoute());
        }}
      >
        <Icon name="mail" className="hidden size-3.5 shrink-0 @[18rem]:block" />
        <span className="truncate">{t.calendar.mail}</span>
      </button>
      <button
        type="button"
        aria-pressed={part === "calendar"}
        className={button}
        onClick={() => {
          onNavigate?.();
          if (part !== "calendar")
            router.openCalendar({
              view: breakpoint === "narrow" ? "day" : view,
              date: dayKey(new Date()),
            });
        }}
      >
        <Icon
          name="calendar"
          className="hidden size-3.5 shrink-0 @[18rem]:block"
        />
        <span className="truncate">{t.calendar.calendar}</span>
      </button>
      <button
        type="button"
        aria-pressed={part === "contacts"}
        className={button}
        onClick={() => {
          onNavigate?.();
          if (part !== "contacts")
            router.openContacts({
              list: router.getLastContactsRoute()?.list ?? ALL_CONTACTS,
            });
        }}
      >
        <Icon
          name="users"
          className="hidden size-3.5 shrink-0 @[18rem]:block"
        />
        <span className="truncate">{t.calendar.contacts}</span>
      </button>
    </div>
  );
}
