/**
 * Reading a raw message (RFC 5322 / MIME) for "Show original": its
 * headers, what the receiving server found about the sender, the way it
 * travelled, and its source with big encoded parts left out. For display
 * only: the app doesn't trust or act on any of it.
 */

/** One header, unfolded. */
export interface RawHeader {
  readonly name: string;
  /** The value with encoded words (RFC 2047) decoded. */
  readonly value: string;
  /** The value as it is in the message (unfolded). */
  readonly raw: string;
}

/** One check of an `Authentication-Results` header (RFC 8601). */
export interface AuthCheck {
  readonly method: "spf" | "dkim" | "dmarc";
  /** `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`, … (lower case). */
  readonly result: string;
  /** The domain checked: SPF's envelope sender, DKIM's signer, DMARC's From. */
  readonly domain?: string;
}

/** One server on the way, from a `Received` header. */
export interface Hop {
  /** The server it came from, as that server named itself. */
  readonly from?: string;
  /** The server that received it. */
  readonly by?: string;
  /** The protocol (`SMTP`, `ESMTPS`, `HTTP`, …). */
  readonly with?: string;
  /** When it arrived there (ms since 1970), if the date is readable. */
  readonly at?: number;
  /**
   * Time since the hop before (for the first hop: since the `Date`
   * header), in ms; negative when the servers' clocks disagree.
   */
  readonly delay?: number;
}

/** A piece of the source as shown: text, or an encoded part left out. */
export type SourceSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "collapsed";
      readonly filename?: string;
      readonly mimeType: string;
      /** `base64` or `quoted-printable`. */
      readonly encoding: string;
      /** About how many bytes the part holds, decoded. */
      readonly size: number;
    };

/** Encoded parts larger than this (characters) are left out of the shown source. */
export const COLLAPSE_LIMIT = 100_000;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const windows1252 = new TextDecoder("windows-1252");

/** The message as text: UTF-8, or Windows-1252 when it isn't valid UTF-8 (old 8-bit mail). */
export function rawText(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return windows1252.decode(bytes);
  }
}

/** Splits a message (or MIME part) at its first empty line. */
export function splitMessage(text: string): {
  readonly head: string;
  /** The line break(s) between head and body. */
  readonly separator: string;
  readonly body: string;
} {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { head: text, separator: "", body: "" };
  return {
    head: text.slice(0, match.index),
    separator: match[0],
    body: text.slice(match.index + match[0].length),
  };
}

