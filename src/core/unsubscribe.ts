import type { Unsubscribe } from "./model";

/** `List-Unsubscribe-Post` value that marks one-click support (RFC 8058). */
const ONE_CLICK = /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i;

/**
 * Reads the `List-Unsubscribe` header (RFC 2369: a list of `<URL>`s) and
 * `List-Unsubscribe-Post` (RFC 8058). One-click needs an https URL and the
 * `List-Unsubscribe=One-Click` post header; `mailto:` URLs become a mail to
 * send, and the first http(s) URL is the page. Anything else is ignored.
 * Returns undefined when no usable way is left.
 */
export function parseListUnsubscribe(
  header: string | undefined,
  postHeader: string | undefined,
): Unsubscribe | undefined {
  if (!header) return undefined;
  // Folded headers may put whitespace inside the brackets.
  const urls = [...header.matchAll(/<([^<>]*)>/g)].map((match) =>
    (match[1] ?? "").replace(/\s+/g, ""),
  );
  let mail: Unsubscribe["mail"];
  const pages: string[] = [];
  for (const url of urls) {
    if (/^mailto:/i.test(url)) mail ??= parseMailto(url);
    else {
      const page = webUrl(url);
      if (page) pages.push(page);
    }
  }
  const secure = pages.find((url) => url.startsWith("https:"));
  const page = secure ?? pages[0];
  const oneClick =
    postHeader !== undefined && ONE_CLICK.test(postHeader) ? secure : undefined;
  if (!oneClick && !mail && !page) return undefined;
  return {
    ...(oneClick ? { oneClick } : {}),
    ...(mail ? { mail } : {}),
    ...(page ? { page } : {}),
  };
}

/** The URL if it is http or https, normalized; otherwise undefined. */
function webUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Address, subject and body of a `mailto:` URL (RFC 6068: `+` is a plus). */
function parseMailto(url: string): Unsubscribe["mail"] {
  const [path = "", query = ""] = url.slice("mailto:".length).split("?", 2);
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const [key = "", value = ""] = pair.split("=", 2);
    const name = decode(key)?.toLowerCase();
    const decoded = decode(value);
    if (name && decoded !== undefined && !params.has(name))
      params.set(name, decoded);
  }
  const to = [decode(path), params.get("to")]
    .flatMap((list) => list?.split(",") ?? [])
    .map((address) => address.trim())
    .find((address) => /^[^\s@]+@[^\s@]+$/.test(address));
  if (to === undefined) return undefined;
  const subject = params.get("subject");
  const body = params.get("body");
  return {
    to,
    ...(subject ? { subject } : {}),
    ...(body ? { body } : {}),
  };
}

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}
