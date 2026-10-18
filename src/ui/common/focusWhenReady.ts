/** Options of {@link focusWhenReady}. */
export interface FocusWhenReadyOptions {
  readonly timeoutMs?: number;
  /** Waits until the element passes this check (e.g. shows the right list). */
  readonly accept?: (element: HTMLElement) => boolean;
}

/**
 * Focuses the element with `id` as soon as it exists and can take focus
 * (e.g. once a pane or drawer has opened); text fields get their text
 * selected. Gives up after `timeoutMs`, or when the user starts typing in
 * another field meanwhile.
 */
export function focusWhenReady(
  id: string,
  { timeoutMs = 2000, accept = () => true }: FocusWhenReadyOptions = {},
): void {
  const until = Date.now() + timeoutMs;
  const from = document.activeElement;
  const attempt = () => {
    const active = document.activeElement;
    if (active !== from && isTextField(active)) return;
    const element = document.getElementById(id);
    if (element && accept(element)) {
      element.focus();
      if (document.activeElement === element) {
        if (element instanceof HTMLInputElement) element.select();
        return;
      }
    }
    if (Date.now() < until) requestAnimationFrame(attempt);
  };
  attempt();
}

const isTextField = (element: Element | null) =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
