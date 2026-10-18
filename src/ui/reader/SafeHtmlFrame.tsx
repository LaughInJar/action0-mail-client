import { useEffect, useRef, useState } from "react";
import { useCommandRegistry } from "../../keyboard/context";

/**
 * Sandbox flags of the mail iframe. Never add `allow-scripts`: together with
 * `allow-same-origin` it would give mail content full access to the app.
 * - `allow-same-origin` (without scripts) lets the app measure the content.
 * - `allow-popups*` lets links open in a new, normal tab.
 */
export const MAIL_FRAME_SANDBOX =
  "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** Wide mails are scaled down to fit, but not below this factor; beyond that they scroll sideways. */
export const MIN_ZOOM = 0.6;

/** Props of {@link SafeHtmlFrame}. */
export interface SafeHtmlFrameProps {
  /** Complete document from `buildMailDocument()` (sanitized, with CSP). */
  readonly srcDoc: string;
  readonly title: string;
  /** Pass key presses inside the mail on to the app's shortcuts (default true). */
  readonly shortcuts?: boolean;
}

/**
 * Renders sanitized mail HTML in a sandboxed iframe that grows with its
 * content, so the reader pane scrolls as one. Wide mails are zoomed out to
 * fit the pane. Key presses inside the mail still reach the app's shortcuts.
 */
export function SafeHtmlFrame({
  srcDoc,
  title,
  shortcuts = true,
}: SafeHtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const registry = useCommandRegistry();
  const [height, setHeight] = useState(160);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let detach: (() => void) | undefined;

    const attach = () => {
      detach?.();
      const doc = frame.contentDocument;
      const root = doc?.documentElement;
      if (!doc || !root) return;

      const fit = () => {
        // Zoom the body and measure the unzoomed root, so the measurement
        // doesn't depend on how a browser reports sizes of zoomed elements.
        const body = doc.body;
        body.style.zoom = "";
        const available = frame.clientWidth;
        const natural = Math.max(root.scrollWidth, body.scrollWidth);
        const zoom =
          available > 0 && natural > available + 1
            ? Math.max(MIN_ZOOM, available / natural)
            : 1;
        if (zoom !== 1) body.style.zoom = String(zoom);
        // Below MIN_ZOOM the mail scrolls sideways; leave room for the scrollbar.
        const scrollbar = root.scrollWidth > available + 1 ? 16 : 0;
        const next = Math.ceil(root.getBoundingClientRect().height) + scrollbar;
        setHeight((previous) =>
          Math.abs(previous - next) > 1 ? next : previous,
        );
      };

      const observer =
        typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(fit);
      observer?.observe(frame);
      observer?.observe(doc.body);
      const onKeyDown = (event: KeyboardEvent) => {
        if (shortcuts) registry.handleKeyDown(event);
      };
      doc.addEventListener("keydown", onKeyDown);
      fit();

      detach = () => {
        observer?.disconnect();
        doc.removeEventListener("keydown", onKeyDown);
      };
    };

    frame.addEventListener("load", attach);
    return () => {
      frame.removeEventListener("load", attach);
      detach?.();
    };
  }, [registry, shortcuts]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={MAIL_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
      className="block w-full border-0 bg-white"
    />
  );
}
