import { MailError } from "../../core/errors";
import {
  asCursor,
  type AttachmentId,
  type MailboxId,
  type MessageId,
} from "../../core/ids";
import type { Mailbox, Message, MessageSummary, Page } from "../../core/model";
import type {
  ListMessagesQuery,
  MailProvider,
  ProviderCapabilities,
} from "../../core/provider";
import { sleep } from "../../lib/sleep";

/** In-memory content of a fake account. */
export interface FakeMailData {
  readonly mailboxes: readonly Mailbox[];
  readonly messages: readonly Message[];
  /** Attachment content, keyed by `${messageId}/${attachmentId}`. */
  readonly attachments?: ReadonlyMap<string, Blob>;
}

/** Options of {@link FakeMailProvider}. */
export interface FakeMailProviderOptions {
  /** Simulated network latency per call. */
  readonly latencyMs?: number;
}

/**
 * {@link MailProvider} backed by in-memory data. Used by tests and by the demo
 * account. It follows the same rules as real providers: views are computed,
 * counts are derived from the messages, results are newest first.
 */
export class FakeMailProvider implements MailProvider {
  readonly capabilities: ProviderCapabilities = {
    mailboxKinds: ["label", "view"],
  };
  readonly #data: FakeMailData;
  readonly #latencyMs: number;

  constructor(data: FakeMailData, options: FakeMailProviderOptions = {}) {
    this.#data = data;
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async listMailboxes(signal?: AbortSignal): Promise<readonly Mailbox[]> {
    await this.#delay(signal);
    return this.#data.mailboxes.map((mailbox) => {
      if (!mailbox.selectable) return mailbox;
      const messages = this.#messagesIn(mailbox.id);
      return {
        ...mailbox,
        counts: {
          total: messages.length,
          unread: messages.filter((message) => !message.flags.seen).length,
        },
      };
    });
  }

  async listMessages(
    { mailboxId, cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    await this.#delay(signal);
    const offset = cursor ? Number(cursor) : 0;
    const all = this.#messagesIn(mailboxId);
    const items = all.slice(offset, offset + limit).map(toSummary);
    const next = offset + limit;
    return {
      items,
      ...(next < all.length ? { nextCursor: asCursor(String(next)) } : {}),
    };
  }

  async getMessage(id: MessageId, signal?: AbortSignal): Promise<Message> {
    await this.#delay(signal);
    const message = this.#data.messages.find((m) => m.id === id);
    if (!message)
      throw new MailError("not-found", `No message ${id}`, { status: 404 });
    return message;
  }

  async getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<Blob> {
    await this.#delay(signal);
    const blob = this.#data.attachments?.get(`${messageId}/${attachmentId}`);
    if (!blob)
      throw new MailError("not-found", `No attachment ${attachmentId}`, {
        status: 404,
      });
    return blob;
  }

  #messagesIn(mailboxId: MailboxId): Message[] {
    const mailbox = this.#data.mailboxes.find((m) => m.id === mailboxId);
    const excluded = new Set(
      this.#data.mailboxes
        .filter((m) => m.role === "junk" || m.role === "trash")
        .map((m) => m.id),
    );
    const outsideSpamAndTrash = (message: Message) =>
      !message.mailboxIds.some((id) => excluded.has(id));

    let matches: (message: Message) => boolean;
    if (mailbox?.role === "all") matches = outsideSpamAndTrash;
    else if (mailbox?.role === "flagged")
      matches = (message) =>
        message.flags.flagged && outsideSpamAndTrash(message);
    else matches = (message) => message.mailboxIds.includes(mailboxId);

    return this.#data.messages
      .filter(matches)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  async #delay(signal?: AbortSignal) {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs, signal);
    signal?.throwIfAborted();
  }
}

function toSummary(message: Message): MessageSummary {
  const { cc, bcc, replyTo, body, attachments, ...summary } = message;
  return summary;
}
