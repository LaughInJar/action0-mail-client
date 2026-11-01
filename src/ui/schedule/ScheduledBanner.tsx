import { useEffect, useMemo, useRef, useState } from "react";
import type { ScheduledEntry } from "../../core/schedule";
import { useT } from "../../i18n/context";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import type { MenuPosition } from "../../state/uiStore";
import { useUi } from "../../state/context";
import { formatSendAt } from "../common/format";
import { Icon } from "../common/Icon";
import { belowElement } from "../common/menuPosition";
import { SendLaterDialog, SendLaterMenu } from "./SendLaterMenu";
import { useScheduleActions, type ScheduleActions } from "./useScheduleActions";

/**
 * Above a scheduled mail in the reader: when it goes out and who sends
 * it, with Send now, Change time, Edit and Cancel send (also as commands
 * without keys, for the command palette).
 */
export function ScheduledBanner({ entry }: { entry: ScheduledEntry }) {
  const t = useT();
  const s = t.schedule;
  const actions = useScheduleActions();
  const [menuAt, setMenuAt] = useState<MenuPosition | null>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  useScheduleCommands(actions, entry);
  const button =
    "rounded-md px-2.5 py-1 font-medium hover:bg-blue-100 dark:hover:bg-blue-900 pointer-coarse:min-h-11";
  return (
    <div
      role="status"
      className="mx-4 my-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950 sm:mx-6 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
    >
      <Icon name="clock" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">
          {s.banner(formatSendAt(entry.message.sendAt, { locale: t.locale }))}
        </span>{" "}
        {entry.scheduling === "held" ? s.bannerHeld : s.bannerDrafts}
      </span>
      <span className="flex flex-wrap gap-1">
        <button
          type="button"
          className={button}
          onClick={() => {
            actions.sendNow(entry);
          }}
        >
          {s.sendNow}
        </button>
        <button
          ref={changeRef}
          type="button"
          aria-haspopup="menu"
          className={button}
          onClick={() => {
            if (changeRef.current) setMenuAt(belowElement(changeRef.current));
          }}
        >
          {s.changeTime}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => {
            actions.edit(entry);
          }}
        >
          {s.edit}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => {
            actions.cancel(entry);
          }}
        >
          {s.cancelSend}
        </button>
      </span>
      {menuAt && (
        <SendLaterMenu
          at={menuAt}
          current={entry.message.sendAt}
          onPick={(sendAt) => {
            actions.reschedule(entry, sendAt);
          }}
          onClose={() => {
            setMenuAt(null);
          }}
        />
      )}
    </div>
  );
}

/** The scheduled mail's actions as commands without keys (the command palette lists them). */
function useScheduleCommands(actions: ScheduleActions, entry: ScheduledEntry) {
  const t = useT();
  // The entry is a new object with every render: the latest one acts.
  const latest = useRef(entry);
  useEffect(() => {
    latest.current = entry;
  });
  const key = `${entry.accountId}|${entry.message.id}`;
  useCommands(
    useMemo((): Command[] => {
      const s = t.schedule;
      return [
        {
          id: "schedule.send-now",
          group: "actions",
          description: s.commandSendNow,
          keys: [],
          run: () => {
            actions.sendNow(latest.current);
          },
        },
        {
          id: "schedule.change",
          group: "actions",
          description: s.commandChangeTime,
          keys: [],
          run: () => {
            actions.pickTime(latest.current);
          },
        },
        {
          id: "schedule.edit",
          group: "actions",
          description: s.commandEdit,
          keys: [],
          run: () => {
            actions.edit(latest.current);
          },
        },
        {
          id: "schedule.cancel",
          group: "actions",
          description: s.commandCancel,
          keys: [],
          run: () => {
            actions.cancel(latest.current);
          },
        },
      ];
      // A command set per scheduled mail.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [actions, key, t]),
  );
}

/** Change time from a menu or the command palette: the date and time dialog. */
export function SendLaterHost() {
  const entry = useUi((state) => state.sendLaterFor);
  const setFor = useUi((state) => state.setSendLaterFor);
  const actions = useScheduleActions();
  if (!entry) return null;
  return (
    <SendLaterDialog
      current={entry.message.sendAt}
      onPick={(sendAt) => {
        setFor(null);
        actions.reschedule(entry, sendAt);
      }}
      onCancel={() => {
        setFor(null);
      }}
    />
  );
}