/** The headers of a header block, in order, unfolded and decoded. */
export function parseHeaders(head: string): RawHeader[] {
  const found: { name: string; raw: string }[] = [];
  for (const line of head.split(/\r?\n/)) {
    const last = found.at(-1);
    if (/^[ \t]/.test(line)) {
      // A folded line continues the header above it.
      if (last) last.raw = `${last.raw} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    // Not a header (like an mbox "From " line): skipped.
    if (colon <= 0 || /\s/.test(line.slice(0, colon))) continue;
    found.push({
      name: line.slice(0, colon),
      raw: line.slice(colon + 1).trim(),
    });
  }
  return found.map(({ name, raw }) => ({
    name,
    raw,
    value: decodeWords(raw),
  }));
}

/** The first header called `name` (any case), decoded. */
export function headerValue(
  headers: readonly RawHeader[],
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === wanted)?.value;
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi;

/**
 * Decodes RFC 2047 encoded words (`=?UTF-8?B?…?=`, `=?ISO-8859-1?Q?…?=`).
 * Adjacent words of one charset are decoded together (a character may be
 * split across them) and the space between them goes away; broken words
 * stay as they are.
 */
export function decodeWords(value: string): string {
  // Bytes of encoded words not decoded yet (one charset).
  const run = { charset: "", bytes: [] as number[] };
  let out = "";
  let last = 0;
  const flush = () => {
    if (run.bytes.length > 0) out += decodeBytes(run.charset, run.bytes);
    run.bytes = [];
  };
  for (const match of value.matchAll(ENCODED_WORD)) {
    const between = value.slice(last, match.index);
    last = match.index + match[0].length;
    // Only whitespace between two encoded words: it isn't part of the text.
    if (run.bytes.length === 0 || !/^\s*$/.test(between)) {
      flush();
      out += between;
    }
    const [word, spec = "", encoding = "", text = ""] = match;
    const charset = (spec.split("*")[0] ?? "").toLowerCase();
    const bytes =
      encoding.toLowerCase() === "b" ? base64Bytes(text) : qBytes(text);
    if (bytes === null) {
      flush();
      out += word;
      continue;
    }
    if (run.charset !== charset) flush();
    run.charset = charset;
    run.bytes.push(...bytes);
  }
  flush();
  return out + value.slice(last);
}

function base64Bytes(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** RFC 2047's Q encoding: `_` is a space, `=XX` a byte. */
function qBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    const hex = text.slice(i + 1, i + 3);
    if (char === "=" && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (char === "_") bytes.push(0x20);
    else bytes.push(...encoder.encode(char));
  }
  return bytes;
}

function decodeBytes(charset: string, bytes: readonly number[]): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(Uint8Array.from(bytes));
}

/** Text without RFC 5322 comments (`(…)`, nested ones too). */
function withoutComments(text: string): string {
  let result = text;
  for (let previous = ""; previous !== result;) {
    previous = result;
    result = result.replace(/\([^()]*\)/g, " ");
  }
  return result.replace(/\s+/g, " ").trim();
}

/**
 * SPF, DKIM and DMARC as the topmost `Authentication-Results` header
 * reports them: that one was added by the account's own provider, while
 * lower ones may come from anywhere (a sender can write any header).
 */
export function authResults(headers: readonly RawHeader[]): AuthCheck[] {
  const header = headerValue(headers, "Authentication-Results");
  if (header === undefined) return [];
  const checks: AuthCheck[] = [];
  for (const part of withoutComments(header).split(";")) {
    const match = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(part);
    if (!match) continue;
    const method = (match[1] ?? "").toLowerCase() as AuthCheck["method"];
    const property = (key: string) =>
      new RegExp(`(?:^|\\s)${key.replace(".", "\\.")}=("[^"]*"|\\S+)`, "i")
        .exec(part)?.[1]
        ?.replace(/^"|"$/g, "");
    const raw =
      method === "spf"
        ? (property("smtp.mailfrom") ?? property("smtp.helo"))
        : method === "dkim"
          ? (property("header.d") ?? property("header.i"))
          : property("header.from");
    // An address or "@domain": the domain is what's checked.
    const domain = raw?.slice(raw.lastIndexOf("@") + 1).toLowerCase();
    checks.push({
      method,
      result: (match[2] ?? "").toLowerCase(),
      ...(domain ? { domain } : {}),
    });
  }
  return checks;
}

/**
 * The servers the message passed, oldest first (`Received` headers are
 * added on top), with the time it spent before each.
 */
export function deliveryPath(headers: readonly RawHeader[]): Hop[] {
  const sent = Date.parse(withoutComments(headerValue(headers, "Date") ?? ""));
  let before = Number.isNaN(sent) ? undefined : sent;
  return headers
    .filter((header) => header.name.toLowerCase() === "received")
    .reverse()
    .map((header): Hop => {
      const text = withoutComments(header.raw);
      const semicolon = text.lastIndexOf(";");
      const route = semicolon === -1 ? text : text.slice(0, semicolon);
      const parsed =
        semicolon === -1 ? NaN : Date.parse(text.slice(semicolon + 1).trim());
      const at = Number.isNaN(parsed) ? undefined : parsed;
      const word = (key: string) =>
        new RegExp(`(?:^|\\s)${key}\\s+(\\S+)`, "i").exec(route)?.[1];
      const [from, by, via] = [word("from"), word("by"), word("with")];
      const hop: Hop = {
        ...(from ? { from } : {}),
        ...(by ? { by } : {}),
        ...(via ? { with: via } : {}),
        ...(at === undefined ? {} : { at }),
        ...(at !== undefined && before !== undefined
          ? { delay: at - before }
          : {}),
      };
      if (at !== undefined) before = at;
      return hop;
    });
}

/**
 * The source for display: the text as it is, except that base64 and
 * quoted-printable parts longer than `limit` characters become one
 * `collapsed` segment each (so a mail with big attachments stays quick to
 * show). Joining the text segments and the collapsed parts' bodies gives
 * the source back.
 */
export function sourceSegments(
  text: string,
  limit = COLLAPSE_LIMIT,
): SourceSegment[] {
  const segments: SourceSegment[] = [];
  const add = (piece: string) => {
    if (piece === "") return;
    const last = segments.at(-1);
    if (last?.kind === "text")
      segments[segments.length - 1] = { kind: "text", text: last.text + piece };
    else segments.push({ kind: "text", text: piece });
  };
  const walk = (part: string, depth: number) => {
    const { head, separator, body } = splitMessage(part);
    add(head + separator);
    const headers = parseHeaders(head);
    const type = headerValue(headers, "Content-Type") ?? "text/plain";
    const boundary = parameter(type, "boundary");
    if (/^\s*multipart\//i.test(type) && boundary && depth < 20) {
      const delimiter = `--${boundary}`;
      let chunk = "";
      let inPart = false;
      for (const line of body.split(/(?<=\n)/)) {
        const bare = line.replace(/\r?\n$/, "").trimEnd();
        if (bare !== delimiter && bare !== `${delimiter}--`) {
          chunk += line;
          continue;
        }
        if (inPart) walk(chunk, depth + 1);
        else add(chunk);
        add(line);
        chunk = "";
        inPart = bare === delimiter;
      }
      if (inPart) walk(chunk, depth + 1);
      else add(chunk);
      return;
    }
    const encoding = (headerValue(headers, "Content-Transfer-Encoding") ?? "")
      .trim()
      .toLowerCase();
    if (
      body.length > limit &&
      (encoding === "base64" || encoding === "quoted-printable")
    ) {
      const disposition = headerValue(headers, "Content-Disposition") ?? "";
      const filename =
        parameter(disposition, "filename") ?? parameter(type, "name");
      const length = body.replace(/\s/g, "").length;
      segments.push({
        kind: "collapsed",
        mimeType: (type.split(";")[0] ?? "").trim().toLowerCase(),
        encoding,
        size: encoding === "base64" ? Math.floor((length * 3) / 4) : length,
        ...(filename ? { filename } : {}),
      });
      // The line break before the next boundary stays visible.
      add(/\r?\n$/.exec(body)?.[0] ?? "");
      return;
    }
    add(body);
  };
  walk(text, 0);
  return segments;
}

/**
 * A parameter of a header value (`boundary`, `filename`), quoted or not,
 * including RFC 2231's `name*=utf-8''…` and its continuations.
 */
export function parameter(value: string, name: string): string | undefined {
  const params = new Map<string, string>();
  for (const match of value.matchAll(
    /;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g,
  )) {
    const [, key = "", raw = ""] = match;
    const trimmed = raw.trim();
    params.set(
      key.toLowerCase(),
      trimmed.startsWith('"')
        ? trimmed.slice(1, -1).replace(/\\(.)/g, "$1")
        : trimmed,
    );
  }
  const key = name.toLowerCase();
  const extended = params.get(`${key}*`);
  if (extended !== undefined) return decode2231(extended);
  if (params.has(`${key}*0`) || params.has(`${key}*0*`)) {
    let joined = "";
    let encoded = false;
    for (let i = 0; ; i++) {
      const plain = params.get(`${key}*${String(i)}`);
      const coded = params.get(`${key}*${String(i)}*`);
      if (plain === undefined && coded === undefined) break;
      if (i === 0) encoded = coded !== undefined;
      joined += coded ?? plain ?? "";
    }
    return encoded ? decode2231(joined) : joined;
  }
  const plain = params.get(key);
  return plain === undefined ? undefined : decodeWords(plain);
}

/** RFC 2231 `charset'language'percent-encoded`. */
function decode2231(value: string): string {
  const parts = value.split("'");
  const [charset, encoded] =
    parts.length >= 3
      ? [parts[0] ?? "", parts.slice(2).join("'")]
      : ["", value];
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const hex = encoded.slice(i + 1, i + 3);
    if (encoded[i] === "%" && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...encoder.encode(encoded[i] ?? ""));
  }
  return decodeBytes(charset || "utf-8", bytes);
}
