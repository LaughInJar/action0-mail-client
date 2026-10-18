import { useMemo } from "react";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useUiStore } from "../../state/context";
import type { MailActions } from "./useMailActions";

/** Keyboard shortcuts for mail actions. */
export function useActionCommands(actions: MailActions): void {
  const store = useUiStore();
  const commands = useMemo((): Command[] => {
    const group = "Actions";
    const hasTargets = () => actions.targets().length > 0;
    return [
      {
        id: "mail.archive",
        group,
        description: "Archive",
        keys: ["a"],
        when: () => actions.canArchive && hasTargets(),
        run: () => {
          actions.archive();
        },
      },
      {
        id: "mail.mark-read",
        group,
        description: "Mark as read",
        keys: ["shift+i"],
        when: () => actions.canSetSeen && hasTargets(),
        run: () => {
          actions.setSeen(true);
        },
      },
      {
        id: "mail.mark-unread",
        group,
        description: "Mark as unread",
        keys: ["shift+u"],
        when: () => actions.canSetSeen && hasTargets(),
        run: () => {
          actions.setSeen(false);
        },
      },
      {
        id: "mail.undo",
        group,
        description: "Undo",
        keys: ["z"],
        when: () => store.getState().toast?.undo !== undefined,
        run: () => {
          actions.undo();
        },
      },
    ];
  }, [actions, store]);
  useCommands(commands);
}
