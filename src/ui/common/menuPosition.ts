import type { MenuPosition } from "../../state/uiStore";

/** A context menu at the pointer (right-click, long press). */
export function atPointer(event: {
  readonly clientX: number;
  readonly clientY: number;
}): MenuPosition {
  return { x: event.clientX, y: event.clientY, flipY: event.clientY };
}

/** A context menu below an element (keyboard: the Menu key, Shift+F10). */
export function belowElement(element: Element): MenuPosition {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + 24, y: rect.bottom, flipY: rect.top };
}

/** The key that opens a context menu from the keyboard: Menu, or Shift+F10. */
export function isMenuKey(event: {
  readonly key: string;
  readonly shiftKey: boolean;
}): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

/**
 * Whether a right-click should open the app's menu: Shift+right-click
 * keeps the browser's own (to copy or inspect).
 */
export function wantsAppMenu(event: { readonly shiftKey: boolean }): boolean {
  return !event.shiftKey;
}

/**
 * A menu opened by a key without a button to hang from: below the focused
 * element (a list row, the reader), else near the middle of the screen.
 */
export function positionNearFocus(): MenuPosition {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== document.body)
    return belowElement(focused);
  const x = Math.round(window.innerWidth / 2 - 120);
  const y = Math.round(window.innerHeight / 3);
  return { x, y, flipY: y };
}
