import { useCallback, useMemo } from "react";
import type { AccountId, MessageId } from "../../core/ids";
import type { I18n } from "../../i18n/context";
import { useT } from "../../i18n/context";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useUiStore } from "../../state/context";
import type { PrintJob } from "../../state/uiStore";
import type { ToolbarItem } from "../actions/mailActionItems";

/** Starts printing messages of an account (the print layout, then the dialog). */
export function usePrint(): (job: PrintJob) => void {
  const store = useUiStore();
  return useCallback(
    (job) => {
      // A copy, so printing the same thing again is a new job.
      store.getState().setPrintJob({ ...job });
    },
    [store],
  );
}

/** What a print entry prints: a job, or how to make one when it's chosen. */
export type PrintTarget = PrintJob | (() => PrintJob | undefined);

const jobOf = (target: PrintTarget) =>
  typeof target === "function" ? target() : target;

/** The "Print" entry of the reader's ⋯ menu and the message menus. */
export function printItems(
  print: (job: PrintJob) => void,
  target: PrintTarget,
  t: I18n,
): ToolbarItem[] {
  return [
    {
      id: "print",
      label: t.reader.print,
      icon: "printer",
      menuOnly: true,
      group: "mail",
      run: () => {
        const job = jobOf(target);
        if (job) print(job);
      },
    },
  ];
}

/**
 * Ctrl/⌘+P prints what the reader shows (a message, or the conversation)
 * instead of the browser printing the app's screen. Only while something
 * is open; otherwise the browser's own printing stays.
 */
export function usePrintCommand(target: PrintJob | undefined): void {
  const print = usePrint();
  const t = useT();
  useCommands(
    useMemo(
      (): Command[] =>
        target
          ? [
              {
                id: "reader.print",
                group: "reading",
                description: t.shortcuts.print,
                keys: ["ctrl+p", "meta+p"],
                run: (event) => {
                  event.preventDefault();
                  print(target);
                },
              },
            ]
          : [],
      [target, print, t],
    ),
  );
}

/** A job for messages of an account, named after the first one's subject. */
export function printJob(
  accountId: AccountId,
  messageIds: readonly MessageId[],
  subject: string,
): PrintJob {
  return { accountId, messageIds, title: subject };
}
