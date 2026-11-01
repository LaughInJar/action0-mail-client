/** Options of {@link buildPrintableMail}. */
export interface PrintableMailOptions {
  /** Allow remote images (https/http), as the reader does for this message. */
  readonly allowRemoteContent: boolean;
  /** `data:` URLs of inline images, keyed by content ID (`cid:` references). */
  readonly inlineImages?: Readonly<Record<string, string>>;
}

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
/** Remote `url(…)` in CSS. */
const REMOTE_CSS_URL = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;
/** `@import` rules (remote style sheets never load, as in the reader). */
const IMPORT = /@import[^;]*;?/gi;
/** `@font-face` rules with a remote source (fonts never load, as in the reader). */
const REMOTE_FONT_FACE = /@font-face\s*\{[^}]*(?:https?:)?\/\/[^}]*\}/gi;
const URL_ATTRIBUTES = ["src", "background", "poster", "data"] as const;

/** Styles of the printout around the mail: like the reader's frame, for paper. */
const PRINT_CSS = `
:host { display: block; color: #111827; font: 11pt/1.5 system-ui, sans-serif; overflow-wrap: break-word; }
img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; }
table { max-width: 100%; }
a { color: inherit; }
`;

/** CSS without what the reader's CSP would block. */
function cleanCss(css: string, allowRemoteContent: boolean): string {
  const withoutFonts = css.replace(IMPORT, "").replace(REMOTE_FONT_FACE, "");
  return allowRemoteContent
    ? withoutFonts
    : withoutFonts.replace(REMOTE_CSS_URL, "none");
}

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * A sanitized mail (from `sanitizeMailHtml`) as the inside of a shadow
 * root for printing: its own styles (kept inside the shadow root) and its
 * body, inline images resolved. The app's page allows remote images where
 * the reader's frame doesn't, so what the reader's CSP blocks is removed
 * here instead: remote images unless allowed, remote style sheets and
 * fonts always.
 */
export function buildPrintableMail(
  sanitizedHtml: string,
  options: PrintableMailOptions,
): string {
  const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");
  const { allowRemoteContent } = options;

  for (const image of doc.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!/^cid:/i.test(src)) continue;
    const contentId = src.slice(4);
    const url =
      options.inlineImages?.[contentId] ??
      options.inlineImages?.[safeDecode(contentId)];
    if (url === undefined) image.removeAttribute("src");
    else image.setAttribute("src", url);
  }

  for (const element of doc.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    if (!allowRemoteContent) {
      for (const attribute of URL_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value !== null && REMOTE_URL.test(value))
          element.removeAttribute(attribute);
      }
      const srcset = element.getAttribute("srcset");
      if (srcset !== null && /(?:^|,)\s*(?:https?:)?\/\//i.test(srcset))
        element.removeAttribute("srcset");
      if (tag === "image" || tag === "use")
        for (const attribute of ["href", "xlink:href"]) {
          const value = element.getAttribute(attribute);
          if (value !== null && REMOTE_URL.test(value))
            element.removeAttribute(attribute);
        }
    }
    const style = element.getAttribute("style");
    if (style !== null)
      element.setAttribute("style", cleanCss(style, allowRemoteContent));
    if (tag === "style")
      element.textContent = cleanCss(element.textContent, allowRemoteContent);
  }

  const styles = [...doc.querySelectorAll("style")]
    .map((style) => {
      style.remove();
      return style.outerHTML;
    })
    .join("");
  return `<style>${PRINT_CSS}</style>${styles}<div part="mail">${doc.body.innerHTML}</div>`;
}
