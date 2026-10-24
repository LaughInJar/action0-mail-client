import { useState } from "react";
import { readJson, writeJson } from "../../lib/storage";
import { usePlatform } from "../../platform/context";
import type { NotificationsPort } from "../../platform/types";
import { useUi } from "../../state/context";
import { useT } from "../../i18n/context";

/** localStorage setting: the bar was answered and isn't shown again. */
const ASKED_KEY = "a0.settings.notificationsAsked";

/**
 * Only the browser and the Android app need asking (the desktop app may
 * notify anyway). Android's web view has no `Notification`.
 */
const askable = (notifications: NotificationsPort) =>
  notifications.mustAsk &&
  notifications.supported() &&
  !notifications.allowed() &&
  (typeof Notification === "undefined" ||
    Notification.permission === "default") &&
  readJson(window.localStorage, ASKED_KEY) !== true;

/**
 * Asks once whether to show desktop notifications for new mail (unless
 * they're turned off in Settings). The browser's own permission prompt
 * only comes after "Turn on".
 */
export function NotificationsBar() {
  const { notifications, mobile } = usePlatform();
  const [visible, setVisible] = useState(() => askable(notifications));
  // Turned off in Settings: never ask.
  const enabled = useUi((state) => state.settings.notifications);
  const t = useT();
  if (!visible || !enabled) return null;
  const done = () => {
    writeJson(window.localStorage, ASKED_KEY, true);
    setVisible(false);
  };
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
    >
      <span className="min-w-0 flex-1">
        {mobile ? t.android.notificationsAsk : t.layout.notificationsAsk}
      </span>
      <button
        type="button"
        onClick={() => {
          done();
          void notifications.request();
        }}
        className="rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
      >
        {t.layout.notificationsOn}
      </button>
      <button
        type="button"
        onClick={done}
        className="rounded-md px-3 py-1 hover:bg-blue-100 dark:hover:bg-blue-900 pointer-coarse:min-h-11"
      >
        {t.layout.notNow}
      </button>
    </div>
  );
}
