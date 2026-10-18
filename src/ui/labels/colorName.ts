/** Hue ranges (degrees, upper bound) and their names. */
const HUES: readonly (readonly [number, string])[] = [
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
 * A rough English name for a `#rrggbb` colour ("dark green"), for screen
 * readers and tooltips of colour swatches.
 */
export function colorName(hex: string): string {
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
    if (lightness > 0.85) return "white";
    if (lightness < 0.15) return "black";
    return lightness < 0.5 ? "dark grey" : "grey";
  }
  let hue: number;
  if (max === r) hue = ((g - b) / chroma + 6) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue *= 60;
  const name = HUES.find(([limit]) => hue < limit)?.[1] ?? "red";
  if (lightness < 0.32) return `deep ${name}`;
  if (lightness < 0.45) return `dark ${name}`;
  if (lightness > 0.62) return `light ${name}`;
  return name;
}
