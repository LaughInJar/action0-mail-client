import { useMemo } from "react";
import { messageRef, type MessageRef } from "../../core/ids";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useRouter, useUiStore } from "../../state/context";
import type { ComposeActions } from "./useComposeActions";
import { useT } from "../../i18n/context";

/** Shortcuts for writing: `c` compose, `r` reply, `Shift+R` reply all, `f` forward. */
export function useComposeCommands(actions: ComposeActions): void {
  const store = useUiStore();
  const router = useRouter();
  const t = useT();
  const commands = useMemo((): Command[] => {
    const group = "writing";
    /**
     * The message to answer: the one at the open conversation's cursor, else
     * the one shown in the reader (or under the cursor), of its account.
     */
    const current = (): MessageRef | undefined => {
      const { readerCursor, focusedId } = store.getState();
      const route = router.getRoute();
      const focused = focusedId === null ? undefined : messageRef(focusedId);
      const accountId = focused?.accountId ?? route?.accountId;
      const messageId = readerCursor ?? focused?.messageId ?? route?.messageId;
      return accountId === undefined || messageId === undefined
        ? undefined
        : { accountId, messageId };
    };
    const withMessage = (run: (message: MessageRef) => void) => () => {
      const message = current();
      if (message !== undefined) run(message);
    };
    // In the calendar, `c` makes an event and there's no message to answer.
    const inMail = () => router.getCalendarRoute() === null;
    const canAnswer = () => inMail() && current() !== undefined;
    return [
      {
        id: "compose.new",
        group,
        description: t.shortcuts.compose,
        keys: ["c"],
        when: () => inMail() && actions.canCompose,
        run: actions.compose,
      },
      {
        id: "compose.reply",
        group,
        description: t.shortcuts.reply,
        keys: ["r"],
        when: canAnswer,
        run: withMessage((message) => {
          actions.reply(message, "reply");
        }),
      },
      {
        id: "compose.reply-all",
        group,
        description: t.shortcuts.replyAll,
        keys: ["shift+r"],
        when: canAnswer,
        run: withMessage((message) => {
          actions.reply(message, "reply-all");
        }),
      },
      {
        id: "compose.forward",
        group,
        description: t.shortcuts.forward,
        keys: ["f"],
        when: canAnswer,
        run: withMessage(actions.forward),
      },
    ];
  }, [actions, router, store, t]);
  useCommands(commands);
}
