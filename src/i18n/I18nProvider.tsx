import { useEffect, useMemo, type ReactNode } from "react";
import { useUi } from "../state/context";
import { I18nContext, type I18n } from "./context";
import { browserLanguages, localeFor, resolveLanguage } from "./locale";
import { messages } from "./messages";

/** Provides the texts of the chosen (or the browser's) language; sets `<html lang>`. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const setting = useUi((state) => state.settings.language);
  const value = useMemo((): I18n => {
    const browser = browserLanguages();
    const language = resolveLanguage(setting, browser);
    return {
      ...messages[language],
      language,
      locale: localeFor(language, browser),
    };
  }, [setting]);
  useEffect(() => {
    document.documentElement.lang = value.language;
  }, [value.language]);
  return <I18nContext value={value}>{children}</I18nContext>;
}
