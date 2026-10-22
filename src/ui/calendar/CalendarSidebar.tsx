import { useState } from "react";
import type { IcsSubscription } from "../../core/calendar";
import { choiceKey, isShown, type SourceStatus } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { useRouter, useUi, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { AppSwitch } from "../layout/AppSwitch";
import { ThemeSwitch } from "../layout/ThemeSwitch";
import { APP_TITLE } from "../sync/useDocumentTitle";
import { IcsDialog } from "./IcsDialog";
import { MiniMonth } from "./MiniMonth";

/**
 * The calendar's column: the app's header and switch, a small month, and
 * every source's calendars with a checkbox each; accounts that haven't
 * allowed calendar access offer "Allow calendar".
 */
export function CalendarSidebar({
  statuses,
  selected,
  firstDay,
  onChooseDay,
  onNavigate,
}: {
  statuses: readonly SourceStatus[];
  selected: Date;
  firstDay: number;
  onChooseDay: (day: Date) => void;
  /** Called after navigating (closes the drawer). */
  onNavigate?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const [dialog, setDialog] = useState<
    { mode: "add" } | { mode: "edit"; subscription: IcsSubscription } | null
  >(null);

  return (
    <nav
      aria-label={t.calendar.calendars}
      className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 pt-2 pr-2 pb-1 pl-4 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        <Icon name="mail" className="size-5 text-blue-600 dark:text-blue-400" />
        <span className="flex-1">{APP_TITLE}</span>
        <ThemeSwitch />
        <IconButton
          label={t.layout.settings}
          icon="settings"
          onClick={() => {
            onNavigate?.();
            router.openSettings();
          }}
        />
      </div>
      <AppSwitch {...(onNavigate ? { onNavigate } : {})} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-2">
        <MiniMonth
          selected={selected}
          firstDay={firstDay}
          onChoose={(day) => {
            onChooseDay(day);
            onNavigate?.();
          }}
        />
        {statuses.length === 0 && (
          <p className="px-4 py-2 text-sm text-zinc-500">
            {t.calendar.noSources}
          </p>
        )}
        {statuses.map((status) => (
          <SourceSection
            key={status.source.key}
            status={status}
            onEdit={(subscription) => {
              setDialog({ mode: "edit", subscription });
            }}
          />
        ))}
        <div className="px-2 pt-1 pb-3">
          <button
            type="button"
            onClick={() => {
              setDialog({ mode: "add" });
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 pointer-coarse:min-h-11"
          >
            <Icon name="plus" className="size-3.5" />
            {t.calendar.addByUrl}
          </button>
        </div>
      </div>
      {dialog && (
        <IcsDialog
          {...(dialog.mode === "edit" ? { editing: dialog.subscription } : {})}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </nav>
  );
}

function SourceSection({
  status,
  onEdit,
}: {
  status: SourceStatus;
  onEdit: (subscription: IcsSubscription) => void;
}) {
  const t = useT();
  const c = t.calendar;
  const store = useUiStore();
  const choices = useUi((state) => state.settings.calendarChoices);
  const { source, signedIn, access, calendars, error, pending } = status;
  const subscription = source.subscription;
  const [allowing, setAllowing] = useState(false);

  const allow = () => {
    setAllowing(true);
    source.provider.requestAccess().then(
      () => {
        setAllowing(false);
      },
      (cause: unknown) => {
        setAllowing(false);
        store.getState().showToast({
          message: errorMessage(cause, t),
          tone: "error",
        });
      },
    );
  };

  return (
    <section aria-label={source.label} className="px-2 pt-2 pb-1">
      <div className="flex items-center gap-1 px-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-500">
          {source.label}
        </h3>
        {subscription && (
          <>
            <span className="sr-only">{c.icsMarker}</span>
            <span
              aria-hidden="true"
              title={c.icsMarker}
              className="text-[0.6rem] font-semibold text-zinc-400 uppercase"
            >
              {c.icsBadge}
            </span>
            <IconButton
              label={`${c.edit} ${subscription.name}`}
              icon="pencil"
              onClick={() => {
                onEdit(subscription);
              }}
            />
            <IconButton
              label={`${c.remove} ${subscription.name}`}
              icon="trash"
              onClick={() => {
                store.getState().setConfirm({
                  title: c.removeTitle(subscription.name),
                  message: c.removeMessage,
                  confirmLabel: c.remove,
                  action: {
                    kind: "remove-calendar",
                    id: subscription.id,
                    name: subscription.name,
                  },
                });
              }}
            />
          </>
        )}
      </div>
      {!signedIn && (
        <p className="px-2 py-1 text-xs text-zinc-500">{c.reconnectFirst}</p>
      )}
      {signedIn && access === "missing" && (
        <div className="space-y-1 px-2 py-1">
          <p className="text-xs text-zinc-500">{c.allowHint}</p>
          <button
            type="button"
            disabled={allowing}
            onClick={allow}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
          >
            {c.allowCalendar}
          </button>
        </div>
      )}
      {signedIn &&
        access === "granted" &&
        pending &&
        calendars === undefined && (
          <p className="px-2 py-1 text-xs text-zinc-500">
            {c.loadingCalendars}
          </p>
        )}
      {error !== null && error !== undefined && access === "granted" && (
        <p
          role="alert"
          className="px-2 py-1 text-xs text-red-700 dark:text-red-400"
        >
          {c.couldntLoad(errorMessage(error, t))}
        </p>
      )}
      <ul>
        {(access === "granted" ? (calendars ?? []) : []).map((calendar) => {
          const shown = isShown(choices, source, calendar);
          return (
            <li key={calendar.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-zinc-200/60 dark:hover:bg-zinc-800 pointer-coarse:min-h-11">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={(event) => {
                    store.getState().updateSettings({
                      calendarChoices: {
                        ...store.getState().settings.calendarChoices,
                        [choiceKey(source, calendar)]: event.target.checked,
                      },
                    });
                  }}
                  className="size-4 shrink-0"
                  style={{ accentColor: calendar.color }}
                />
                <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
