import type { PlacedEvent } from "../../data/calendar";
import { useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { eventKey } from "./format";

/** Opens the context menu of a calendar event (CalendarApp shows it). */
export function useOpenEventMenu(): (
  placed: PlacedEvent,
  at: MenuPosition,
) => void {
  const store = useUiStore();
  return (placed, at) => {
    store
      .getState()
      .setContextMenu({ kind: "event", eventKey: eventKey(placed), at });
  };
}
