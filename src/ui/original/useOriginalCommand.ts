import { useMemo } from "react";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useT } from "../../i18n/context";
import { useRouter, useUiStore } from "../../state/context";
import { currentMessage } from "../actions/currentMessage";
import type { OriginalActions } from "./originalActions";

/**
 * Ctrl/⌘+U shows the original of the current message (like Thunderbird's
 * "Message source"; the browser's view-source is no use in this app).
 */
export function useOriginalCommand(actions: OriginalActions): void {
  const store = useUiStore();
  const router = useRouter();
  const t = useT();
  const commands = useMemo((): Command[] => {
    const target = () =>
      router.getCalendarRoute() === null
        ? currentMessage(store, router)
        : undefined;
    return [
      {
        id: "reader.original",
        group: "reading",
        description: t.shortcuts.showOriginal,
        keys: ["ctrl+u", "meta+u"],
        when: () => {
          const message = target();
          return message !== undefined && actions.canShow(message.accountId);
        },
        run: () => {
          const message = target();
          if (message) actions.show(message);
        },
      },
    ];
  }, [actions, router, store, t]);
  useCommands(commands);
}
