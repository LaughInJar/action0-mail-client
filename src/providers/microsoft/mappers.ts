import {
  asAttachmentId,
  asMailboxId,
  asMessageId,
  asThreadId,
} from "../../core/ids";
import type {
  AttachmentInfo,
  EmailAddress,
  Message,
  MessageBody,
  MessageSummary,
} from "../../core/model";
import { parseListUnsubscribe } from "../../core/unsubscribe";
import type {
  GraphAttachment,
  GraphHeader,
  GraphMessage,
  GraphRecipient,
} from "./types";

/** `$select` for list rows. */
export const SUMMARY_SELECT =
  "id,conversationId,parentFolderId,from,toRecipients,subject,bodyPreview,receivedDateTime,createdDateTime,isRead,isDraft,flag,hasAttachments";

/** `$select` for a whole message (its attachments come separately). */
export const MESSAGE_SELECT = `${SUMMARY_SELECT},ccRecipients,bccRecipients,replyTo,internetMessageId,internetMessageHeaders,body`;

/** `$select` for attachment metadata, without their bytes. */
export const ATTACHMENT_SELECT =
  "id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId";

const FILE = "#microsoft.graph.fileAttachment";
const ITEM = "#microsoft.graph.itemAttachment";

/** A recipient as an address, if it has one. */
export function toAddress(
  recipient: GraphRecipient | undefined,
): EmailAddress | undefined {
  const address = recipient?.emailAddress?.address?.trim();
  if (!address) return undefined;
  const name = recipient?.emailAddress?.name?.trim();
  return name && name !== address ? { name, address } : { address };
}

/** Recipients as addresses (those without one are left out). */
export function toAddresses(
  recipients: readonly GraphRecipient[] | undefined,
): EmailAddress[] {
  return (recipients ?? []).flatMap((recipient) => {
    const address = toAddress(recipient);
    return address ? [address] : [];
  });
}

/** An address as a Graph recipient. */
export function toRecipient({ name, address }: EmailAddress): GraphRecipient {
  return { emailAddress: { address, ...(name ? { name } : {}) } };
}

/** A header's value (case-insensitive name). */
export function headerOf(
  headers: readonly GraphHeader[] | undefined,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((header) => header.name.toLowerCase() === lower)?.value;
}

/** `<id>` tokens of a `References` or `In-Reply-To` header. */
export function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

/** A list row. */
export function toMessageSummary(message: GraphMessage): MessageSummary {
  const from = toAddress(message.from ?? message.sender);
  return {
    id: asMessageId(message.id),
    ...(message.conversationId
      ? { threadId: asThreadId(message.conversationId) }
      : {}),
    mailboxIds: message.parentFolderId
      ? [asMailboxId(message.parentFolderId)]
      : [],
    ...(from ? { from } : {}),
    to: toAddresses(message.toRecipients),
    subject: message.subject ?? "",
    snippet: (message.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
    receivedAt: new Date(
      message.receivedDateTime ?? message.createdDateTime ?? 0,
    ).toISOString(),
    flags: {
      seen: message.isRead ?? true,
      flagged: message.flag?.flagStatus === "flagged",
    },
    hasAttachments: message.hasAttachments ?? false,
  };
}

/** Metadata of an attachment; Outlook items (attached mails) become `.eml` files. */
export function toAttachmentInfo(
  attachment: GraphAttachment,
): AttachmentInfo | undefined {
  const type = attachment["@odata.type"] ?? FILE;
  if (type !== FILE && type !== ITEM) return undefined; // cloud links
  const item = type === ITEM;
  const name = attachment.name?.trim() || "attachment";
  return {
    id: asAttachmentId(attachment.id),
    filename: item && !/\.eml$/i.test(name) ? `${name}.eml` : name,
    mimeType: item
      ? "message/rfc822"
      : attachment.contentType || "application/octet-stream",
    size: attachment.size ?? 0,
    ...(attachment.isInline && attachment.contentId
      ? { contentId: attachment.contentId.replace(/^<|>$/g, "") }
      : {}),
  };
}

function bodyOf(message: GraphMessage): MessageBody {
  const content = message.body?.content ?? "";
  if (content === "") return {};
  return message.body?.contentType === "text"
    ? { text: content }
    : { html: content };
}

/** A whole message, with the metadata of its attachments. */
export function toMessage(
  message: GraphMessage,
  attachments: readonly GraphAttachment[],
): Message {
  const headers = message.internetMessageHeaders;
  const unsubscribe = parseListUnsubscribe(
    headerOf(headers, "List-Unsubscribe"),
    headerOf(headers, "List-Unsubscribe-Post"),
  );
  const [own] = messageIds(message.internetMessageId);
  return {
    ...toMessageSummary(message),
    cc: toAddresses(message.ccRecipients),
    bcc: toAddresses(message.bccRecipients),
    replyTo: toAddresses(message.replyTo),
    ...(own === undefined ? {} : { internetMessageId: own }),
    references: messageIds(headerOf(headers, "References")),
    ...(unsubscribe ? { unsubscribe } : {}),
    body: bodyOf(message),
    attachments: attachments.flatMap((attachment) => {
      const info = toAttachmentInfo(attachment);
      return info ? [info] : [];
    }),
  };
}
