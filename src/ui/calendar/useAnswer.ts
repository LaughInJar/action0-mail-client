import { useCallback } from "react";
import type { CalendarEvent, Rsvp } from "../../core/calendar";
import { useRespond, type CalendarSource } from "../../data/calendar";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";
import { titleOf } from "./format";

/**
 * Answers an invitation at once (optimistic) with a toast; when there was
 * an answer before, the toast (and `z`) puts it back.
 */
export function useAnswer(): (
  source: CalendarSource,
  event: CalendarEvent,
  answer: Rsvp,
) => void {
  const respond = useRespond();
  const store = useUiStore();
  const t = useT();
  const { mutateAsync } = respond;
  return useCallback(
    (source, event, answer) => {
      if (event.myResponse === answer) return;
      const before = event.myResponse;
      const showError = (error: unknown) => {
        store.getState().showToast({
          message: `${t.calendar.couldntAnswer}: ${errorMessage(error, t)}`,
          tone: "error",
        });
      };
      mutateAsync({ source, event, response: answer }).catch(showError);
      store.getState().showToast({
        message: t.calendar.answered(answer, titleOf(event, t)),
        tone: "info",
        ...(before !== undefined && before !== "needsAction"
          ? {
              revert: () => {
                mutateAsync({
                  source,
                  event: { ...event, myResponse: answer },
                  response: before,
                }).catch(showError);
              },
            }
          : {}),
      });
    },
    [mutateAsync, store, t],
  );
}
