import { foldText } from "../../lib/text";
import type { IconName } from "../common/Icon";

/** Where the command palette lists an item. */
export type PaletteSection = "recent" | "places" | "actions" | "search";

/** One choice of the command palette: a place to go to or an action. */
export interface PaletteItem {
  /**
   * Stable id, remembered among the recent choices (a place's or an
   * action's, never mail). Opaque.
   */
  readonly id: string;
  readonly label: string;
  /** Shown after the label: the account, "Calendar", "Settings" … */
  readonly detail?: string;
  readonly icon: IconName;
  /** The keyboard shortcut, formatted. */
  readonly shortcut?: string;
  readonly section: Exclude<PaletteSection, "recent">;
  /** More words it's found by (not shown). */
  readonly keywords?: string;
  /** "Search mail for …" isn't a recent choice. */
  readonly remember?: false;
  readonly run: () => void;
}

/** A section of the palette's list with its items, in order. */
export interface PaletteGroup {
  readonly section: PaletteSection;
  readonly items: readonly PaletteItem[];
}

/** Recent choices rank higher. */
const RECENT_BONUS = 4;
/** The whole label typed ("Archive" over "Archive 2019"). */
const EXACT_BONUS = 3;

/** The word starts of a text, folded (no case, no accents). */
const wordsOf = (text: string) =>
  foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * How well `query` matches an item: every word of the query has to start
 * a word of the label, the detail or the keywords, ignoring case and
 * accents. Matches in the label count more, most of all at its start or
 * when they're the whole label. `null` if a word doesn't match.
 */
export function matchScore(
  query: string,
  item: Pick<PaletteItem, "label" | "detail" | "keywords">,
): number | null {
  const needles = wordsOf(query);
  if (needles.length === 0) return 0;
  const label = wordsOf(item.label);
  const rest = [...wordsOf(item.detail ?? ""), ...wordsOf(item.keywords ?? "")];
  let score = 0;
  for (const [index, needle] of needles.entries()) {
    const at = label.findIndex((word) => word.startsWith(needle));
    if (at === 0 && index === 0) score += 5;
    else if (at !== -1) score += 3;
    else if (rest.some((word) => word.startsWith(needle))) score += 1;
    else return null;
  }
  const typed = needles.join(" ");
  const whole = label.join(" ");
  if (typed === whole) score += EXACT_BONUS;
  // Between equal matches, the one more of whose label is typed.
  return score + (whole ? Math.min(1, typed.length / whole.length) * 0.5 : 0);
}

/**
 * The items to show for `query`, by section. Empty query: the recent
 * choices first (in the order they were made), then everything else in
 * its order. Otherwise the matches by section, best first, and the
 * section with the best match first (places before actions when they're
 * as good); the mail search always comes last. Recent choices rank higher.
 */
export function paletteGroups(
  items: readonly PaletteItem[],
  query: string,
  recent: readonly string[],
): PaletteGroup[] {
  const sections = ["places", "actions", "search"] as const;
  if (!query.trim()) {
    const recentItems = recent.flatMap(
      (id) => items.find((item) => item.id === id) ?? [],
    );
    const shown = new Set(recentItems.map((item) => item.id));
    return [
      { section: "recent" as const, items: recentItems },
      ...sections.map((section) => ({
        section,
        items: items.filter(
          (item) => item.section === section && !shown.has(item.id),
        ),
      })),
    ].filter((group) => group.items.length > 0);
  }
  const scored = items.flatMap((item, index) => {
    const score = matchScore(query, item);
    if (score === null && item.section !== "search") return [];
    const bonus = recent.includes(item.id) ? RECENT_BONUS : 0;
    return [{ item, index, score: (score ?? 0) + bonus }];
  });
  return sections
    .map((section, order) => {
      const matches = scored
        .filter(({ item }) => item.section === section)
        .sort((a, b) => b.score - a.score || a.index - b.index);
      // The search last, whatever its score.
      const best = section === "search" ? -Infinity : (matches[0]?.score ?? 0);
      return { section, matches, best, order };
    })
    .filter((group) => group.matches.length > 0)
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map(({ section, matches }) => ({
      section,
      items: matches.map(({ item }) => item),
    }));
}

/** `id` first among the recent choices, at most `max` of them. */
export function withRecent(
  recent: readonly string[],
  id: string,
  max: number,
): string[] {
  return [id, ...recent.filter((other) => other !== id)].slice(0, max);
}
