import { useUi } from "../../state/context";
import type { ThemeMode } from "../../state/theme";
import { Icon, type IconName } from "../common/Icon";
import { useT, type I18n } from "../../i18n/context";

const options = (
  t: I18n,
): readonly {
  readonly mode: ThemeMode;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
}[] => [
  {
    mode: "system",
    label: t.layout.themeSystem,
    hint: t.layout.themeSystemHint,
    icon: "monitor",
  },
  {
    mode: "light",
    label: t.layout.themeLight,
    hint: t.layout.themeLightHint,
    icon: "sun",
  },
  {
    mode: "dark",
    label: t.layout.themeDark,
    hint: t.layout.themeDarkHint,
    icon: "moon",
  },
];

/**
 * System / Light / Dark as three icon radio buttons; the chosen one is
 * highlighted. Arrow keys move between them, so they keep their keys from
 * the app's shortcuts.
 */
export function ThemeSwitch() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const t = useT();
  return (
    <div
      role="radiogroup"
      aria-label={t.layout.theme}
      data-own-keys=""
      className="flex rounded-md bg-zinc-200/70 p-0.5 dark:bg-zinc-800"
    >
      {options(t).map(({ mode, label, hint, icon }) => (
        <label
          key={mode}
          title={hint}
          className="relative grid size-7 cursor-pointer place-items-center rounded text-zinc-500 hover:text-zinc-800 has-checked:bg-white has-checked:text-zinc-900 has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-blue-500 dark:text-zinc-400 dark:hover:text-zinc-100 dark:has-checked:bg-zinc-600 dark:has-checked:text-white pointer-coarse:size-11"
        >
          <input
            type="radio"
            name="theme"
            value={mode}
            aria-label={label}
            checked={theme === mode}
            onChange={() => {
              setTheme(mode);
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
          <Icon name={icon} className="size-3.5" />
        </label>
      ))}
    </div>
  );
}
