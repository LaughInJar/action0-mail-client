import { useState } from "react";
import { useT } from "../../i18n/context";
import type { PwaControls } from "../../platform/types";
import { usePwaState } from "../pwa/usePwaState";
import { SettingsSection } from "./controls";

const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800 pointer-coarse:min-h-11";
const HINT = "text-xs text-zinc-500 dark:text-zinc-400";

/** Settings of the web app: installing it, and email links. */
export function WebAppSettings({ id, pwa }: { id: string; pwa: PwaControls }) {
  const t = useT();
  const p = t.pwa;
  const { canInstall, installed } = usePwaState(pwa);
  const [asked, setAsked] = useState(false);
  const steps = pwa.installSteps();

  return (
    <SettingsSection id={id} title={p.appTitle}>
      <div className="space-y-4 px-2">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{p.installTitle}</p>
          {installed ? (
            <p className="text-sm">{p.installed}</p>
          ) : canInstall ? (
            <button
              type="button"
              onClick={() => {
                void pwa.install();
              }}
              className={BUTTON}
            >
              {p.install}
            </button>
          ) : (
            <p className="text-sm">
              {steps === "ios"
                ? p.iosSteps
                : steps === "macSafari"
                  ? p.macSafariSteps
                  : p.cantInstall}
            </p>
          )}
          <p className={HINT}>{p.installHint}</p>
        </div>
        {pwa.emailLinks.supported && (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => {
                pwa.emailLinks.register();
                setAsked(true);
              }}
              className={BUTTON}
            >
              {p.emailLinks}
            </button>
            <p className={HINT} role="status">
              {asked ? p.emailLinksAsked : p.emailLinksHint}
            </p>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
