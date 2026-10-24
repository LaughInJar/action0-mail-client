import { useCallback } from "react";
import { useUiStore } from "../../state/context";
import type { QuestionState } from "../../state/eventForm";

/** A question to ask: {@link QuestionState} without its callback. */
export type Question = Omit<QuestionState, "resolve">;

/**
 * Asks a question in a dialog; resolves to the chosen option's value, or
 * `null` when it's cancelled. A new question cancels the one before.
 */
export function useAsk(): (question: Question) => Promise<string | null> {
  const store = useUiStore();
  return useCallback(
    (question) =>
      new Promise((resolve) => {
        store.getState().question?.resolve(null);
        store.getState().setQuestion({ ...question, resolve });
      }),
    [store],
  );
}
