import { useEffect, useMemo, useRef, useState } from "react";
import { messageKey } from "../../core/ids";
import type { SnoozedEntry } from "../../data/scheduled";
import { useT } from "../../i18n/context";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import type { MenuPosition } from "../../state/uiStore";
import type { MailActions } from "../actions/useMailActions";
import { formatSendAt } from "../common/format";
import { Icon } from "../common/Icon";
import { belowElement } from "../common/menuPosition";
import { SnoozeMenu } from "./SendLaterMenu";

/**
 * Above a snoozed message in the reader: when it comes back, with
 * Unsnooze and Change time (also as commands without keys, for the
 * command palette).
 */
export function SnoozedBanner({
  entry,
  actions,
}: {
  entry: SnoozedEntry;
  actions: MailActions;
}) {
  const t = useT();
  const z = t.snooze;
  const [menuAt, setMenuAt] = useState<MenuPosition | null>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const keys = [messageKey(entry.accountId, entry.message.id)];
  const unsnooze = () => {
    actions.unsnooze(keys, { exact: true });
  };
  const change = (at?: MenuPosition) => {
    actions.requestSnooze(at, keys, { exact: true });
  };
  useSnoozeCommands(unsnooze, change);
  const button =
    "rounded-md px-2.5 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900 pointer-coarse:min-h-11";
  return (
    <div
      role="status"
      className="mx-4 my-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 sm:mx-6 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <Icon name="clock" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 font-medium">
        {z.banner(
          formatSendAt(entry.message.snoozedUntil, { locale: t.locale }),
        )}
      </span>
      <span className="flex flex-wrap gap-1">
        <button type="button" className={button} onClick={unsnooze}>
          {z.unsnooze}
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
          {z.changeTime}
        </button>
      </span>
      {menuAt && (
        <SnoozeMenu
          at={menuAt}
          current={entry.message.snoozedUntil}
          onPick={(until) => {
            actions.snooze(until, keys, { exact: true });
          }}
          onClose={() => {
            setMenuAt(null);
          }}
        />
      )}
    </div>
  );
}

/** Unsnooze and Change time as commands without keys (the command palette lists them). */
function useSnoozeCommands(
  unsnooze: () => void,
  change: (at?: MenuPosition) => void,
) {
  const t = useT();
  const latest = useRef({ unsnooze, change });
  useEffect(() => {
    latest.current = { unsnooze, change };
  });
  useCommands(
    useMemo(
      (): Command[] => [
        {
          id: "snooze.unsnooze",
          group: "actions",
          description: t.snooze.commandUnsnooze,
          keys: [],
          run: () => {
            latest.current.unsnooze();
          },
        },
        {
          id: "snooze.change",
          group: "actions",
          description: t.snooze.commandChangeTime,
          keys: [],
          run: () => {
            latest.current.change();
          },
        },
      ],
      [t],
    ),
  );
}
