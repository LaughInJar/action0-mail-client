// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type MessageKey } from "../core/ids";
import {
  clearSelection,
  EMPTY_SELECTION,
  extendFocus,
  focusAt,
  focusOnly,
  moveFocus,
  nextAfterRemoval,
  removeFromList,
  selectRange,
  toggle,
  type SelectionState,
} from "./selection";

const ids = ["a", "b", "c", "d", "e"].map((id) => id as MessageKey);
const [a, b, c, d] = ids as [
  MessageKey,
  MessageKey,
  MessageKey,
  MessageKey,
  MessageKey,
];
const selected = (state: SelectionState) => [...state.selectedIds].sort();

describe("selection", () => {
  it("moves the cursor within bounds and keeps the selection", () => {
    let state = toggle(EMPTY_SELECTION, a);
    state = moveFocus(state, ids, 1);
    expect(state.focusedId).toBe(b);
    expect(selected(state)).toEqual([a]);
    expect(moveFocus(focusOnly(state, a), ids, -1).focusedId).toBe(a);
    expect(moveFocus(EMPTY_SELECTION, ids, 1).focusedId).toBe(a);
    expect(moveFocus(EMPTY_SELECTION, [], 1)).toBe(EMPTY_SELECTION);
  });

  it("jumps to the first and last message", () => {
    expect(focusAt(EMPTY_SELECTION, ids, 0).focusedId).toBe(a);
    expect(focusAt(EMPTY_SELECTION, ids, -1).focusedId).toBe("e");
  });

  it("plain click focuses and drops the multi-selection", () => {
    const state = focusOnly(toggle(toggle(EMPTY_SELECTION, a), b), c);
    expect(state).toEqual({
      focusedId: c,
      selectedIds: new Set(),
      anchorId: c,
    });
  });

  it("toggles single messages", () => {
    let state = toggle(EMPTY_SELECTION, b);
    state = toggle(state, d);
    expect(selected(state)).toEqual([b, d]);
    expect(selected(toggle(state, b))).toEqual([d]);
  });

  it("selects ranges from the anchor in either direction", () => {
    const anchored = focusOnly(EMPTY_SELECTION, b);
    expect(selected(selectRange(anchored, ids, d))).toEqual([b, c, d]);
    const back = selectRange(selectRange(anchored, ids, d), ids, a);
    expect(selected(back)).toEqual([a, b]);
    expect(back.anchorId).toBe(b);
  });

  it("extends the selection with the cursor", () => {
    let state = focusOnly(EMPTY_SELECTION, b);
    state = extendFocus(state, ids, 1);
    state = extendFocus(state, ids, 1);
    expect(state.focusedId).toBe(d);
    expect(selected(state)).toEqual([b, c, d]);
    state = extendFocus(state, ids, -1);
    expect(selected(state)).toEqual([b, c]);
  });

  it("clears the selection but keeps the cursor", () => {
    const state = clearSelection(
      selectRange(focusOnly(EMPTY_SELECTION, a), ids, c),
    );
    expect(state.focusedId).toBe(c);
    expect(state.selectedIds.size).toBe(0);
  });
});

describe("nextAfterRemoval", () => {
  const set = (...items: string[]) =>
    new Set(items.map((id) => id as MessageKey));

  it("takes the next message below the last removed one", () => {
    expect(nextAfterRemoval(ids, set("b"))).toBe("c");
    expect(nextAfterRemoval(ids, set("b", "c"))).toBe("d");
    expect(nextAfterRemoval(ids, set("a", "c"))).toBe("d");
  });

  it("goes up instead when asked to", () => {
    expect(nextAfterRemoval(ids, set("c"), "above")).toBe("b");
    expect(nextAfterRemoval(ids, set("b", "d"), "above")).toBe("a");
    expect(nextAfterRemoval(ids, set("a"), "above")).toBe("b");
  });

  it("falls back to the one above at the end, and to nothing when all are gone", () => {
    expect(nextAfterRemoval(ids, set("e"))).toBe("d");
    expect(nextAfterRemoval(ids, set("d", "e"))).toBe("c");
    expect(nextAfterRemoval(ids, set("a", "b", "c", "d", "e"))).toBeNull();
    expect(nextAfterRemoval(ids, set("x"))).toBeNull();
  });
});

describe("removeFromList", () => {
  const set = (...items: string[]) =>
    new Set(items.map((id) => id as MessageKey));

  it("keeps the rest of the selection and the cursor when other rows leave", () => {
    const state = { focusedId: a, selectedIds: set("a", "b"), anchorId: a };
    expect(removeFromList(state, set("d"), null)).toEqual(state);
  });

  it("can close the message, so j and k continue from the next one", () => {
    const state = { focusedId: b, selectedIds: set(), anchorId: b };
    const closed = removeFromList(state, set("b"), c, { open: false });
    expect(closed).toEqual({
      focusedId: null,
      selectedIds: set(),
      anchorId: c,
    });
    const rest = ids.filter((id) => id !== b);
    expect(moveFocus(closed, rest, 1).focusedId).toBe(c);
    expect(moveFocus(closed, rest, -1).focusedId).toBe(a);
  });

  it("drops removed rows from the selection and moves a removed cursor", () => {
    const state = { focusedId: b, selectedIds: set("a", "b"), anchorId: b };
    expect(removeFromList(state, set("b"), c)).toEqual({
      focusedId: c,
      selectedIds: set("a"),
      anchorId: c,
    });
  });
});
