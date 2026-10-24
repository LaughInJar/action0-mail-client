import { useEffect, useState } from "react";
import type {
  AppUpdate,
  DefaultMailAppResult,
  DesktopControls,
} from "../../platform/types";
import { useUi } from "../../state/context";
import { useT } from "../../i18n/context";
import { errorMessage } from "../common/errorMessage";
import { ChoiceGroup, SettingsSection } from "./controls";

const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";

/**
 * Settings of the desktop app: what closing the window does, starting with
 * the system, being the default mail app, and updates.
 */
export function DesktopSettings({
  id,
  desktop,
}: {
  id: string;
  desktop: DesktopControls;
}) {
  const t = useT();
  const d = t.desktop;
  const closeToTray = useUi((state) => state.settings.closeToTray);
  const update = useUi((state) => state.updateSettings);
  const [autostart, setAutostart] = useState<boolean>();
  const [defaultApp, setDefaultApp] = useState<string>();
  const [updates, setUpdates] = useState<
    | { kind: "idle" | "checking" | "current" | "installing" }
    | { kind: "found"; update: AppUpdate }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    let stopped = false;
    desktop.autostart.get().then(
      (on) => {
        if (!stopped) setAutostart(on);
      },
      () => undefined,
    );
    return () => {
      stopped = true;
    };
  }, [desktop]);

  const outcome: Record<DefaultMailAppResult, string> = {
    done: d.defaultDone,
    settings: d.defaultSettings,
    manual: d.defaultManual,
  };

  return (
    <SettingsSection id={id} title={d.section}>
      {!desktop.keychain && (
        <p
          role="note"
          className="mx-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {d.noKeychain}
        </p>
      )}
      <ChoiceGroup
        legend={d.whenClosing}
        value={closeToTray ? "tray" : "quit"}
        onChange={(value) => {
          update({ closeToTray: value === "tray" });
        }}
        choices={[
          { value: "tray", label: d.closing.tray, hint: d.trayHint },
          { value: "quit", label: d.closing.quit },
        ]}
      />
      <label className="flex cursor-pointer items-start gap-2.5 px-2 pointer-coarse:min-h-11">
        <input
          type="checkbox"
          checked={autostart === true}
          disabled={autostart === undefined}
          onChange={(event) => {
            const on = event.target.checked;
            setAutostart(on);
            desktop.autostart.set(on).catch(() => {
              setAutostart(!on);
            });
          }}
          className="mt-0.5 size-4 shrink-0 accent-blue-600"
        />
        <span className="text-sm">
          {d.autostart}
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            {d.autostartHint}
          </span>
        </span>
      </label>
      <div className="space-y-1.5 px-2">
        <p className="text-sm font-medium">{d.defaultApp}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {d.defaultAppHint}
        </p>
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            desktop.makeDefaultMailApp().then(
              (result) => {
                setDefaultApp(outcome[result]);
              },
              (error: unknown) => {
                setDefaultApp(d.defaultFailed(errorMessage(error, t)));
              },
            );
          }}
        >
          {d.makeDefault}
        </button>
        {defaultApp && (
          <p role="status" className="text-xs text-zinc-600 dark:text-zinc-400">
            {defaultApp}
          </p>
        )}
      </div>
      <div className="space-y-1.5 px-2">
        <p className="text-sm">{d.version(desktop.version)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={
              updates.kind === "checking" || updates.kind === "installing"
            }
            onClick={() => {
              if (updates.kind === "found") {
                const found = updates.update;
                setUpdates({ kind: "installing" });
                found.install().catch((error: unknown) => {
                  setUpdates({
                    kind: "failed",
                    message: d.updateFailed(errorMessage(error, t)),
                  });
                });
                return;
              }
              setUpdates({ kind: "checking" });
              void desktop.checkForUpdate().then((found) => {
                setUpdates(
                  found
                    ? { kind: "found", update: found }
                    : { kind: "current" },
                );
              });
            }}
          >
            {updates.kind === "found"
              ? d.installUpdate
              : updates.kind === "installing"
                ? d.installing
                : updates.kind === "checking"
                  ? d.checking
                  : d.checkUpdates}
          </button>
          <span
            role="status"
            className="text-xs text-zinc-600 dark:text-zinc-400"
          >
            {updates.kind === "current" && d.upToDate}
            {updates.kind === "found" &&
              d.updateAvailable(updates.update.version)}
            {updates.kind === "failed" && updates.message}
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}
