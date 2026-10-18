import { isMailError } from "../../core/errors";
import { asCursor, type AttachmentId, type MessageId } from "../../core/ids";
import type {
  Mailbox,
  Message,
  MessageFlags,
  MessageSummary,
  Page,
} from "../../core/model";
import type {
  ListMessagesQuery,
  MailProvider,
  MutationResult,
  ProviderCapabilities,
} from "../../core/provider";
import { decodeBase64Url } from "../../lib/base64url";
import type { GmailHttp } from "./http";
import { ALL_MAIL_ID, isMappedLabel, mapLabels } from "./labels";
import { SUMMARY_HEADERS, toMessage, toMessageSummary } from "./mappers";
import type {
  GmailAttachment,
  GmailLabel,
  GmailListLabelsResponse,
  GmailListMessagesResponse,
  GmailMessage,
  GmailMessagePart,
} from "./types";

/** Mailboxes whose messages `messages.list` excludes unless asked explicitly. */
const SPAM_TRASH = new Set(["SPAM", "TRASH"]);

/** `messages.batchModify` accepts at most this many ids per call. */
export const BATCH_MODIFY_LIMIT = 1000;

/** Label changes of one `batchModify` call. */
interface LabelChange {
  readonly addLabelIds?: readonly string[];
  readonly removeLabelIds?: readonly string[];
}

/** {@link MailProvider} for Gmail, using the REST API (`gmail.modify` scope). */
export class GmailProvider implements MailProvider {
  readonly capabilities: ProviderCapabilities = {
    mailboxKinds: ["label", "view"],
    archive: true,
    settableFlags: ["seen", "flagged"],
  };
  readonly #http: GmailHttp;

  constructor(http: GmailHttp) {
    this.#http = http;
  }

  async listMailboxes(signal?: AbortSignal): Promise<readonly Mailbox[]> {
    const { labels = [] } = await this.#http.get<GmailListLabelsResponse>(
      "labels",
      undefined,
      signal,
    );
    // labels.list has no counts; labels.get has.
    const detailed = await Promise.all(
      labels
        .filter(isMappedLabel)
        .map((label) =>
          this.#http.get<GmailLabel>(
            `labels/${encodeURIComponent(label.id)}`,
            undefined,
            signal,
          ),
        ),
    );
    return mapLabels(detailed);
  }

  async listMessages(
    { mailboxId, cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    const list = await this.#http.get<GmailListMessagesResponse>(
      "messages",
      {
        maxResults: limit,
        pageToken: cursor,
        labelIds: mailboxId === ALL_MAIL_ID ? undefined : [mailboxId],
        includeSpamTrash: SPAM_TRASH.has(mailboxId) ? true : undefined,
      },
      signal,
    );

    const messages = await Promise.all(
      (list.messages ?? []).map(({ id }) =>
        this.#http
          .get<GmailMessage>(
            `messages/${encodeURIComponent(id)}`,
            { format: "metadata", metadataHeaders: SUMMARY_HEADERS },
            signal,
          )
          // Deleted between list and get: skip it rather than failing the page.
          .catch((error: unknown) => {
            if (isMailError(error, "not-found")) return undefined;
            throw error;
          }),
      ),
    );

    return {
      items: messages
        .filter((message): message is GmailMessage => message !== undefined)
        .map(toMessageSummary),
      ...(list.nextPageToken
        ? { nextCursor: asCursor(list.nextPageToken) }
        : {}),
    };
  }

  async getMessage(id: MessageId, signal?: AbortSignal): Promise<Message> {
    const message = await this.#fetchFull(id, signal);
    if (message.payload)
      await this.#hydrateLargeTextParts(id, message.payload, signal);
    return toMessage(message);
  }

  async getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (attachmentId.startsWith("part:")) {
      // Small parts that Gmail inlined into the message (no attachmentId).
      const partId = attachmentId.slice("part:".length);
      const message = await this.#fetchFull(messageId, signal);
      const part = findPart(message.payload, (p) => p.partId === partId);
      return new Blob([decodeBase64Url(part?.body?.data ?? "")]);
    }
    const attachment = await this.#http.get<GmailAttachment>(
      `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      undefined,
      signal,
    );
    return new Blob([decodeBase64Url(attachment.data)]);
  }

  /** Gmail archives by removing the `INBOX` label. */
  archive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#modify(ids, { removeLabelIds: ["INBOX"] }, signal);
  }

  unarchive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#modify(ids, { addLabelIds: ["INBOX"] }, signal);
  }

  /** `seen` and `flagged` are the `UNREAD` and `STARRED` labels. */
  setFlags(
    ids: readonly MessageId[],
    flags: Partial<MessageFlags>,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const add: string[] = [];
    const remove: string[] = [];
    if (flags.seen !== undefined) (flags.seen ? remove : add).push("UNREAD");
    if (flags.flagged !== undefined)
      (flags.flagged ? add : remove).push("STARRED");
    return this.#modify(
      ids,
      { addLabelIds: add, removeLabelIds: remove },
      signal,
    );
  }

  /** Applies a label change in `batchModify` chunks. Ids never change in Gmail. */
  async #modify(
    ids: readonly MessageId[],
    change: LabelChange,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const body = {
      ...(change.addLabelIds?.length
        ? { addLabelIds: change.addLabelIds }
        : {}),
      ...(change.removeLabelIds?.length
        ? { removeLabelIds: change.removeLabelIds }
        : {}),
    };
    if (ids.length === 0 || Object.keys(body).length === 0) return {};
    for (let start = 0; start < ids.length; start += BATCH_MODIFY_LIMIT) {
      await this.#http.post(
        "messages/batchModify",
        { ids: ids.slice(start, start + BATCH_MODIFY_LIMIT), ...body },
        signal,
      );
    }
    return {};
  }

  #fetchFull(id: MessageId, signal?: AbortSignal): Promise<GmailMessage> {
    return this.#http.get<GmailMessage>(
      `messages/${encodeURIComponent(id)}`,
      { format: "full" },
      signal,
    );
  }

  /** Gmail moves large text bodies out of the message; fetch them back in. */
  async #hydrateLargeTextParts(
    messageId: MessageId,
    payload: GmailMessagePart,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending: GmailMessagePart[] = [];
    collectParts(payload, pending, (part) => {
      const mimeType = part.mimeType?.toLowerCase() ?? "";
      return (
        (mimeType === "text/html" || mimeType === "text/plain") &&
        !part.filename &&
        part.body?.attachmentId !== undefined &&
        part.body.data === undefined
      );
    });
    await Promise.all(
      pending.map(async (part) => {
        const body = part.body;
        if (body?.attachmentId === undefined) return;
        const attachment = await this.#http.get<GmailAttachment>(
          `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(body.attachmentId)}`,
          undefined,
          signal,
        );
        body.data = attachment.data;
      }),
    );
  }
}

function collectParts(
  part: GmailMessagePart,
  into: GmailMessagePart[],
  predicate: (part: GmailMessagePart) => boolean,
): void {
  if (predicate(part)) into.push(part);
  for (const child of part.parts ?? []) collectParts(child, into, predicate);
}

function findPart(
  part: GmailMessagePart | undefined,
  predicate: (part: GmailMessagePart) => boolean,
): GmailMessagePart | undefined {
  if (!part) return undefined;
  if (predicate(part)) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, predicate);
    if (found) return found;
  }
  return undefined;
}
