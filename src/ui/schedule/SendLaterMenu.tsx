import { useId, useRef, useState } from "react";
import { earliestSendAt, sendLaterPresets } from "../../core/schedule";
import { snoozePresets } from "../../core/snooze";
import { useT } from "../../i18n/context";
import type { AppSettings } from "../../state/settings";
import { useUi, useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { formatSendAt } from "../common/format";
import { BUTTON, FIELD, PRIMARY } from "../common/formStyles";
import { Sheet } from "../common/Sheet";

/** What a menu of times is for: its title, its presets, and where the custom time is kept. */
interface TimeChoice {
  readonly title: string;
  /** The dialog's button. */
  readonly confirm: string;
  readonly presets: readonly {
    readonly id: string;
    readonly label: string;
    readonly at: Date;
  }[];
  readonly remember: "lastSendLater" | "lastSnooze";
}

/** Props of {@link SendLaterMenu} and {@link SnoozeMenu}. */
export interface TimeMenuProps {
  readonly at: MenuPosition;
  /** Entries before the times (Send now, Don't schedule). */
  readonly extra?: readonly MenuEntry[];
  /** The time the picker starts from (a scheduled or snoozed mail's), ISO. */
  readonly current?: string;
  readonly onPick: (at: Date) => void;
  readonly onClose: () => void;
}

/** Send later's times: the presets that fit the day, the time picked last, and Pick date & time…. */
export function SendLaterMenu(props: TimeMenuProps) {
  const t = useT();
  const s = t.schedule;
  const [now] = useState(() => new Date());
  return (
    <TimeMenu
      {...props}
      choice={{
        title: s.sendLater,
        confirm: s.schedule,
        presets: sendLaterPresets(now).map((preset) => ({
          id: preset.kind,
          label: s.presets[preset.kind],
          at: preset.at,
        })),
        remember: "lastSendLater",
      }}
    />
  );
}

/** Snooze's times: later today, tomorrow, this weekend, next week, the time picked last, and Pick date & time…. */
export function SnoozeMenu(props: TimeMenuProps) {
  const t = useT();
  const z = t.snooze;
  const [now] = useState(() => new Date());
  return (
    <TimeMenu
      {...props}
      choice={{
        title: z.snooze,
        confirm: z.snooze,
        presets: snoozePresets(now).map((preset) => ({
          id: preset.kind,
          label: z.presets[preset.kind],
          at: preset.at,
        })),
        remember: "lastSnooze",
      }}
    />
  );
}

/**
 * A menu of times: the presets, the time picked last (if it's still
 * ahead), and Pick date & time…, which opens a small dialog.
 */
function TimeMenu({
  at,
  extra = [],
  current,
  onPick,
  onClose,
  choice,
}: TimeMenuProps & { readonly choice: TimeChoice }) {
  const t = useT();
  const s = t.schedule;
  const last = useUi((state) => state.settings[choice.remember]);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const [now] = useState(() => new Date());
  const when = (date: Date) =>
    formatSendAt(date.toISOString(), { locale: t.locale, now });
  const lastAt = last ? new Date(last) : undefined;

  if (picking)
    return (
      <TimeDialog
        title={choice.title}
        confirm={choice.confirm}
        remember={choice.remember}
        {...(current ? { current } : {})}
        onPick={(picked) => {
          onClose();
          onPick(picked);
        }}
        onCancel={onClose}
      />
    );

  const entries: MenuEntry[] = [
    ...extra,
    ...choice.presets.map((preset, index): MenuEntry => ({
      id: preset.id,
      label: `${preset.label} · ${when(preset.at)}`,
      icon: "clock",
      ...(index === 0 && extra.length > 0 ? { divider: true } : {}),
      run: () => {
        onPick(preset.at);
      },
    })),
    ...(lastAt && lastAt.getTime() >= earliestSendAt(now.getTime())
      ? [
          {
            id: "last",
            label: `${s.lastPicked} · ${when(lastAt)}`,
            icon: "repeat" as const,
            run: () => {
              onPick(lastAt);
            },
          },
        ]
      : []),
    {
      id: "pick",
      label: s.pickTime,
      icon: "calendar",
      divider: true,
      run: () => {
        pickingRef.current = true;
        setPicking(true);
      },
    },
  ];
  return (
    <ContextMenu
      label={choice.title}
      title={choice.title}
      at={at}
      entries={entries}
      onClose={() => {
        // The menu closes before its entry runs: Pick keeps this open.
        queueMicrotask(() => {
          if (!pickingRef.current) onClose();
        });
      }}
    />
  );
}

/** `date` as the value of a date and a time field (local time). */
function fieldsOf(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/**
 * A date and time in local time: tomorrow at 08:00 to begin with (or the
 * mail's current time). It has to be a minute ahead; the time picked is
 * kept for next time (`remember`).
 */
export function TimeDialog({
  title,
  confirm,
  remember,
  current,
  onPick,
  onCancel,
}: {
  title: string;
  confirm: string;
  remember: keyof Pick<AppSettings, "lastSendLater" | "lastSnooze">;
  current?: string;
  onPick: (at: Date) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const s = t.schedule;
  const id = useId();
  const store = useUiStore();
  const [initial] = useState(() => {
    const start = current ? new Date(current) : new Date();
    if (!current) {
      start.setDate(start.getDate() + 1);
      start.setHours(8, 0, 0, 0);
    }
    return fieldsOf(start);
  });
  const [day, setDay] = useState(initial.day);
  const [time, setTime] = useState(initial.time);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const picked = new Date(`${day}T${time}`);
    if (
      Number.isNaN(picked.getTime()) ||
      picked.getTime() < earliestSendAt(Date.now())
    ) {
      setError(s.mustBeLater);
      return;
    }
    store.getState().updateSettings({ [remember]: picked.toISOString() });
    onPick(picked);
  };

  return (
    <Sheet labelledBy={`${id}-title`} onEscape={onCancel} size="md">
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {title}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor={`${id}-day`} className="block text-sm font-medium">
              {s.date}
            </label>
            <input
              id={`${id}-day`}
              type="date"
              data-initial-focus
              required
              value={day}
              onChange={(event) => {
                setDay(event.target.value);
                setError(null);
              }}
              className={`w-full ${FIELD}`}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-time`} className="block text-sm font-medium">
              {s.time}
            </label>
            <input
              id={`${id}-time`}
              type="time"
              required
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
                setError(null);
              }}
              className={`w-full ${FIELD}`}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={BUTTON}>
            {s.cancel}
          </button>
          <button type="submit" className={PRIMARY}>
            {confirm}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
