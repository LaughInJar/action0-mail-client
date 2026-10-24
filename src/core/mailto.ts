/**
 * `mailto:` URLs (RFC 6068): recipients, subject and text of a mail to
 * write. Used for links in mail, `mailto:` links the desktop app receives
 * from the system, and unsubscribe mails.
 */
import { parseAddressList } from "./addresses";
import type { EmailAddress } from "./model";

/** What a `mailto:` URL asks to write. */
export interface MailtoFields {
  readonly to: EmailAddress[];
  readonly cc: EmailAddress[];
  readonly bcc: EmailAddress[];
  readonly subject: string;
  /** Plain text (RFC 6068: `body` is text, lines separated by CRLF). */
  readonly body: string;
}

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * The fields of a `mailto:` URL; undefined if it isn't one. Unknown or
 * dangerous fields (e.g. other headers) are ignored. `+` is a plus, not a
 * space (unlike HTML forms).
 */
export function parseMailto(url: string): MailtoFields | undefined {
  if (!/^mailto:/i.test(url)) return undefined;
  const rest = url.slice("mailto:".length);
  const at = rest.indexOf("?");
  const path = at === -1 ? rest : rest.slice(0, at);
  const query = at === -1 ? "" : rest.slice(at + 1);
  const lists = {
    to: [decode(path) ?? ""],
    cc: [] as string[],
    bcc: [] as string[],
  };
  let subject = "";
  let body = "";
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    const name = decode(pair.slice(0, equals))?.toLowerCase();
    const value = decode(pair.slice(equals + 1));
    if (name === undefined || value === undefined) continue;
    if (name === "to" || name === "cc" || name === "bcc")
      lists[name].push(value);
    else if (name === "subject" && !subject) subject = value;
    else if (name === "body" && !body) body = value;
  }
  const addresses = (values: readonly string[]) =>
    values.flatMap((value) => parseAddressList(value));
  return {
    to: addresses(lists.to),
    cc: addresses(lists.cc),
    bcc: addresses(lists.bcc),
    subject,
    body: body.replace(/\r\n/g, "\n"),
  };
}
