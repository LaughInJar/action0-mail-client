import type { ToolbarItem } from "../actions/mailActionItems";

/** Space between buttons (`gap-1`). */
export const GAP = 4;
/** The divider between answering and the mail actions, with its gaps. */
const DIVIDER = 1 + 8 + GAP;

/**
 * The items that fit into `width` (px) with buttons of `button` px: all of
 * them, or else the ⋯ button plus what's left after the lowest `keep`
 * moved out. Items without `keep` always stay.
 */
export function fittingItems(
  items: readonly ToolbarItem[],
  width: number,
  button: number,
): ReadonlySet<string> {
  const widthOf = (shown: readonly ToolbarItem[], more: boolean) => {
    const count = shown.length + (more ? 1 : 0);
    const groups = new Set(shown.map((item) => item.group)).size;
    return (
      count * button + Math.max(0, count - 1) * GAP + (groups > 1 ? DIVIDER : 0)
    );
  };
  let shown = [...items];
  if (widthOf(shown, false) <= width) return new Set(shown.map((i) => i.id));
  const leaving = items
    .filter((item) => item.keep !== undefined)
    .sort((a, b) => (a.keep ?? 0) - (b.keep ?? 0));
  for (const item of leaving) {
    if (widthOf(shown, true) <= width) break;
    shown = shown.filter((candidate) => candidate !== item);
  }
  return new Set(shown.map((item) => item.id));
}
