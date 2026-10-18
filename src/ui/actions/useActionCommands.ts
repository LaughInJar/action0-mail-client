import { useMemo } from "react";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import type { Undo } from "./useUndo";
import type { MailActions } from "./useMailActions";
import { useT } from "../../i18n/context";

/** Keyboard shortcuts for mail actions; `undo` is the app's combined undo. */
export function useActionCommands(actions: MailActions, undo: Undo): void {
  const t = useT();
  const commands = useMemo((): Command[] => {
    const group = "actions";
    const s = t.shortcuts;
    const hasTargets = () => actions.targets().length > 0;
    // Inside Trash and Spam, messages can only be restored or deleted.
    const quarantined = actions.view === "trash" || actions.view === "junk";
    return [
      {
        id: "mail.archive",
        group,
        description: s.archive,
        keys: ["a"],
        when: () => actions.canArchive && hasTargets(),
        run: () => {
          actions.archive();
        },
      },
      {
        id: "mail.mark-read",
        group,
        description: s.markRead,
        keys: ["shift+i"],
        when: () => actions.canSetSeen && hasTargets(),
        run: () => {
          actions.setSeen(true);
        },
      },
      {
        id: "mail.mark-unread",
        group,
        description: s.markUnread,
        keys: ["shift+u"],
        when: () => actions.canSetSeen && hasTargets(),
        run: () => {
          actions.setSeen(false);
        },
      },
      {
        id: "mail.move",
        group,
        description: s.moveTo,
        keys: ["v"],
        when: () => actions.canMove && !quarantined && hasTargets(),
        run: () => {
          actions.openPicker("move");
        },
      },
      {
        id: "mail.labels",
        group,
        description: s.labels,
        keys: ["l"],
        when: () => actions.canLabel && !quarantined && hasTargets(),
        run: () => {
          actions.openPicker("labels");
        },
      },
      {
        id: "mail.star",
        group,
        description: s.star,
        keys: ["s"],
        when: () => actions.canStar && hasTargets(),
        run: () => {
          actions.toggleStar();
        },
      },
      {
        id: "mail.trash",
        group,
        description:
          actions.view === "trash" ? s.restoreFromTrash : s.moveToTrash,
        keys: ["Delete", "Backspace"],
        when: () => actions.canTrash && hasTargets(),
        run: () => {
          actions.trash();
        },
      },
      {
        id: "mail.spam",
        group,
        description: actions.view === "junk" ? s.notSpam : s.reportSpam,
        keys: ["shift+s"],
        when: () => actions.canSpam && hasTargets(),
        run: () => {
          actions.spam();
        },
      },
      {
        id: "mail.delete-forever",
        group,
        description: s.deleteForever,
        keys: ["shift+Delete", "shift+Backspace"],
        when: () => actions.canDeleteForever && quarantined && hasTargets(),
        run: () => {
          actions.requestDeleteForever();
        },
      },
      {
        id: "mail.undo",
        group,
        description: s.undo,
        keys: ["z"],
        when: undo.canUndo,
        run: undo.undo,
      },
    ];
  }, [actions, undo, t]);
  useCommands(commands);
}
