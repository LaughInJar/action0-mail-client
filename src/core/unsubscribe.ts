import type { Unsubscribe } from "./model";
import { parseMailto } from "./mailto";

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
    if (/^mailto:/i.test(url)) mail ??= unsubscribeMail(url);
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

/** Address, subject and body of an unsubscribe `mailto:` URL. */
function unsubscribeMail(url: string): Unsubscribe["mail"] {
  const fields = parseMailto(url);
  const to = fields?.to.find((address) =>
    /^[^\s@]+@[^\s@]+$/.test(address.address),
  )?.address;
  if (fields === undefined || to === undefined) return undefined;
  return {
    to,
    ...(fields.subject ? { subject: fields.subject } : {}),
    ...(fields.body ? { body: fields.body } : {}),
  };
}
