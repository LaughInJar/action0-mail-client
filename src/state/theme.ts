/**
 * The colour theme: chosen per browser, or the OS setting ("system").
 * `public/theme.js` applies the saved choice before the app loads, so the
 * key and values here must stay in step with it.
 */

/** Theme choices. "system" follows the OS. */
export type ThemeMode = "system" | "light" | "dark";

/** localStorage key of the chosen theme (absent for "system"). */
export const THEME_KEY = "a0.theme";

/** The theme chosen in this browser; anything unknown counts as "system". */
export function readTheme(storage: Storage | undefined): ThemeMode {
  try {
    const value = storage?.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Remembers the choice; "system" forgets it. Best effort. */
export function saveTheme(storage: Storage | undefined, mode: ThemeMode): void {
  try {
    if (mode === "system") storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, mode);
  } catch {
    // Storage can be blocked; the choice then lasts until reload.
  }
}
