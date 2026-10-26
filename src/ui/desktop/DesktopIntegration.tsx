import { useEffect, useMemo, useState } from "react";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { readJson, writeJson } from "../../lib/storage";
import { usePlatform } from "../../platform/context";
import type { AppUpdate, DesktopControls } from "../../platform/types";
import { useUi } from "../../state/context";
import { useT } from "../../i18n/context";
import { browserLanguages } from "../../i18n/locale";
import { errorMessage } from "../common/errorMessage";
import type { ComposeActions } from "../composer/useComposeActions";
import { applySpelling } from "../settings/spelling";

/** localStorage: the "still running in the tray" notice was shown. */
const TRAY_NOTICE_KEY = "a0.settings.trayNoticeShown";
/** How often the app looks for a newer version (besides at start). */
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

/**
 * What the app does on the desktop besides the web app's job: tells the
 * shell the close-to-tray setting and the tray's texts, writes mails for
 * `mailto:` links, says once that closing keeps it in the tray, sets the
 * spelling languages (Linux), quits on Ctrl/⌘+Q, and offers updates.
 * Renders the update bar (desktop only).
 */
export function DesktopIntegration({ compose }: { compose: ComposeActions }) {
  const platform = usePlatform();
  const { desktop, spelling } = platform;
  const closeToTray = useUi((state) => state.settings.closeToTray);
  // As text, so reading the settings again doesn't count as a change.
  const spellLanguages = useUi((state) => state.settings.spellLanguages.join());
  const t = useT();
  const { composeFrom } = compose;

  useEffect(() => {
    desktop?.configure({ closeToTray, texts: t.desktop.tray });
  }, [desktop, closeToTray, t]);

  useEffect(() => {
    if (!spelling) return;
    const chosen = spellLanguages ? spellLanguages.split(",") : [];
    void applySpelling(spelling, chosen, [
      ...browserLanguages(),
      t.locale,
    ]).catch(() => undefined);
  }, [spelling, spellLanguages, t.locale]);

  useEffect(() => platform.onCompose(composeFrom), [platform, composeFrom]);

  useEffect(
    () =>
      desktop?.onClosedToTray(() => {
        if (readJson(window.localStorage, TRAY_NOTICE_KEY) === true) return;
        writeJson(window.localStorage, TRAY_NOTICE_KEY, true);
        platform.notifications.show({
          ...t.desktop.closedToTray,
          tag: "a0-tray",
          onClick: () => undefined,
        });
      }),
    [desktop, platform, t],
  );

  useCommands(
    useMemo(
      (): Command[] =>
        desktop
          ? [
              {
                id: "app.quit",
                group: "general",
                description: t.shortcuts.quit,
                keys: ["ctrl+q", "meta+q"],
                run: desktop.quit,
              },
            ]
          : [],
      [desktop, t],
    ),
  );

  return desktop ? <UpdateBar desktop={desktop} /> : null;
}

/** Offers a newer version: found at start and once a day; installs on a click. */
function UpdateBar({ desktop }: { desktop: DesktopControls }) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [state, setState] = useState<"offer" | "installing" | "hidden">(
    "offer",
  );
  const [failure, setFailure] = useState<string>();
  const t = useT();
  const d = t.desktop;

  useEffect(() => {
    let stopped = false;
    const look = () => {
      void desktop.checkForUpdate().then((found) => {
        if (!stopped && found) setUpdate(found);
      });
    };
    look();
    const timer = setInterval(look, UPDATE_CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [desktop]);

  if (!update || state === "hidden") return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
    >
      <span className="min-w-0 flex-1">
        {failure ?? d.updateAvailable(update.version)}
      </span>
      <button
        type="button"
        disabled={state === "installing"}
        onClick={() => {
          setState("installing");
          setFailure(undefined);
          update.install().catch((error: unknown) => {
            setState("offer");
            setFailure(d.updateFailed(errorMessage(error, t)));
          });
        }}
        className="rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700 disabled:opacity-60 pointer-coarse:min-h-11"
      >
        {state === "installing" ? d.installing : d.installUpdate}
      </button>
      <button
        type="button"
        onClick={() => {
          setState("hidden");
        }}
        className="rounded-md px-3 py-1 hover:bg-blue-100 dark:hover:bg-blue-900 pointer-coarse:min-h-11"
      >
        {d.later}
      </button>
    </div>
  );
}
