import DOMPurify, { type Config } from "dompurify";

/** Result of {@link sanitizeMailHtml}. */
export interface SanitizedMail {
  /** A complete, sanitized HTML document. */
  readonly html: string;
  /**
   * True if the mail references remote resources (images, CSS backgrounds,
   * imports). They stay blocked by the iframe's CSP until the user allows
   * them; this flag decides whether to offer that.
   */
  readonly hasRemoteContent: boolean;
}

/** Elements that could run code, submit data, navigate, or load other documents. */
const FORBIDDEN_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "noscript",
];

const CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  FORBID_TAGS: FORBIDDEN_TAGS,
  FORBID_ATTR: ["srcdoc", "formaction", "ping", "action"],
  ADD_ATTR: ["target"],
  ALLOW_DATA_ATTR: false,
};

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const REMOTE_SRCSET = /(?:^|,)\s*(?:https?:)?\/\//i;
const REMOTE_CSS = /url\(\s*['"]?\s*(?:https?:)?\/\/|@import/i;
const URL_ATTRIBUTES = ["src", "background", "poster", "data", "href"] as const;

let purifier: ReturnType<typeof DOMPurify> | undefined;
/** Set by the hooks during one (synchronous) sanitize call. */
let remoteFound = false;

function getPurifier() {
  if (purifier) return purifier;
  const instance = DOMPurify(window);

  instance.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && REMOTE_CSS.test(node.textContent ?? ""))
      remoteFound = true;
  });

  instance.addHook("afterSanitizeAttributes", (node) => {
    const tag = node.tagName.toLowerCase();
    for (const attribute of URL_ATTRIBUTES) {
      // Links don't load anything by themselves.
      if (attribute === "href" && tag !== "image" && tag !== "use") continue;
      const value = node.getAttribute(attribute);
      if (value !== null && REMOTE_URL.test(value)) remoteFound = true;
    }
    const srcset = node.getAttribute("srcset");
    if (srcset !== null && REMOTE_SRCSET.test(srcset)) remoteFound = true;
    const style = node.getAttribute("style");
    if (style !== null && REMOTE_CSS.test(style)) remoteFound = true;

    if (tag === "a" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });

  purifier = instance;
  return instance;
}

/**
 * Sanitizes the HTML body of a mail for display.
 *
 * This is the first of three layers: DOMPurify removes scripts, event
 * handlers, `javascript:` URLs, forms and embedded documents. The sandboxed
 * iframe (no `allow-scripts`) and its CSP (see `mailDocument.ts`) are the
 * other two.
 */
export function sanitizeMailHtml(html: string): SanitizedMail {
  const instance = getPurifier();
  remoteFound = false;
  try {
    const clean = instance.sanitize(html, {
      ...CONFIG,
      RETURN_TRUSTED_TYPE: false,
    });
    return { html: clean, hasRemoteContent: remoteFound };
  } finally {
    remoteFound = false;
  }
}
