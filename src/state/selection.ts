import type { MessageKey } from "../core/ids";

/**
 * Focus and selection in the message list, by {@link MessageKey} (rows
 * of All inboxes come from several accounts).
 *
 * - `focusedId` is the cursor: the message shown in the reader.
 * - `selectedIds` is the multi-selection. When it is empty, actions apply to
 *   the focused message.
 * - `anchorId` is where Shift-range selection starts.
 */
export interface SelectionState {
  readonly focusedId: MessageKey | null;
  readonly selectedIds: ReadonlySet<MessageKey>;
  readonly anchorId: MessageKey | null;
}

export const EMPTY_SELECTION: SelectionState = {
  focusedId: null,
  selectedIds: new Set(),
  anchorId: null,
};

/** Plain click / tap: show this message and drop any multi-selection. */
export function focusOnly(
  _state: SelectionState,
  id: MessageKey,
): SelectionState {
  return { focusedId: id, selectedIds: new Set(), anchorId: id };
}

/** Moves the cursor (keyboard navigation). Keeps the selection. */
export function moveFocus(
  state: SelectionState,
  orderedIds: readonly MessageKey[],
  delta: number,
): SelectionState {
  // Nothing open after a removal ("back to the list"): continue from there.
  const resume =
    state.focusedId === null &&
    state.anchorId !== null &&
    orderedIds.includes(state.anchorId)
      ? state.anchorId
      : null;
  const target =
    resume === null
      ? neighbour(state.focusedId, orderedIds, delta)
      : delta > 0
        ? resume
        : neighbour(resume, orderedIds, delta);
  if (target === undefined) return state;
  return { ...state, focusedId: target, anchorId: target };
}

/** Moves the cursor to an absolute position (Home/End). Keeps the selection. */
export function focusAt(
  state: SelectionState,
  orderedIds: readonly MessageKey[],
  index: number,
): SelectionState {
  const target = orderedIds.at(index);
  if (target === undefined) return state;
  return { ...state, focusedId: target, anchorId: target };
}

/** Ctrl/Cmd-click, `x`, or a tap in selection mode: toggles one message. */
export function toggle(state: SelectionState, id: MessageKey): SelectionState {
  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  return { focusedId: id, selectedIds, anchorId: id };
}

/**
 * Shift-click: selects the range from the anchor to `id`, replacing the
 * previous selection.
 */
export function selectRange(
  state: SelectionState,
  orderedIds: readonly MessageKey[],
  id: MessageKey,
): SelectionState {
  const anchor = state.anchorId ?? state.focusedId ?? id;
  return {
    focusedId: id,
    selectedIds: new Set(range(orderedIds, anchor, id)),
    anchorId: anchor,
  };
}

/** Shift+j / Shift+↓: moves the cursor and extends the range selection to it. */
export function extendFocus(
  state: SelectionState,
  orderedIds: readonly MessageKey[],
  delta: number,
): SelectionState {
  const target = neighbour(state.focusedId, orderedIds, delta);
  if (target === undefined) return state;
  const anchor = state.anchorId ?? state.focusedId ?? target;
  return {
    focusedId: target,
    selectedIds: new Set(range(orderedIds, anchor, target)),
    anchorId: anchor,
  };
}

/** Esc / "Done": clears the multi-selection, keeps the cursor. */
export function clearSelection(state: SelectionState): SelectionState {
  return { ...state, selectedIds: new Set(), anchorId: state.focusedId };
}

function neighbour(
  current: MessageKey | null,
  orderedIds: readonly MessageKey[],
  delta: number,
): MessageKey | undefined {
  if (orderedIds.length === 0) return undefined;
  const index = current === null ? -1 : orderedIds.indexOf(current);
  if (index === -1) return orderedIds[0];
  const next = Math.min(orderedIds.length - 1, Math.max(0, index + delta));
  return orderedIds[next];
}

function range(
  orderedIds: readonly MessageKey[],
  from: MessageKey,
  to: MessageKey,
): MessageKey[] {
  const start = orderedIds.indexOf(from);
  const end = orderedIds.indexOf(to);
  if (start === -1 || end === -1) return [to];
  const [low, high] = start <= end ? [start, end] : [end, start];
  return orderedIds.slice(low, high + 1);
}

/**
 * Where the cursor goes when `removed` messages leave the list. Going
 * `below` (the default): the first remaining message below the lowest
 * removed one, otherwise the nearest one above. Going `above`: the first
 * remaining one above the highest removed one, otherwise the nearest one
 * below. Otherwise nothing.
 */
export function nextAfterRemoval(
  orderedIds: readonly MessageKey[],
  removed: ReadonlySet<MessageKey>,
  direction: "below" | "above" = "below",
): MessageKey | null {
  const indices = orderedIds.flatMap((id, index) =>
    removed.has(id) ? [index] : [],
  );
  const first = indices[0];
  const last = indices.at(-1);
  if (first === undefined || last === undefined) return null;
  const remaining = (from: number, step: 1 | -1) => {
    for (let i = from; i >= 0 && i < orderedIds.length; i += step) {
      const id = orderedIds[i];
      if (id !== undefined && !removed.has(id)) return id;
    }
    return null;
  };
  return direction === "below"
    ? (remaining(last + 1, 1) ?? remaining(last - 1, -1))
    : (remaining(first - 1, -1) ?? remaining(first + 1, 1));
}

/**
 * Messages left the list: they drop out of the selection, and if the cursor
 * was on one of them it moves to `next`. The rest of the selection stays.
 */
export function removeFromList(
  state: SelectionState,
  removed: ReadonlySet<MessageKey>,
  next: MessageKey | null,
  { open = true }: { open?: boolean } = {},
): SelectionState {
  const selectedIds = new Set(
    [...state.selectedIds].filter((id) => !removed.has(id)),
  );
  const focusLeft = state.focusedId !== null && removed.has(state.focusedId);
  // Not opening `next` ("back to the list"): j/k continue from it.
  const focusedId = focusLeft ? (open ? next : null) : state.focusedId;
  const anchorId =
    focusLeft && !open
      ? next
      : state.anchorId !== null && removed.has(state.anchorId)
        ? focusedId
        : state.anchorId;
  return { focusedId, selectedIds, anchorId };
}
