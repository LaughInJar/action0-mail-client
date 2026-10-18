import { useId, useRef } from "react";
import { useUi } from "../../state/context";
import type { ConfirmState } from "../../state/uiStore";
import { useMailActions } from "../actions/useMailActions";
import { useFocusTrap } from "./useFocusTrap";

/** Shows the confirmation dialog while a destructive action waits for it. */
export function ConfirmHost() {
  const confirm = useUi((state) => state.confirm);
  if (!confirm) return null;
  return <ConfirmDialog confirm={confirm} />;
}

/**
 * Asks before something that can't be undone. Cancel comes first and has
 * focus, so Enter or Escape never destroys anything by accident.
 */
function ConfirmDialog({ confirm }: { confirm: ConfirmState }) {
  const setConfirm = useUi((state) => state.setConfirm);
  const actions = useMailActions();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  const cancel = () => {
    setConfirm(null);
  };
  useFocusTrap(dialogRef, true, cancel);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Dismiss"
        onClick={cancel}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="relative w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl dark:bg-zinc-900"
      >
        <h2 id={titleId} className="text-base font-semibold">
          {confirm.title}
        </h2>
        <p
          id={messageId}
          className="mt-2 text-sm text-zinc-600 dark:text-zinc-400"
        >
          {confirm.message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-zinc-800 pointer-coarse:min-h-11"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              actions.runConfirmed(confirm.action);
            }}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:outline-none pointer-coarse:min-h-11"
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
