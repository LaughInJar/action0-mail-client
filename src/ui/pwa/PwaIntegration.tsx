import { useState } from "react";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useUi } from "../../state/context";
import { useBreakpoint } from "../layout/useBreakpoint";
import { usePwaState } from "./usePwaState";

const BAR =
  "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100";
const PRIMARY =
  "rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11";
const QUIET =
  "rounded-md px-3 py-1 hover:bg-blue-100 dark:hover:bg-blue-900 pointer-coarse:min-h-11";

/**
 * What the installable web app shows besides the web app's job: "A new
 * version of action0 is ready" with Reload, and on phones, once, the
 * offer to install it (or Safari's steps). Email links, the shortcut and
 * shared content reach the composer through the platform's `onCompose`
 * and `onShare`, like in the apps.
 */
export function PwaIntegration() {
  const { pwa } = usePlatform();
  const { updateReady, canInstall, installed } = usePwaState(pwa);
  const offered = useUi((state) => state.settings.installOffered);
  const update = useUi((state) => state.updateSettings);
  const phone = useBreakpoint() === "narrow";
  const [later, setLater] = useState(false);
  const t = useT();
  const p = t.pwa;
  if (!pwa) return null;

  if (updateReady && !later)
    return (
      <div role="status" className={BAR}>
        <span className="min-w-0 flex-1">{p.updateReady}</span>
        <button type="button" onClick={pwa.reload} className={PRIMARY}>
          {p.reload}
        </button>
        <button
          type="button"
          onClick={() => {
            setLater(true);
          }}
          className={QUIET}
        >
          {p.later}
        </button>
      </div>
    );

  const steps = pwa.installSteps();
  if (!phone || offered || installed || (!canInstall && steps !== "ios"))
    return null;
  const done = () => {
    update({ installOffered: true });
  };
  return (
    <div role="status" className={BAR}>
      <span className="min-w-0 flex-1">
        {p.installOffer}
        {!canInstall && <span className="block text-xs">{p.iosSteps}</span>}
      </span>
      {canInstall && (
        <button
          type="button"
          onClick={() => {
            done();
            void pwa.install();
          }}
          className={PRIMARY}
        >
          {p.install}
        </button>
      )}
      <button type="button" onClick={done} className={QUIET}>
        {p.notNow}
      </button>
    </div>
  );
}
