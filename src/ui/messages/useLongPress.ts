import { useRef, type MouseEvent, type PointerEvent } from "react";

/** Options of {@link useLongPress}. */
export interface LongPressOptions {
  /** Press duration that counts as a long press. */
  readonly delayMs?: number;
  /** Movement (px) that cancels the press, so scrolling doesn't select. */
  readonly tolerancePx?: number;
}

/**
 * Detects long presses by touch or pen (mouse users have Ctrl/Shift-click).
 * Spread the returned handlers on an element; call `consumeClick()` in its
 * click handler to swallow the click that ends a long press.
 */
export function useLongPress(
  onLongPress: (target: EventTarget) => void,
  { delayMs = 500, tolerancePx = 10 }: LongPressOptions = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
  };

  return {
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      if (event.pointerType === "mouse") return;
      cancel();
      start.current = { x: event.clientX, y: event.clientY };
      const target = event.target;
      timer.current = setTimeout(() => {
        fired.current = true;
        timer.current = undefined;
        onLongPress(target);
      }, delayMs);
    },
    onPointerMove: (event: PointerEvent) => {
      const origin = start.current;
      if (!origin) return;
      if (
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
        tolerancePx
      )
        cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    /** Suppresses the long-press context menu on mobile browsers. */
    onContextMenu: (event: MouseEvent) => {
      if (fired.current || timer.current !== undefined) event.preventDefault();
    },
    /** True (once) if the current click ends a long press. */
    consumeClick: (): boolean => {
      const wasLongPress = fired.current;
      fired.current = false;
      return wasLongPress;
    },
  };
}
