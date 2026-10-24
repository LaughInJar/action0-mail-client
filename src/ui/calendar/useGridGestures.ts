import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { PlacedEvent } from "../../data/calendar";
import type { MenuPosition } from "../../state/uiStore";
import { atPointer } from "../common/menuPosition";

/** A place in a grid: a shown day (0 = the first) and, in time grids, minutes into it. */
export interface GridSlot {
  readonly day: number;
  readonly minutes: number;
}

/** What a pointer is doing in a grid. */
export type Gesture =
  | { readonly kind: "create"; readonly from: GridSlot; readonly to: GridSlot }
  | {
      readonly kind: "move";
      readonly placed: PlacedEvent;
      readonly grab: GridSlot;
      readonly at: GridSlot;
    }
  | {
      readonly kind: "resize";
      readonly placed: PlacedEvent;
      readonly at: GridSlot;
    };

/** Options of {@link useGridGestures}. */
export interface GridGestureOptions {
  /** The slot under a point; `null` outside the grid. */
  readonly slotAt: (x: number, y: number) => GridSlot | null;
  /** The event a chip stands for (chips carry `data-event-key`). */
  readonly eventOf: (key: string) => PlacedEvent | undefined;
  /** The event can be moved (and resized). */
  readonly canDrag: (placed: PlacedEvent) => boolean;
  /** Empty space was clicked or tapped (`to` null), or dragged across. */
  readonly onCreate: (from: GridSlot, to: GridSlot | null) => void;
  readonly onMove: (placed: PlacedEvent, grab: GridSlot, at: GridSlot) => void;
  /** Events can change their length (time grids). */
  readonly onResize?: (placed: PlacedEvent, at: GridSlot) => void;
  /** A lifted event was let go where it was (touch): its menu. */
  readonly onMenu?: (placed: PlacedEvent, at: MenuPosition) => void;
  /** Scrolled while dragging near its top or bottom edge. */
  readonly scroller?: RefObject<HTMLElement | null>;
}

/** How long a touch has to stay to lift an event (or start a range), in ms. */
export const LONG_PRESS_MS = 400;
/** A mouse moving this far starts dragging (px). */
const MOUSE_SLOP = 4;
/** A touch moving this far before the long press is a swipe (px). */
const TOUCH_SLOP = 8;
/** Dragging this close to the scroller's edge scrolls it (px). */
const EDGE = 40;

