import type { ToolbarItem } from "../actions/mailActionItems";
import type { MenuEntry } from "./ContextMenu";

/** Toolbar items as context menu entries (the first one starts a group). */
export function entriesOf(
  items: readonly ToolbarItem[],
  { divider = false }: { readonly divider?: boolean } = {},
): MenuEntry[] {
  return items.map((item, index) => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    run: item.run,
    ...(item.disabled ? { disabled: true } : {}),
    ...(item.danger ? { danger: true } : {}),
    ...(item.pressed ? { pressed: true } : {}),
    ...(divider && index === 0 ? { divider: true } : {}),
  }));
}

/** The groups, one after the other, each after a line. */
export function grouped(
  ...groups: readonly (readonly MenuEntry[])[]
): MenuEntry[] {
  const filled = groups.filter((group) => group.length > 0);
  return filled.flatMap((group, index) =>
    group.map((entry, at) =>
      at === 0 && index > 0 ? { ...entry, divider: true } : entry,
    ),
  );
}
