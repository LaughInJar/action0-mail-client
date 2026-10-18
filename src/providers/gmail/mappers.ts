import { asMailboxId, asMessageId, asThreadId } from "../../core/ids";
import type { Message, MessageSummary } from "../../core/model";
import { parseAddressList } from "./addresses";
import { isMembershipLabel } from "./labels";
import { decodeMimeWords, getHeader, parsePayload } from "./mime";
import type { GmailMessage } from "./types";

/** Headers requested for list rows (`format=metadata`). */
export const SUMMARY_HEADERS = [
  "From",
  "To",
  "Subject",
  "Date",
  "Content-Type",
] as const;

/** Maps a Gmail message (`format=metadata` or `full`) to a list row. */
export function toMessageSummary(message: GmailMessage): MessageSummary {
  const labelIds = message.labelIds ?? [];
  const headers = message.payload?.headers;
  const from = parseAddressList(getHeader(headers, "From"))[0];
  const contentType = (
    getHeader(headers, "Content-Type") ??
    message.payload?.mimeType ??
    ""
  ).toLowerCase();

  return {
    id: asMessageId(message.id),
    threadId: asThreadId(message.threadId),
    mailboxIds: labelIds.filter(isMembershipLabel).map(asMailboxId),
    ...(from ? { from } : {}),
    to: parseAddressList(getHeader(headers, "To")),
    subject: decodeMimeWords(getHeader(headers, "Subject") ?? "").trim(),
    snippet: decodeHtmlEntities(message.snippet ?? ""),
    receivedAt: receivedAt(message),
    flags: {
      seen: !labelIds.includes("UNREAD"),
      flagged: labelIds.includes("STARRED"),
    },
    // Gmail's metadata format has no part list; a top-level multipart/mixed
    // almost always means "has attachments".
    hasAttachments: contentType.startsWith("multipart/mixed"),
  };
}

/** Maps a Gmail message fetched with `format=full`. */
export function toMessage(message: GmailMessage): Message {
  const headers = message.payload?.headers;
  const { body, attachments } = parsePayload(message.payload);
  return {
    ...toMessageSummary(message),
    hasAttachments: attachments.some(
      (attachment) => attachment.contentId === undefined,
    ),
    cc: parseAddressList(getHeader(headers, "Cc")),
    bcc: parseAddressList(getHeader(headers, "Bcc")),
    replyTo: parseAddressList(getHeader(headers, "Reply-To")),
    body,
    attachments,
  };
}

function receivedAt(message: GmailMessage): string {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0)
    return new Date(internal).toISOString();
  const header = Date.parse(getHeader(message.payload?.headers, "Date") ?? "");
  return new Date(Number.isNaN(header) ? 0 : header).toISOString();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the HTML entities Gmail uses in snippets (`&#39;`, `&amp;`, ...). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const hex = entity[1]?.toLowerCase() === "x";
        const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}
