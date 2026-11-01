/**
 * Printing the page (its `@media print` layout), shared by the web and the
 * app platforms. The document's title names the print job and the PDF it
 * may be saved as, so it's set meanwhile.
 */

/**
 * The browser's print dialog. Chrome returns once it's closed (after
 * `afterprint`); others return at once, having taken the page as it is.
 */
export function printWindow(win: Window, title: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const before = win.document.title;
    win.document.title = title;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      win.removeEventListener("afterprint", done);
      win.document.title = before;
      resolve();
    };
    win.addEventListener("afterprint", done);
    win.print();
    setTimeout(done, 1000);
  });
}

/**
 * A print dialog of the system's (macOS' print panel, Android's print
 * service), started by `start`. These render the page while they're open
 * and say nothing when they close, so this resolves only once the user is
 * back in the page: their next click, touch or key, or the page showing
 * again (or after `fallbackMs`). Until then the print layout must stay.
 */
export async function printNatively(
  win: Window,
  title: string,
  start: () => Promise<unknown>,
  fallbackMs = 10 * 60_000,
): Promise<void> {
  const before = win.document.title;
  win.document.title = title;
  try {
    await start();
    await new Promise<void>((resolve) => {
      const events = ["pointerdown", "keydown"] as const;
      const timer = setTimeout(() => {
        done();
      }, fallbackMs);
      const done = () => {
        clearTimeout(timer);
        for (const event of events)
          win.removeEventListener(event, done, { capture: true });
        win.document.removeEventListener("visibilitychange", shown);
        resolve();
      };
      const shown = () => {
        if (win.document.visibilityState === "visible") done();
      };
      for (const event of events)
        win.addEventListener(event, done, { capture: true });
      win.document.addEventListener("visibilitychange", shown);
    });
  } finally {
    win.document.title = before;
  }
}
