import { useEffect, useMemo } from "react";
import { useAccounts } from "../../accounts/context";
import type { AccountId } from "../../core/ids";
import { useUi, useUiStore } from "../../state/context";

/** Account colours, distinct in light and dark mode (palette order). */
export const ACCOUNT_COLORS = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#db2777",
  "#7c3aed",
  "#0891b2",
  "#ca8a04",
  "#dc2626",
] as const;

/**
 * Colours for `ids` as palette indices: remembered ones stay; the others
 * get the first colour no account has, preferring ones no removed account
 * had either (so it gets its colour back), repeating once all are taken.
 */
export function assignColors(
  ids: readonly AccountId[],
  remembered: Readonly<Record<string, number>>,
): Record<string, number> {
  const colors: Record<string, number> = {};
  for (const id of ids) {
    const color = remembered[id];
    if (color !== undefined && color < ACCOUNT_COLORS.length)
      colors[id] = color;
  }
  const palette = ACCOUNT_COLORS.map((_, index) => index);
  const everUsed = new Set(Object.values(remembered));
  let cycle = 0;
  for (const id of ids) {
    if (colors[id] !== undefined) continue;
    const used = new Set(Object.values(colors));
    const color =
      palette.find((index) => !used.has(index) && !everUsed.has(index)) ??
      palette.find((index) => !used.has(index)) ??
      cycle++ % ACCOUNT_COLORS.length;
    colors[id] = color;
  }
  return colors;
}

/** Each connected account's colour (CSS). */
export function useAccountColors(): ReadonlyMap<AccountId, string> {
  const accounts = useAccounts();
  const remembered = useUi((state) => state.accountColors);
  return useMemo(() => {
    const ids = accounts.map((handle) => handle.account.id);
    const colors = assignColors(ids, remembered);
    return new Map(
      ids.map((id) => [
        id,
        ACCOUNT_COLORS[colors[id] ?? 0] ?? ACCOUNT_COLORS[0],
      ]),
    );
  }, [accounts, remembered]);
}

/**
 * Remembers the colours of new accounts, so they keep them when other
 * accounts come or go (colours of removed accounts are kept too, in case
 * they come back).
 */
export function useRememberAccountColors(): void {
  const accounts = useAccounts();
  const store = useUiStore();
  useEffect(() => {
    const { accountColors, setAccountColors } = store.getState();
    const ids = accounts.map((handle) => handle.account.id);
    const assigned = assignColors(ids, accountColors);
    if (ids.every((id) => accountColors[id] === assigned[id])) return;
    setAccountColors({ ...accountColors, ...assigned });
  }, [accounts, store]);
}
