import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/context";
import { browserLanguages } from "../../i18n/locale";
import { usePlatform } from "../../platform/context";
import type { SpellingControls } from "../../platform/types";
import { useUi } from "../../state/context";
import { applySpelling, type SpellingStatus } from "./spelling";

const HINT = "px-2 text-xs text-zinc-500 dark:text-zinc-400";

/**
 * Settings → Writing → Spelling: on or off, and the languages: chosen
 * here in the Linux app, elsewhere set in the browser or the system (the
 * hint says where).
 */
export function SpellingSettings() {
  const enabled = useUi((state) => state.settings.spellcheck);
  const update = useUi((state) => state.updateSettings);
  const platform = usePlatform();
  const s = useT().settings;
  const os = platform.desktop?.os;
  const hint =
    platform.kind === "android"
      ? s.spellingAndroid
      : os === "windows"
        ? s.spellingWindows
        : os === "macos"
          ? s.spellingMac
          : s.spellingWeb;

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-2.5 px-2 pointer-coarse:min-h-11">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            update({ spellcheck: event.target.checked });
          }}
          className="mt-0.5 size-4 shrink-0 accent-blue-600"
        />
        <span className="text-sm">
          {s.spelling}
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            {s.spellingHint}
          </span>
        </span>
      </label>
      {enabled &&
        (platform.spelling ? (
          <SpellingLanguages spelling={platform.spelling} />
        ) : (
          <p className={HINT}>{hint}</p>
        ))}
    </div>
  );
}

/** The installed dictionaries to tick (the Linux app), looked for afresh. */
function SpellingLanguages({ spelling }: { spelling: SpellingControls }) {
  const t = useT();
  const s = t.settings;
  const chosen = useUi((state) => state.settings.spellLanguages);
  const update = useUi((state) => state.updateSettings);
  const [status, setStatus] = useState<SpellingStatus | null>(null);

  useEffect(() => {
    let current = true;
    void applySpelling(spelling, chosen, [...browserLanguages(), t.locale])
      .catch((): SpellingStatus => ({
        dictionaries: [],
        languages: [],
        loaded: [],
      }))
      .then((next) => {
        if (current) setStatus(next);
      });
    return () => {
      current = false;
    };
  }, [spelling, chosen, t.locale]);

  const dictionaries = useMemo(() => {
    const names = new Intl.DisplayNames([t.locale], {
      type: "language",
      languageDisplay: "standard",
    });
    return (status?.dictionaries ?? [])
      .map((tag) => ({ tag, name: names.of(tag) ?? tag }))
      .sort((a, b) => a.name.localeCompare(b.name, t.locale));
  }, [status, t.locale]);

  if (!status) return <p className={HINT}>{s.lookingForDictionaries}</p>;
  if (dictionaries.length === 0)
    return <p className={HINT}>{s.noDictionaries}</p>;
  const { languages } = status;
  return (
    <fieldset className="space-y-1 px-2">
      <legend className="mb-1 text-sm font-medium">
        {s.spellingLanguages}
      </legend>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {dictionaries.map(({ tag, name }) => {
          const checked = languages.includes(tag);
          return (
            <label
              key={tag}
              className="flex cursor-pointer items-center gap-2.5 py-1 text-sm has-disabled:cursor-default pointer-coarse:min-h-11"
            >
              <input
                type="checkbox"
                checked={checked}
                // At least one language stays.
                disabled={checked && languages.length === 1}
                onChange={(event) => {
                  update({
                    spellLanguages: event.target.checked
                      ? [...languages, tag]
                      : languages.filter((other) => other !== tag),
                  });
                }}
                className="size-4 shrink-0 accent-blue-600"
              />
              {name}
            </label>
          );
        })}
      </div>
      {status.loaded.length === 0 && (
        <p className="text-xs text-red-700 dark:text-red-400">
          {s.dictionariesNotLoaded}
        </p>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {s.spellingLinux}
      </p>
    </fieldset>
  );
}
