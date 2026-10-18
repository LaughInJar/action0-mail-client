import { createContext, useContext } from "react";
import type { Language } from "./locale";
import { messages, type Messages } from "./messages";

/** The interface texts in the current language, plus how to format for it. */
export type I18n = Messages & {
  readonly language: Language;
  /** BCP 47 locale for dates and numbers (e.g. "de-AT"). */
  readonly locale: string;
};

/** English, for code outside the provider (and tests that render parts). */
export const ENGLISH: I18n = {
  ...messages.en,
  language: "en",
  locale: "en-US",
};

export const I18nContext = createContext<I18n>(ENGLISH);

/** The texts of the interface language. */
export function useT(): I18n {
  return useContext(I18nContext);
}
