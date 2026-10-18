import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * While `active`, keeps Tab focus inside `ref`, focuses its first focusable
 * element, calls `onEscape` on Escape, and restores the previous focus when
 * it ends.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables()[0] ?? container).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escape.current) {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [ref, active]);
}
