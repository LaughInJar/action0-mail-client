/** Options of {@link buildMailDocument}. */
export interface MailDocumentOptions {
  /** Allow remote images (https/http). Everything else remote stays blocked. */
  readonly allowRemoteContent: boolean;
  /** `data:` URLs of inline images, keyed by content ID (`cid:` references). */
  readonly inlineImages?: Readonly<Record<string, string>>;
}

/**
 * CSP of the mail iframe. `default-src 'none'` blocks every fetch (images,
 * fonts, CSS imports, media, prefetch); `data:` images are inline parts.
 */
export function mailContentSecurityPolicy(allowRemoteContent: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    `img-src data:${allowRemoteContent ? " https: http:" : ""}`,
  ].join("; ");
}

const BASE_CSS = `
html { color-scheme: light; }
body { margin: 0; padding: 16px; font: 14px/1.5 system-ui, sans-serif; color: #111827; background: #fff; overflow-wrap: break-word; }
img { max-width: 100%; }
pre { white-space: pre-wrap; }
`;

/**
 * Turns sanitized mail HTML into the `srcdoc` of the sandboxed mail iframe:
 * resolves `cid:` images to `data:` URLs and puts the CSP first in `<head>`,
 * so it governs everything after it.
 *
 * Parsing uses `DOMParser`, which creates an inert document: nothing loads
 * or runs.
 */
export function buildMailDocument(
  sanitizedHtml: string,
  options: MailDocumentOptions,
): string {
  const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");

  for (const image of doc.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!/^cid:/i.test(src)) continue;
    const contentId = src.slice(4);
    const url =
      options.inlineImages?.[contentId] ??
      options.inlineImages?.[safeDecode(contentId)];
    // Unresolved (still loading, or missing): no src, so nothing is requested.
    if (url === undefined) image.removeAttribute("src");
    else image.setAttribute("src", url);
  }

  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute(
    "content",
    mailContentSecurityPolicy(options.allowRemoteContent),
  );

  const viewport = doc.createElement("meta");
  viewport.setAttribute("name", "viewport");
  viewport.setAttribute("content", "width=device-width, initial-scale=1");

  const referrer = doc.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer");

  const style = doc.createElement("style");
  style.textContent = BASE_CSS;

  doc.head.prepend(csp, viewport, referrer, style);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
