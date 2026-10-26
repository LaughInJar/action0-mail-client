/**
 * The Linux app's spelling languages: those chosen in Settings that are
 * installed, else the system's languages matched to the installed
 * dictionaries.
 */
import type { SpellingControls } from "../../platform/types";

/** The main variant of a language, where it isn't "xx-XX". */
const MAIN_VARIANT: Readonly<Record<string, string>> = {
  en: "en-US",
  pt: "pt-PT",
  sv: "sv-SE",
  da: "da-DK",
  cs: "cs-CZ",
  el: "el-GR",
};

/**
 * The installed dictionary for a preferred language ("de-AT", "de"): the
 * same variant, else one for the whole language, else its main variant,
 * else its first.
 */
function dictionaryFor(
  dictionaries: readonly string[],
  preferred: string,
): string | undefined {
  const [first = "", ...rest] = preferred.split("-");
  const language = first.toLowerCase();
  const region = rest.find((part) => /^[a-z]{2}$/i.test(part))?.toUpperCase();
  const candidates = [
    region && `${language}-${region}`,
    language,
    MAIN_VARIANT[language] ?? `${language}-${language.toUpperCase()}`,
  ];
  return (
    candidates.find(
      (candidate) => candidate && dictionaries.includes(candidate),
    ) || dictionaries.find((tag) => tag.startsWith(`${language}-`))
  );
}

/** The dictionaries for the preferred languages, in their order, each once. */
export function defaultSpellLanguages(
  dictionaries: readonly string[],
  preferred: readonly string[],
): string[] {
  const found = preferred.flatMap(
    (tag) => dictionaryFor(dictionaries, tag) ?? [],
  );
  return [...new Set(found)];
}

/** The chosen languages that are installed; if none are, the default ones. */
export function chosenSpellLanguages(
  chosen: readonly string[],
  dictionaries: readonly string[],
  preferred: readonly string[],
): string[] {
  const installed = chosen.filter((tag) => dictionaries.includes(tag));
  return installed.length > 0
    ? installed
    : defaultSpellLanguages(dictionaries, preferred);
}

/** What the web view checks with now. */
export interface SpellingStatus {
  /** The installed dictionaries. */
  readonly dictionaries: readonly string[];
  /** The languages checked with. */
  readonly languages: readonly string[];
  /** Those whose dictionaries loaded. */
  readonly loaded: readonly string[];
}

/** Looks for the installed dictionaries and checks with the right ones. */
export async function applySpelling(
  spelling: SpellingControls,
  chosen: readonly string[],
  preferred: readonly string[],
): Promise<SpellingStatus> {
  const dictionaries = await spelling.dictionaries();
  const languages = chosenSpellLanguages(chosen, dictionaries, preferred);
  const loaded = await spelling.setLanguages(languages);
  return { dictionaries, languages, loaded };
}
