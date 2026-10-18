/** Case- and accent-insensitive form of a text, for matching ("Café" → "cafe"). */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Where `query` first occurs in `text`, ignoring case and accents, as a
 * `[start, end)` range of `text`; undefined if it doesn't occur (or `query`
 * is blank).
 */
export function findFolded(
  text: string,
  query: string,
): readonly [number, number] | undefined {
  const needle = foldText(query.trim());
  if (!needle) return undefined;
  // Fold character by character, remembering where each folded char came from.
  let folded = "";
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const part = foldText(char);
    origin.push(...new Array<number>(part.length).fill(index));
    folded += part;
    index += char.length;
  }
  origin.push(index);
  const at = folded.indexOf(needle);
  if (at === -1) return undefined;
  return [origin[at] ?? 0, origin[at + needle.length] ?? text.length];
}
