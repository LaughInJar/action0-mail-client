import { asAttachmentId } from "../../core/ids";
import type { AttachmentInfo, MessageBody } from "../../core/model";
import { decodeBase64Url } from "../../lib/base64url";
import type { GmailHeader, GmailMessagePart } from "./types";

/** Body and attachments extracted from a Gmail MIME tree. */
export interface ParsedPayload {
  readonly body: MessageBody;
  readonly attachments: AttachmentInfo[];
}

/** Value of the first header called `name` (case-insensitive). */
export function getHeader(
  headers: readonly GmailHeader[] | undefined,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((header) => header.name.toLowerCase() === lower)?.value;
}

/**
 * Walks a Gmail `format=full` payload:
 * - In `multipart/alternative`, the richest variant wins (HTML over text).
 * - Parts with a filename, `Content-Disposition: attachment`, or a
 *   `Content-ID` on non-text content become attachments.
 * - Text is decoded with the charset declared on its part.
 */
export function parsePayload(
  payload: GmailMessagePart | undefined,
): ParsedPayload {
  const attachments: AttachmentInfo[] = [];
  const body = payload ? walk(payload, attachments) : {};
  return { body, attachments };
}

function walk(
  part: GmailMessagePart,
  attachments: AttachmentInfo[],
): MessageBody {
  const mimeType = (part.mimeType ?? "").toLowerCase();

  if (mimeType.startsWith("multipart/")) {
    const children = part.parts ?? [];
    const bodies = children.map((child) => walk(child, attachments));
    if (mimeType === "multipart/alternative") {
      // Later alternatives are richer (RFC 2046 §5.1.4).
      const html = bodies.findLast((b) => b.html !== undefined)?.html;
      const text = bodies.findLast((b) => b.text !== undefined)?.text;
      return withOptional(html, text);
    }
    const html = bodies.find((b) => b.html !== undefined)?.html;
    const text = bodies.find((b) => b.text !== undefined)?.text;
    return withOptional(html, text);
  }

  if (isAttachment(part, mimeType)) {
    attachments.push(toAttachment(part, mimeType));
    return {};
  }
  if (mimeType === "text/html") return { html: decodePartText(part) };
  if (mimeType === "text/plain" || mimeType === "")
    return { text: decodePartText(part) };
  return {};
}

function isAttachment(part: GmailMessagePart, mimeType: string): boolean {
  if (part.filename) return true;
  const disposition = getHeader(
    part.headers,
    "Content-Disposition",
  )?.toLowerCase();
  if (disposition?.startsWith("attachment")) return true;
  if (mimeType.startsWith("text/") || mimeType === "") return false;
  // Inline images and other non-text leaves.
  return (
    getHeader(part.headers, "Content-ID") !== undefined ||
    part.body?.attachmentId !== undefined ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("application/") ||
    mimeType.startsWith("message/")
  );
}

function toAttachment(
  part: GmailMessagePart,
  mimeType: string,
): AttachmentInfo {
  const contentId = getHeader(part.headers, "Content-ID")
    ?.trim()
    .replace(/^<|>$/g, "");
  const id = part.body?.attachmentId ?? `part:${part.partId ?? ""}`;
  return {
    id: asAttachmentId(id),
    filename: decodeMimeWords(part.filename ?? "") || contentId || "attachment",
    mimeType: mimeType || "application/octet-stream",
    size: part.body?.size ?? 0,
    ...(contentId ? { contentId } : {}),
  };
}

/** Decodes the base64url body of a text part using its declared charset. */
export function decodePartText(part: GmailMessagePart): string {
  const bytes = decodeBase64Url(part.body?.data ?? "");
  return decodeBytes(bytes, charsetOf(getHeader(part.headers, "Content-Type")));
}

/** Extracts the `charset` parameter of a Content-Type header value. */
export function charsetOf(contentType: string | undefined): string | undefined {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return match?.[1];
}

/** Decodes bytes with the given charset, falling back to UTF-8 for unknown labels. */
export function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

/**
 * Decodes RFC 2047 encoded words (`=?charset?B|Q?...?=`) in a header value.
 * Gmail usually decodes headers already; this is a safety net.
 */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, "$1")
    .replace(
      /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
      (match, charset: string, encoding: string, text: string) => {
        try {
          const bytes =
            encoding.toLowerCase() === "b"
              ? decodeBase64Url(text)
              : decodeQ(text);
          return decodeBytes(bytes, charset.replace(/\*.*$/, ""));
        } catch {
          return match;
        }
      },
    );
}

function decodeQ(text: string): Uint8Array {
  const bytes: number[] = [];
  const input = text.replace(/_/g, " ");
  for (let i = 0; i < input.length; i++) {
    const char = input[i] ?? "";
    const hex = input.slice(i + 1, i + 3);
    if (char === "=" && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return new Uint8Array(bytes);
}

function withOptional(
  html: string | undefined,
  text: string | undefined,
): MessageBody {
  return {
    ...(html === undefined ? {} : { html }),
    ...(text === undefined ? {} : { text }),
  };
}
