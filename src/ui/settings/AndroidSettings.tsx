import { useState } from "react";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import type { AvailableRelease, MobileControls } from "../../platform/types";
import { SettingsSection } from "./controls";

const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";

/** Settings of the Android app: its version, and newer releases. */
export function AndroidSettings({
  id,
  mobile,
}: {
  id: string;
  mobile: MobileControls;
}) {
  const t = useT();
  const a = t.android;
  const { openExternal } = usePlatform();
  const [state, setState] = useState<
    | { kind: "idle" | "checking" | "current" }
    | { kind: "found"; release: AvailableRelease }
  >({ kind: "idle" });

  return (
    <SettingsSection id={id} title={t.desktop.section}>
      <div className="space-y-1.5 px-2">
        <p className="text-sm">{a.version(mobile.version)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={state.kind === "checking"}
            onClick={() => {
              if (state.kind === "found") {
                openExternal(state.release.url);
                return;
              }
              setState({ kind: "checking" });
              void mobile.checkForUpdate().then((release) => {
                setState(
                  release ? { kind: "found", release } : { kind: "current" },
                );
              });
            }}
          >
            {state.kind === "found"
              ? a.download
              : state.kind === "checking"
                ? a.checking
                : a.checkForUpdates}
          </button>
          <span
            role="status"
            className="text-xs text-zinc-600 dark:text-zinc-400"
          >
            {state.kind === "current" && a.upToDate}
            {state.kind === "found" &&
              a.releaseAvailable(state.release.version)}
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}
