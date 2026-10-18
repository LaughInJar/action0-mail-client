/** Languages of the interface. */
export type Language = "en" | "de";

/** Each language's name in that language, for choosing it. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  de: "Deutsch",
};

/** The language setting: a language, or the browser's ("auto"). */
export type LanguageSetting = "auto" | Language;

/** Whether a BCP 47 tag is German (de, de-AT, de-CH, …). */
const isGerman = (tag: string) => /^de(-|$)/i.test(tag);

/**
 * The interface language: the chosen one, or for "auto" German when the
 * browser's preferred language is German, else English.
 */
export function resolveLanguage(
  setting: LanguageSetting,
  browserLanguages: readonly string[],
): Language {
  if (setting !== "auto") return setting;
  return browserLanguages[0] !== undefined && isGerman(browserLanguages[0])
    ? "de"
    : "en";
}

/**
 * The locale for dates and numbers: the browser's own when it is a variant
 * of the language (de-AT writes "Jänner"), else a default one.
 */
export function localeFor(
  language: Language,
  browserLanguages: readonly string[],
): string {
  const own = browserLanguages.find((tag) =>
    language === "de" ? isGerman(tag) : /^en(-|$)/i.test(tag),
  );
  return own ?? (language === "de" ? "de-DE" : "en-US");
}

/** The browser's preferred languages (none outside a browser). */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
}
