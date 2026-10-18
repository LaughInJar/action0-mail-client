import { useEffect, useRef } from "react";
import type { MessageId } from "../../core/ids";
import type { Message } from "../../core/model";

/** How long a message must be on screen before it counts as read. */
export const MARK_READ_DELAY_MS = 1500;

/**
 * Marks a message read once it has been shown for {@link MARK_READ_DELAY_MS},
 * so skimming with j/k doesn't mark everything you pass. Runs once per shown
 * message; if the message changes in the meantime (e.g. the user marked it
 * unread by hand), nothing happens.
 */
export function useMarkReadOnView(
  message: Message | undefined,
  markRead: (id: MessageId) => void,
): void {
  const latest = useRef({ message, markRead });
  useEffect(() => {
    latest.current = { message, markRead };
  });

  const id = message?.id;
  const loaded = message !== undefined;
  useEffect(() => {
    const shown = latest.current.message;
    if (!loaded || !shown || shown.flags.seen) return;
    const timer = setTimeout(() => {
      const { message: current, markRead: mark } = latest.current;
      // Untouched since it was shown (a manual change creates a new object).
      if (current === shown) mark(shown.id);
    }, MARK_READ_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [id, loaded]);
}
