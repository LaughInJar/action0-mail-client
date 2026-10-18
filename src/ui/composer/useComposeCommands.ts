import { useMemo } from "react";
import type { MessageId } from "../../core/ids";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useRouter, useUiStore } from "../../state/context";
import type { ComposeActions } from "./useComposeActions";

/** Shortcuts for writing: `c` compose, `r` reply, `Shift+R` reply all, `f` forward. */
export function useComposeCommands(actions: ComposeActions): void {
  const store = useUiStore();
  const router = useRouter();
  const commands = useMemo((): Command[] => {
    const group = "Writing";
    /** The message shown in the reader (or under the cursor). */
    const current = (): MessageId | undefined =>
      store.getState().focusedId ?? router.getRoute()?.messageId;
    const withMessage = (run: (id: MessageId) => void) => () => {
      const id = current();
      if (id !== undefined) run(id);
    };
    const canAnswer = () => actions.canCompose && current() !== undefined;
    return [
      {
        id: "compose.new",
        group,
        description: "Write a new mail",
        keys: ["c"],
        when: () => actions.canCompose,
        run: actions.compose,
      },
      {
        id: "compose.reply",
        group,
        description: "Reply",
        keys: ["r"],
        when: canAnswer,
        run: withMessage((id) => {
          actions.reply(id, "reply");
        }),
      },
      {
        id: "compose.reply-all",
        group,
        description: "Reply all",
        keys: ["shift+r"],
        when: canAnswer,
        run: withMessage((id) => {
          actions.reply(id, "reply-all");
        }),
      },
      {
        id: "compose.forward",
        group,
        description: "Forward",
        keys: ["f"],
        when: canAnswer,
        run: withMessage(actions.forward),
      },
    ];
  }, [actions, router, store]);
  useCommands(commands);
}
