import { useEffect } from "react";
import { useUi } from "../../state/context";
import { Icon } from "../common/Icon";

/** How long a toast stays visible. */
export const TOAST_DURATION_MS = 8000;

/** Shows the current toast at the bottom of the screen, with Undo if possible. */
export function ToastHost({ onUndo }: { onUndo: () => void }) {
  const toast = useUi((state) => state.toast);
  const dismissToast = useUi((state) => state.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      dismissToast(toast.id);
    }, TOAST_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast, dismissToast]);

  // The live region stays mounted so screen readers announce new toasts.
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {toast && (
        <div
          className={`pointer-events-auto flex max-w-full items-center gap-3 rounded-lg py-2 pr-2 pl-4 text-sm shadow-lg ${
            toast.tone === "error"
              ? "bg-red-700 text-white"
              : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
          }`}
        >
          <span className="min-w-0">{toast.message}</span>
          {toast.link && (
            <a
              href={toast.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded px-2 py-1 font-semibold underline-offset-2 hover:bg-white/15 hover:underline dark:hover:bg-black/10 pointer-coarse:min-h-11"
            >
              {toast.link.label}
            </a>
          )}
          {(toast.undo ?? toast.restoreDraft ?? toast.revert) && (
            <button
              type="button"
              onClick={onUndo}
              className="rounded px-2 py-1 font-semibold hover:bg-white/15 dark:hover:bg-black/10 pointer-coarse:min-h-11"
            >
              Undo{" "}
              <kbd className="ml-0.5 font-sans text-xs opacity-70 pointer-coarse:hidden">
                z
              </kbd>
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              dismissToast(toast.id);
            }}
            className="grid size-7 place-items-center rounded hover:bg-white/15 dark:hover:bg-black/10 pointer-coarse:size-11"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
