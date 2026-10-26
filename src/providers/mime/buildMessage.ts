/**
 * Builds RFC 5322 / MIME messages for sending: 7-bit clean, CRLF line
 * endings, UTF-8 everywhere. Shared by adapters that send raw messages
 * (Gmail, and IMAP/SMTP through the apps' native side).
 */
import { formatAddress } from "../../core/addresses";
import type { EmailAddress } from "../../core/model";
import { encodeBase64 } from "../../lib/base64url";

/** A file part of an outgoing message. */
export interface MimeAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
  /** Inline part, referenced from the HTML as `cid:<contentId>`. */
  readonly contentId?: string;
}

/** Everything {@link buildMessage} puts into a message. */
export interface OutgoingMessage {
  /** Omit to let the provider fill it in (Gmail does). */
  readonly from?: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** `Message-ID` of the message replied to. */
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly attachments?: readonly MimeAttachment[];
  readonly date?: Date;
  /** The message's own `Message-ID`, with angle brackets (see {@link newMessageId}). */
  readonly messageId?: string;
  /** Where replies should go. */
  readonly replyTo?: readonly EmailAddress[];
}

/** Options of {@link buildMessage}. */
export interface BuildOptions {
  /** Creates multipart boundaries (fixed in tests). */
  readonly boundary?: () => string;
  /**
   * Leaves the Bcc header out: the copy that goes over SMTP must not show
   * it (the copy kept in Sent does).
   */
  readonly withoutBcc?: boolean;
}

/** A new `Message-ID` for mail from `address`: random, at its domain. */
export function newMessageId(address: string): string {
  const domain = address.split("@").at(-1) || "action0.invalid";
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `<${random}@${domain}>`;
}

const CRLF = "\r\n";
const MAX_LINE = 76;
const encoder = new TextEncoder();

const randomBoundary = () =>
  `a0-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")}`;

/** Builds the raw message (headers and body), ready for an upload. */
export function buildMessage(
  message: OutgoingMessage,
  { boundary = randomBoundary, withoutBcc = false }: BuildOptions = {},
): string {
  const headers: string[] = [];
  if (message.from) headers.push(addressHeader("From", [message.from]));
  for (const [name, list] of [
    ["Reply-To", message.replyTo ?? []],
    ["To", message.to],
    ["Cc", message.cc],
    ["Bcc", withoutBcc ? [] : message.bcc],
  ] as const) {
    if (list.length > 0) headers.push(addressHeader(name, list));
  }
  headers.push(foldHeader("Subject", encodeWords(message.subject)));
  if (message.date) headers.push(`Date: ${formatDate(message.date)}`);
  if (message.messageId)
    headers.push(foldHeader("Message-ID", message.messageId));
  if (message.inReplyTo)
    headers.push(foldHeader("In-Reply-To", message.inReplyTo));
  if (message.references?.length)
    headers.push(foldHeader("References", message.references.join(" ")));
  headers.push("MIME-Version: 1.0");

  const attachments = message.attachments ?? [];
  const inline = attachments.filter((part) => part.contentId !== undefined);
  const files = attachments.filter((part) => part.contentId === undefined);

  let body: Part = multipart("alternative", boundary(), [
    textPart("text/plain", message.text),
    textPart("text/html", message.html),
  ]);
  if (inline.length > 0)
    body = multipart("related", boundary(), [body, ...inline.map(filePart)]);
  if (files.length > 0)
    body = multipart("mixed", boundary(), [body, ...files.map(filePart)]);

  return [...headers, ...body.headers, "", body.body].join(CRLF);
}

/** A MIME entity: its own headers and its (encoded) body. */
interface Part {
  readonly headers: readonly string[];
  readonly body: string;
}

function multipart(
  subtype: string,
  boundary: string,
  parts: readonly Part[],
): Part {
  const body = parts
    .map(
      (part) =>
        `--${boundary}${CRLF}${[...part.headers, "", part.body].join(CRLF)}`,
    )
    .join(CRLF);
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body: `${body}${CRLF}--${boundary}--`,
  };
}

