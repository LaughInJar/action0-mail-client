import {
  asAttachmentId,
  asMailboxId,
  asMessageId,
  asThreadId,
} from "../../core/ids";
import type {
  AttachmentInfo,
  EmailAddress,
  Invitation,
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
import { categoryId } from "./folders";

/** `$select` for list rows. */
export const SUMMARY_SELECT =
  "id,conversationId,parentFolderId,from,toRecipients,subject,bodyPreview,receivedDateTime,createdDateTime,isRead,isDraft,flag,hasAttachments,categories";

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
/**
 * Snooze's property of action0's own on a message: its return time (ISO),
 * or "back" once it came back (empty: neither).
 */
export const SNOOZE_PROPERTY =
  "String {8a3b7c2e-5d41-4f0a-9b6e-a0c1d2e3f405} Name action0Snooze";

/** `$expand` for {@link SNOOZE_PROPERTY}. */
export const SNOOZE_EXPAND = `singleValueExtendedProperties($filter=id eq '${SNOOZE_PROPERTY}')`;

export function toMessageSummary(message: GraphMessage): MessageSummary {
  const from = toAddress(message.from ?? message.sender);
  const snooze = message.singleValueExtendedProperties?.find(
    (property) => property.id.toLowerCase() === SNOOZE_PROPERTY.toLowerCase(),
  )?.value;
  const until =
    snooze && snooze !== "back" && !Number.isNaN(Date.parse(snooze))
      ? new Date(snooze).toISOString()
      : undefined;
  return {
    id: asMessageId(message.id),
    ...(message.conversationId
      ? { threadId: asThreadId(message.conversationId) }
      : {}),
    // The folder first (undo moves back to it), then the categories.
    mailboxIds: [
      ...(message.parentFolderId ? [asMailboxId(message.parentFolderId)] : []),
      ...(message.categories ?? []).map(categoryId),
    ],
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
    ...(until === undefined ? {} : { snoozedUntil: until }),
    ...(snooze === "back" ? { backFromSnooze: true as const } : {}),
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

const MEETING_MESSAGES: Readonly<Record<string, Invitation["method"]>> = {
  meetingRequest: "request",
  meetingCancelled: "cancel",
  meetingAccepted: "reply",
  meetingTenativelyAccepted: "reply",
  meetingDeclined: "reply",
};

/** The invitation an event message is about (from its expanded event). */
export function toInvitation(message: GraphMessage): Invitation | undefined {
  const method = MEETING_MESSAGES[message.meetingMessageType ?? ""];
  const uid = message.event?.iCalUId;
  return method && uid ? { uid, method } : undefined;
}

/** A whole message, with the metadata of its attachments. */
export function toMessage(
  message: GraphMessage,
  attachments: readonly GraphAttachment[],
  invitation?: Invitation,
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
    ...(invitation ? { invitation } : {}),
    body: bodyOf(message),
    attachments: attachments.flatMap((attachment) => {
      const info = toAttachmentInfo(attachment);
      return info ? [info] : [];
    }),
  };
}