interface Pending {
  readonly pointerId: number;
  readonly touch: boolean;
  readonly x: number;
  readonly y: number;
  readonly kind: Gesture["kind"];
  readonly placed: PlacedEvent | undefined;
  readonly grab: GridSlot;
  active: boolean;
  /** Moved since it was lifted (touch): a drag, not a press. */
  travelled: boolean;
  outside: boolean;
  last: { x: number; y: number };
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Pointer gestures of a calendar grid: dragging events to move them, their
 * bottom edge to change their length, and empty space to pick a range for
 * a new event (a click there suggests one). With a mouse a drag starts
 * after a few pixels; on touch after a long press, so swipes still scroll
 * (and an event lifted and let go without moving opens its menu). Escape,
 * or letting go outside the grid, cancels.
 */
export function useGridGestures(options: GridGestureOptions): {
  /** The gesture under way, to show where things go. */
  readonly gesture: Gesture | null;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const pending = useRef<Pending | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanup.current?.();
    },
    [],
  );

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (
      pending.current ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return;
    const target = event.target as Element;
    const { slotAt, eventOf, canDrag, onResize } = latest.current;
    const grab = slotAt(event.clientX, event.clientY);
    if (!grab) return;
    const chip = target.closest<HTMLElement>("[data-event-key]");
    const touch = event.pointerType !== "mouse";
    let kind: Gesture["kind"];
    let placed: PlacedEvent | undefined;
    if (chip) {
      placed = eventOf(chip.dataset.eventKey ?? "");
      if (!placed || !canDrag(placed)) return;
      const rect = chip.getBoundingClientRect();
      // The bottom edge resizes: a thin strip with a mouse, a bigger one by touch.
      const edge = touch ? Math.max(12, rect.height / 4) : 6;
      kind =
        onResize &&
        (target.closest("[data-resize]") !== null ||
          (touch && event.clientY > rect.bottom - edge))
          ? "resize"
          : "move";
    } else if (target.closest("button, a, input, [role='button']")) {
      return;
    } else kind = "create";

    const state: Pending = {
      pointerId: event.pointerId,
      touch,
      x: event.clientX,
      y: event.clientY,
      kind,
      placed,
      grab,
      active: false,
      travelled: false,
      outside: false,
      last: { x: event.clientX, y: event.clientY },
      timer: undefined,
    };
    pending.current = state;

    let frame = 0;
    const show = () => {
      const slot = latest.current.slotAt(state.last.x, state.last.y);
      state.outside = slot === null;
      if (!slot) return;
      setGesture(
        state.kind === "create"
          ? { kind: "create", from: state.grab, to: slot }
          : state.kind === "move" && state.placed
            ? { kind: "move", placed: state.placed, grab: state.grab, at: slot }
            : state.placed
              ? { kind: "resize", placed: state.placed, at: slot }
              : null,
      );
    };
    const activate = () => {
      state.active = true;
      if (state.touch && "vibrate" in navigator) navigator.vibrate(10);
      show();
    };
    // Near the scroller's edges, keep scrolling while the pointer stays.
    const scroll = () => {
      frame = 0;
      const scroller = latest.current.scroller?.current;
      if (!state.active || !scroller) return;
      const rect = scroller.getBoundingClientRect();
      const { y } = state.last;
      const speed =
        y < rect.top + EDGE
          ? -Math.ceil((rect.top + EDGE - y) / 4)
          : y > rect.bottom - EDGE
            ? Math.ceil((y - (rect.bottom - EDGE)) / 4)
            : 0;
      if (speed === 0 || y < rect.top - EDGE || y > rect.bottom + EDGE) return;
      scroller.scrollTop += speed;
      show();
      frame = requestAnimationFrame(scroll);
    };

    const finish = (commit: boolean) => {
      cleanup.current?.();
      const { active, outside } = state;
      if (!commit) return;
      const { onCreate, onMove, onResize: resize, onMenu } = latest.current;
      const slot = latest.current.slotAt(state.last.x, state.last.y);
      if (!active) {
        // A click or tap on empty space suggests a new event there.
        if (state.kind === "create") onCreate(state.grab, null);
        return;
      }
      // A drag ends in a click on what it started on: that's no click.
      const swallow = (click: Event) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => {
        window.removeEventListener("click", swallow, { capture: true });
      }, 0);
      // Lifted and let go in place: the event's menu.
      if (state.touch && !state.travelled && state.placed && onMenu) {
        onMenu(state.placed, atPointer({ clientX: state.x, clientY: state.y }));
        return;
      }
      if (outside || !slot) return;
      if (state.kind === "create") onCreate(state.grab, slot);
      else if (state.placed && state.kind === "move")
        onMove(state.placed, state.grab, slot);
      else if (state.placed && resize) resize(state.placed, slot);
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== state.pointerId) return;
      state.last = { x: move.clientX, y: move.clientY };
      const distance = Math.hypot(
        move.clientX - state.x,
        move.clientY - state.y,
      );
      if (!state.active) {
        if (state.touch) {
          // Moving before the long press: it's a swipe.
          if (distance > TOUCH_SLOP) finish(false);
          return;
        }
        if (distance <= MOUSE_SLOP) return;
        activate();
      }
      if (distance > TOUCH_SLOP) state.travelled = true;
      show();
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== state.pointerId) return;
      state.last = { x: up.clientX, y: up.clientY };
      // A touch that lifts before the long press is a tap: only empty space reacts.
      finish(true);
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === state.pointerId) finish(false);
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !state.active) return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    };
    // While something is lifted, a moving finger drags instead of scrolling.
    const onTouchMove = (touchMove: TouchEvent) => {
      if (state.active && touchMove.cancelable) touchMove.preventDefault();
    };
    const onContextMenu = (menu: Event) => {
      if (state.touch) menu.preventDefault();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("contextmenu", onContextMenu);
    if (touch) state.timer = setTimeout(activate, LONG_PRESS_MS);
    cleanup.current = () => {
      cleanup.current = null;
      clearTimeout(state.timer);
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("contextmenu", onContextMenu);
      pending.current = null;
      setGesture(null);
    };
  }, []);

  return { gesture, onPointerDown };
}

/** Rounds minutes to the nearest quarter hour. */
export function snap(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}
