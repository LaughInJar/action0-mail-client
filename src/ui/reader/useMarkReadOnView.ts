import { useEffect, useRef } from "react";
import type { MessageId } from "../../core/ids";
import type { Message } from "../../core/model";

/**
 * Marks a message read once it has been shown for `delayMs` (by default
 * 1.5 s, so skimming with j/k doesn't mark everything you pass; `null`:
 * never). Runs once per shown message; if the message changes in the
 * meantime (e.g. the user marked it unread by hand), nothing happens.
 */
export function useMarkReadOnView(
  message: Message | undefined,
  markRead: (id: MessageId) => void,
  delayMs: number | null,
): void {
  const latest = useRef({ message, markRead });
  useEffect(() => {
    latest.current = { message, markRead };
  });

  const id = message?.id;
  const loaded = message !== undefined;
  useEffect(() => {
    const shown = latest.current.message;
    if (delayMs === null || !loaded || !shown || shown.flags.seen) return;
    const timer = setTimeout(() => {
      const { message: current, markRead: mark } = latest.current;
      // Untouched since it was shown (a manual change creates a new object).
      if (current === shown) mark(shown.id);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [id, loaded, delayMs]);
}
