import { useCallback, useSyncExternalStore } from "react";

/**
 * Layout modes, aligned with Tailwind's `sm` (640px) and `lg` (1024px)
 * breakpoints so CSS and JavaScript agree:
 * - `wide`: three resizable columns.
 * - `medium`: folder tree in a drawer; list and reader side by side.
 * - `narrow`: one pane at a time, driven by the URL.
 */
export type Breakpoint = "wide" | "medium" | "narrow";

export const WIDE_QUERY = "(min-width: 1024px)";
export const MEDIUM_QUERY = "(min-width: 640px)";
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** Live result of a media query (false where `matchMedia` is unavailable). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
}

/** The current layout mode. */
export function useBreakpoint(): Breakpoint {
  const wide = useMediaQuery(WIDE_QUERY);
  const medium = useMediaQuery(MEDIUM_QUERY);
  if (wide) return "wide";
  return medium ? "medium" : "narrow";
}

/** True on touch-first devices (phones, tablets). */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}
