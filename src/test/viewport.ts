import { vi } from "vitest";

/** Simulated device classes, matching the app's breakpoints. */
export type Viewport = "wide" | "medium" | "narrow";

const WIDTHS: Readonly<Record<Viewport, number>> = {
  wide: 1400,
  medium: 800,
  narrow: 390,
};

/** Stubs `matchMedia` for the given viewport (phones get a coarse pointer). */
export function mockViewport(
  viewport: Viewport,
  { coarse = viewport === "narrow" } = {},
): void {
  const width = WIDTHS[viewport];
  const matchMedia = (query: string): MediaQueryList => {
    const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
    let matches = false;
    if (minWidth) matches = width >= Number(minWidth[1]);
    else if (query.includes("pointer: coarse")) matches = coarse;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  };
  vi.stubGlobal("matchMedia", matchMedia);
}
