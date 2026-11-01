import { useT } from "../../i18n/context";
import { useRouter, useUiStore } from "../../state/context";
import { Icon } from "../common/Icon";
import { IconButton } from "../common/IconButton";
import { APP_TITLE } from "../sync/useDocumentTitle";
import { ThemeSwitch } from "./ThemeSwitch";

/**
 * The left column's header (mail, calendar and contacts): the app's name,
 * the theme switch, the command palette and Settings.
 */
export function SidebarHeader({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const store = useUiStore();
  const t = useT();
  return (
    <div className="@container flex items-center gap-1.5 pt-2 pr-2 pb-1 pl-4 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
      {/* A narrower column drops the icon, then shortens the name; touch-sized buttons leave no room for the name below 20rem (the tablets' drawer). */}
      <Icon
        name="mail"
        className="hidden size-5 shrink-0 text-blue-600 @[15.5rem]:block dark:text-blue-400"
      />
      <span className="min-w-0 flex-1 truncate pointer-coarse:@max-[20rem]:invisible">
        {APP_TITLE}
      </span>
      <ThemeSwitch />
      <div className="flex">
        <IconButton
          label={t.palette.open}
          icon="command"
          onClick={() => {
            onNavigate?.();
            store.getState().setPaletteOpen(true);
          }}
        />
        <IconButton
          label={t.layout.settings}
          icon="settings"
          onClick={() => {
            onNavigate?.();
            router.openSettings();
          }}
        />
      </div>
    </div>
  );
}
