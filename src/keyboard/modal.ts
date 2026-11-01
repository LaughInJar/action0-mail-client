/** Inside an element with `data-own-keys` (the composer), single keys are text, not shortcuts. */
export function ownsKeys(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest("[data-own-keys]") !== null
  );
}

/** True while a modal dialog is shown (closed drawers are `inert`). */
export function isModalOpen(): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
    (dialog) => dialog.closest("[inert]") === null,
  );
}
