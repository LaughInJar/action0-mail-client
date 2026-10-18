import type { I18n } from "../../i18n/context";

type ColourNames = I18n["labels"]["colours"];
type Hue =
  "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink";

/** Hue ranges (degrees, upper bound) and their names. */
const HUES: readonly (readonly [number, Hue])[] = [
  [15, "red"],
  [40, "orange"],
  [65, "yellow"],
  [160, "green"],
  [200, "teal"],
  [255, "blue"],
  [290, "purple"],
  [345, "pink"],
  [360, "red"],
];

/**
 * A rough name for a `#rrggbb` colour ("dark green"), for screen readers
 * and tooltips of colour swatches.
 */
export function colorName(hex: string, names: ColourNames): string {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma < 0.1) {
    if (lightness > 0.85) return names.white;
    if (lightness < 0.15) return names.black;
    return lightness < 0.5 ? names.darkGrey : names.grey;
  }
  let hue: number;
  if (max === r) hue = ((g - b) / chroma + 6) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue *= 60;
  const name = names[HUES.find(([limit]) => hue < limit)?.[1] ?? "red"];
  if (lightness < 0.32) return names.deep(name);
  if (lightness < 0.45) return names.dark(name);
  if (lightness > 0.62) return names.light(name);
  return name;
}
