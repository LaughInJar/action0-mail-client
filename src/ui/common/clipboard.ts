import type { I18n } from "../../i18n/context";
import type { UiStore } from "../../state/uiStore";

/**
 * Copies `text` and says so in a toast (or why it couldn't); `copied` is
 * the toast's text, by default naming what was copied.
 */
export function copyText(
  text: string,
  store: UiStore,
  t: I18n,
  copied = t.menus.copied(text),
): void {
  const toast = store.getState().showToast;
  // Missing outside secure contexts (and in some test environments).
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (!clipboard) {
    toast({ message: t.menus.couldntCopy, tone: "error" });
    return;
  }
  clipboard.writeText(text).then(
    () => {
      toast({ message: copied, tone: "info" });
    },
    () => {
      toast({ message: t.menus.couldntCopy, tone: "error" });
    },
  );
}
