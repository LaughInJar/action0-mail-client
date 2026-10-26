import { useMemo } from "react";
import type { MessageRef } from "../../core/ids";
import type { I18n } from "../../i18n/context";
import { useT } from "../../i18n/context";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useUiStore } from "../../state/context";
import type { ToolbarItem } from "../actions/mailActionItems";
import { useComposeActions } from "../composer/useComposeActions";
import { useAiSetUp } from "./useAi";

/** What the AI does from the reader: open its panel, or answer with it. */
export interface AiReaderActions {
  /** A service is set up (no AI buttons otherwise). */
  readonly ready: boolean;
  /** Opens the panel for a message or conversation (see `aiTarget`). */
  readonly open: (target: string, start: "summary" | "ask") => void;
  /** A reply with the composer's AI field open. */
  readonly reply: (message: MessageRef) => void;
}

/** See {@link AiReaderActions}. */
export function useAiReaderActions(): AiReaderActions {
  const ready = useAiSetUp().length > 0;
  const store = useUiStore();
  const compose = useComposeActions();
  return useMemo(
    () => ({
      ready,
      open: (target, start) => {
        store.getState().openAiPanel(target, start);
      },
      reply: (message) => {
        compose.reply(message, "reply", { ai: true });
      },
    }),
    [ready, store, compose],
  );
}

/**
 * Summarize (the first button to move into ⋯), and in the menu Ask and
 * Reply with AI (when the message can be answered); none until a service
 * is set up.
 */
export function aiItems(
  actions: AiReaderActions,
  target: string,
  answering: MessageRef | (() => MessageRef) | undefined,
  { phone }: { readonly phone: boolean },
  t: I18n,
): ToolbarItem[] {
  if (!actions.ready) return [];
  const reply: ToolbarItem[] =
    answering === undefined
      ? []
      : [
          {
            id: "ai-reply",
            label: t.ai.replyWithAi,
            icon: "reply",
            group: "answer",
            menuOnly: true,
            run: () => {
              actions.reply(
                typeof answering === "function" ? answering() : answering,
              );
            },
          },
        ];
  return [
    {
      id: "ai-summarize",
      label: t.ai.summarizeButton,
      icon: "sparkles",
      group: "mail",
      // Before Forward (1); on phones before the answers too.
      keep: phone ? -11 : 0,
      run: () => {
        actions.open(target, "summary");
      },
    },
    {
      id: "ai-ask",
      label: t.ai.askButton,
      icon: "message",
      group: "mail",
      menuOnly: true,
      run: () => {
        actions.open(target, "ask");
      },
    },
    ...reply,
  ];
}

/** `b` summarizes and `q` asks about what the reader shows. */
export function useAiCommands(
  actions: AiReaderActions,
  target: string | undefined,
): void {
  const t = useT();
  const commands = useMemo((): Command[] => {
    if (!actions.ready || target === undefined) return [];
    return [
      {
        id: "ai.summarize",
        group: "reading",
        description: t.shortcuts.summarize,
        keys: ["b"],
        run: () => {
          actions.open(target, "summary");
        },
      },
      {
        id: "ai.ask",
        group: "reading",
        description: t.shortcuts.askAi,
        keys: ["q"],
        run: () => {
          actions.open(target, "ask");
        },
      },
    ];
  }, [actions, target, t]);
  useCommands(commands);
}