function textPart(type: "text/plain" | "text/html", text: string): Part {
  return {
    headers: [
      `Content-Type: ${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: quoted-printable",
    ],
    body: encodeQuotedPrintable(text),
  };
}

function filePart(part: MimeAttachment): Part {
  const disposition = part.contentId === undefined ? "attachment" : "inline";
  return {
    headers: [
      `Content-Type: ${part.mimeType}; ${fileParameter("name", part.filename, false)}`,
      `Content-Disposition: ${disposition}; ${fileParameter("filename", part.filename, true)}`,
      "Content-Transfer-Encoding: base64",
      ...(part.contentId === undefined
        ? []
        : [`Content-ID: <${part.contentId}>`]),
    ],
    body: wrap(encodeBase64(part.content)),
  };
}

/**
 * A file name parameter. ASCII names are quoted; others use RFC 2231
 * (`filename*=UTF-8''…`) for the disposition and an encoded word for the
 * older `name` parameter, which is what mail clients understand.
 */
function fileParameter(name: string, value: string, rfc2231: boolean): string {
  if (isPrintableAscii(value))
    return `${name}="${value.replace(/(["\\])/g, "\\$1")}"`;
  if (rfc2231)
    return `${name}*=UTF-8''${encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  return `${name}="${encodeWords(value).replace(new RegExp(CRLF + " ", "g"), " ")}"`;
}

function addressHeader(name: string, list: readonly EmailAddress[]): string {
  const formatted = list.map((address) =>
    address.name && !isPrintableAscii(address.name)
      ? `${encodeWords(address.name)} <${address.address}>`
      : formatAddress(address),
  );
  // Fold between addresses.
  const lines: string[] = [];
  let line = `${name}:`;
  for (const [index, item] of formatted.entries()) {
    const piece = `${item}${index < formatted.length - 1 ? "," : ""}`;
    if (line.length + 1 + piece.length > MAX_LINE && line !== `${name}:`) {
      lines.push(line);
      line = ` ${piece}`;
    } else {
      line += ` ${piece}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/** Folds a header at spaces so lines stay within 76 characters where possible. */
function foldHeader(name: string, value: string): string {
  const words = value.split(" ");
  const lines: string[] = [];
  let line = `${name}:`;
  for (const word of words) {
    if (line.length + 1 + word.length > MAX_LINE && line !== `${name}:`) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

const isPrintableAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/**
 * RFC 2047: printable ASCII stays as it is; anything else becomes UTF-8
 * "B" encoded words of at most 64 characters, never splitting a character.
 * Words are separated by spaces (ignored when decoding), so the result can
 * be folded there.
 */
export function encodeWords(text: string): string {
  if (isPrintableAscii(text)) return text;
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length === 0) return;
    words.push(`=?UTF-8?B?${encodeBase64(Uint8Array.from(chunk))}?=`);
    chunk = [];
  };
  for (const char of text) {
    const bytes = encoder.encode(char);
    // 39 bytes → 52 base64 characters → 64 with the =?UTF-8?B??= frame,
    // so "Subject: " plus one word still fits in 78 characters.
    if (chunk.length + bytes.length > 39) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(" ");
}

/**
 * Quoted-printable (RFC 2045) of UTF-8 text with CRLF line breaks and soft
 * breaks after at most 76 characters. Also escapes a leading "." and
 * "From " so the text survives SMTP and mbox handling unchanged.
 */
export function encodeQuotedPrintable(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(encodeQuotedPrintableLine)
    .join(CRLF);
}

function encodeQuotedPrintableLine(line: string): string {
  const bytes = encoder.encode(line);
  const tokens: string[] = [];
  for (const [index, byte] of bytes.entries()) {
    const last = index === bytes.length - 1;
    const char = String.fromCharCode(byte);
    const literal =
      (byte >= 33 && byte <= 126 && byte !== 61) ||
      ((byte === 32 || byte === 9) && !last);
    tokens.push(
      literal ? char : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    );
  }
  if (tokens[0] === ".") tokens[0] = "=2E";
  if (line.startsWith("From ")) tokens[0] = "=46";

  // Soft line breaks: "=" at the end of a line that continues.
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (current.length + token.length > MAX_LINE - 1) {
      lines.push(`${current}=`);
      current = "";
    }
    current += token;
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Splits base64 into lines of 76 characters. */
function wrap(base64: string): string {
  return base64.match(/.{1,76}/g)?.join(CRLF) ?? "";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** RFC 5322 date in UTC, e.g. `Sun, 18 Oct 2026 12:00:00 +0000`. */
function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()] ?? ""}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}
