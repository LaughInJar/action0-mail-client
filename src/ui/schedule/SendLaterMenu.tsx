import { useId, useRef, useState } from "react";
import { earliestSendAt, sendLaterPresets } from "../../core/schedule";
import { useT } from "../../i18n/context";
import { useUi, useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { formatSendAt } from "../common/format";
import { BUTTON, FIELD, PRIMARY } from "../common/formStyles";
import { Sheet } from "../common/Sheet";

/** Props of {@link SendLaterMenu}. */
export interface SendLaterMenuProps {
  readonly at: MenuPosition;
  /** Entries before the times (Send now, Don't schedule). */
  readonly extra?: readonly MenuEntry[];
  /** The time the picker starts from (a scheduled mail's), ISO. */
  readonly current?: string;
  readonly onPick: (sendAt: Date) => void;
  readonly onClose: () => void;
}

/**
 * Send later's times: the presets that fit the day, the time picked last
 * (if it's still ahead), and Pick date & time…, which opens a small dialog.
 */
export function SendLaterMenu({
  at,
  extra = [],
  current,
  onPick,
  onClose,
}: SendLaterMenuProps) {
  const t = useT();
  const s = t.schedule;
  const last = useUi((state) => state.settings.lastSendLater);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const now = new Date();
  const when = (date: Date) =>
    formatSendAt(date.toISOString(), { locale: t.locale, now });
  const lastAt = last ? new Date(last) : undefined;

  if (picking)
    return (
      <SendLaterDialog
        {...(current ? { current } : {})}
        onPick={(sendAt) => {
          onClose();
          onPick(sendAt);
        }}
        onCancel={onClose}
      />
    );

  const entries: MenuEntry[] = [
    ...extra,
    ...sendLaterPresets(now).map((preset, index): MenuEntry => ({
      id: preset.kind,
      label: `${s.presets[preset.kind]} · ${when(preset.at)}`,
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
      label={s.sendLater}
      title={s.sendLater}
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
 * The date and time a mail goes out, in local time: tomorrow at 08:00 to
 * begin with (or the mail's current time). It has to be a minute ahead.
 */
export function SendLaterDialog({
  current,
  onPick,
  onCancel,
}: {
  current?: string;
  onPick: (sendAt: Date) => void;
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
    const sendAt = new Date(`${day}T${time}`);
    if (
      Number.isNaN(sendAt.getTime()) ||
      sendAt.getTime() < earliestSendAt(Date.now())
    ) {
      setError(s.mustBeLater);
      return;
    }
    store.getState().updateSettings({ lastSendLater: sendAt.toISOString() });
    onPick(sendAt);
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
          {s.pickTitle}
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
            {s.schedule}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
