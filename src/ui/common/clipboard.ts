import type { I18n } from "../../i18n/context";
import type { UiStore } from "../../state/uiStore";

/** Copies `text` and says so in a toast (or why it couldn't). */
export function copyText(text: string, store: UiStore, t: I18n): void {
  const toast = store.getState().showToast;
  // Missing outside secure contexts (and in some test environments).
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (!clipboard) {
    toast({ message: t.menus.couldntCopy, tone: "error" });
    return;
  }
  clipboard.writeText(text).then(
    () => {
      toast({ message: t.menus.copied(text), tone: "info" });
    },
    () => {
      toast({ message: t.menus.couldntCopy, tone: "error" });
    },
  );
}
