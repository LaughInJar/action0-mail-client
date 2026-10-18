import type {
  GmailHeader,
  GmailLabel,
  GmailMessage,
  GmailMessagePart,
} from "../providers/gmail/types";

/** base64url-encodes bytes (as Gmail does for part bodies). */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** base64url of a string's UTF-8 bytes. */
export const utf8Base64Url = (text: string) =>
  base64Url(new TextEncoder().encode(text));

/** A Gmail label as returned by `labels.get`. */
export function gmailLabel(
  id: string,
  overrides: Partial<GmailLabel> = {},
): GmailLabel {
  const system = /^[A-Z_]+$/.test(id);
  return {
    id,
    name: overrides.name ?? id,
    type: system ? "system" : "user",
    messagesTotal: 10,
    messagesUnread: 2,
    ...overrides,
  };
}

/** A leaf part with a body. */
export function leafPart(
  mimeType: string,
  data: string,
  {
    headers = [],
    filename = "",
    partId = "0",
    attachmentId,
    size,
  }: {
    headers?: GmailHeader[];
    filename?: string;
    partId?: string;
    attachmentId?: string;
    size?: number;
  } = {},
): GmailMessagePart {
  return {
    partId,
    mimeType,
    filename,
    headers: [{ name: "Content-Type", value: mimeType }, ...headers],
    body: {
      size: size ?? data.length,
      ...(attachmentId === undefined ? { data } : { attachmentId }),
    },
  };
}

/** A multipart container. */
export function multipart(
  subtype: string,
  parts: GmailMessagePart[],
  headers: GmailHeader[] = [],
): GmailMessagePart {
  return {
    mimeType: `multipart/${subtype}`,
    filename: "",
    headers: [
      { name: "Content-Type", value: `multipart/${subtype}; boundary=x` },
      ...headers,
    ],
    body: { size: 0 },
    parts,
  };
}

/** A Gmail message with sensible defaults. */
export function gmailMessage(
  id: string,
  {
    labelIds = ["INBOX"],
    headers = [],
    payload,
    snippet = "Snippet",
    internalDate = "1760000000000",
  }: {
    labelIds?: string[];
    headers?: GmailHeader[];
    payload?: GmailMessagePart;
    snippet?: string;
    internalDate?: string;
  } = {},
): GmailMessage {
  const baseHeaders: GmailHeader[] = [
    { name: "From", value: '"Anna Berger" <anna@example.org>' },
    { name: "To", value: "me@example.com" },
    { name: "Subject", value: `Subject ${id}` },
    ...headers,
  ];
  const body =
    payload ?? leafPart("text/plain", utf8Base64Url(`Body of ${id}`));
  return {
    id,
    threadId: `t-${id}`,
    labelIds,
    snippet,
    internalDate,
    payload: { ...body, headers: [...baseHeaders, ...(body.headers ?? [])] },
  };
}
