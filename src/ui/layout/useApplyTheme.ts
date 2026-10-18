import { useEffect } from "react";
import { useUi } from "../../state/context";
import type { ThemeMode } from "../../state/theme";

/** Page background per theme, for the browser's address bar on phones. */
const BAR_COLORS = { light: "#ffffff", dark: "#09090b" } as const;

/**
 * Shows a theme: `data-theme` on <html> (none for "system", so the OS
 * decides) and the matching address-bar colour.
 */
export function applyTheme(mode: ThemeMode, doc: Document = document): void {
  const root = doc.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  // index.html has one theme-color per OS scheme; a chosen theme sets both.
  for (const meta of doc.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    const own = meta.media.includes("dark") ? "dark" : "light";
    meta.content = BAR_COLORS[mode === "system" ? own : mode];
  }
}

/** Keeps the page showing the theme from the UI store. */
export function useApplyTheme(): void {
  const theme = useUi((state) => state.theme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
}
