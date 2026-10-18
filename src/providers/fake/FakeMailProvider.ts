import { MailError } from "../../core/errors";
import {
  asCursor,
  type AttachmentId,
  type MailboxId,
  type MessageId,
} from "../../core/ids";
import type {
  Mailbox,
  MailboxRole,
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
import { sleep } from "../../lib/sleep";
import { foldText } from "../../lib/text";

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
  /** Makes every write fail (to exercise rollback). Can also be toggled via {@link FakeMailProvider.failWrites}. */
  readonly failWrites?: boolean;
}

/**
 * {@link MailProvider} backed by in-memory data. Used by tests and by the demo
 * account. It follows the same rules as real providers: views are computed,
 * counts are derived from the messages, results are sorted by date, and
 * writes change what later reads return. Search matches plain words
 * (case- and accent-insensitive) in subject, sender, recipients and snippet;
 * there are no search operators. It behaves like a label-based
 * provider (Gmail): archiving removes the inbox membership.
 */
export class FakeMailProvider implements MailProvider {
  readonly capabilities: ProviderCapabilities = {
    mailboxKinds: ["label", "view"],
    archive: true,
    settableFlags: ["seen", "flagged"],
    move: true,
    labels: true,
    trash: true,
    spam: true,
    deleteForever: true,
  };
  /** Set to make writes fail with a provider error. */
  failWrites: boolean;
  readonly #mailboxes: readonly Mailbox[];
  readonly #attachments: ReadonlyMap<string, Blob> | undefined;
  readonly #latencyMs: number;
  #messages: Message[];

  constructor(data: FakeMailData, options: FakeMailProviderOptions = {}) {
    this.#mailboxes = data.mailboxes;
    this.#messages = [...data.messages];
    this.#attachments = data.attachments;
    this.#latencyMs = options.latencyMs ?? 0;
    this.failWrites = options.failWrites ?? false;
  }

  async listMailboxes(signal?: AbortSignal): Promise<readonly Mailbox[]> {
    await this.#delay(signal);
    return this.#mailboxes.map((mailbox) => {
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
    { mailboxId, search, order = "newest", cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    await this.#delay(signal);
    const offset = cursor ? Number(cursor) : 0;
    const words = foldText(search ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const all = this.#messagesIn(mailboxId).filter((message) => {
      const text = foldText(searchableText(message));
      return words.every((word) => text.includes(word));
    });
    if (order === "oldest") all.reverse();
    const items = all.slice(offset, offset + limit).map(toSummary);
    const next = offset + limit;
    return {
      items,
      ...(next < all.length ? { nextCursor: asCursor(String(next)) } : {}),
    };
  }

  async getMessage(id: MessageId, signal?: AbortSignal): Promise<Message> {
    await this.#delay(signal);
    const message = this.#messages.find((m) => m.id === id);
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
    const blob = this.#attachments?.get(`${messageId}/${attachmentId}`);
    if (!blob)
      throw new MailError("not-found", `No attachment ${attachmentId}`, {
        status: 404,
      });
    return blob;
  }

  archive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const inbox = this.#roleId("inbox");
    return this.#write(ids, signal, (message) => ({
      ...message,
      mailboxIds: message.mailboxIds.filter((id) => id !== inbox),
    }));
  }

  unarchive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const inbox = this.#roleId("inbox");
    return this.#write(ids, signal, (message) =>
      inbox === undefined || message.mailboxIds.includes(inbox)
        ? message
        : { ...message, mailboxIds: [inbox, ...message.mailboxIds] },
    );
  }

  setFlags(
    ids: readonly MessageId[],
    flags: Partial<MessageFlags>,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#write(ids, signal, (message) => ({
      ...message,
      flags: { ...message.flags, ...flags },
    }));
  }

  /** Label semantics, like Gmail: add `to`, leave `from` unless it is a view. */
  move(
    ids: readonly MessageId[],
    { from, to }: { readonly from: MailboxId; readonly to: MailboxId },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const fromIsView =
      this.#mailboxes.find((mailbox) => mailbox.id === from)?.kind === "view";
    return this.#write(ids, signal, (message) => ({
      ...message,
      mailboxIds: [
        ...new Set([
          ...message.mailboxIds.filter((id) => fromIsView || id !== from),
          to,
        ]),
      ],
    }));
  }

  setLabels(
    ids: readonly MessageId[],
    change: {
      readonly add: readonly MailboxId[];
      readonly remove: readonly MailboxId[];
    },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#write(ids, signal, (message) => ({
      ...message,
      mailboxIds: [
        ...new Set([
          ...message.mailboxIds.filter((id) => !change.remove.includes(id)),
          ...change.add,
        ]),
      ],
    }));
  }

  /** Gmail semantics: Trash is added, other labels stay (but the message shows only in Trash). */
  trash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const trash = this.#roleId("trash");
    return this.#write(ids, signal, (message) =>
      trash === undefined ? message : withMembership(message, [trash], []),
    );
  }

  untrash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const trash = this.#roleId("trash");
    return this.#write(ids, signal, (message) =>
      trash === undefined ? message : withMembership(message, [], [trash]),
    );
  }

  reportSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const [junk, inbox] = [this.#roleId("junk"), this.#roleId("inbox")];
    return this.#write(ids, signal, (message) =>
      junk === undefined
        ? message
        : withMembership(message, [junk], inbox === undefined ? [] : [inbox]),
    );
  }

  notSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const [junk, inbox] = [this.#roleId("junk"), this.#roleId("inbox")];
    return this.#write(ids, signal, (message) =>
      junk === undefined
        ? message
        : withMembership(message, inbox === undefined ? [] : [inbox], [junk]),
    );
  }

  async deleteForever(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    await this.#write([], signal, (message) => message);
    const gone = new Set(ids);
    this.#messages = this.#messages.filter((message) => !gone.has(message.id));
    return {};
  }

  async emptyMailbox(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<{ readonly deleted: number }> {
    const role = this.#mailboxes.find((m) => m.id === mailboxId)?.role;
    if (role !== "trash" && role !== "junk") {
      throw new MailError("provider", "Only Trash and Spam can be emptied.");
    }
    const ids = this.#messagesIn(mailboxId).map((message) => message.id);
    await this.deleteForever(ids, signal);
    return { deleted: ids.length };
  }

  async #write(
    ids: readonly MessageId[],
    signal: AbortSignal | undefined,
    update: (message: Message) => Message,
  ): Promise<MutationResult> {
    await this.#delay(signal);
    if (this.failWrites) {
      throw new MailError("provider", "The demo server refused the change.", {
        status: 500,
      });
    }
    const targets = new Set(ids);
    this.#messages = this.#messages.map((message) =>
      targets.has(message.id) ? update(message) : message,
    );
    return {};
  }

  #roleId(role: MailboxRole): MailboxId | undefined {
    return this.#mailboxes.find((mailbox) => mailbox.role === role)?.id;
  }

  #messagesIn(mailboxId: MailboxId): Message[] {
    const mailbox = this.#mailboxes.find((m) => m.id === mailboxId);
    const excluded = new Set(
      this.#mailboxes
        .filter((m) => m.role === "junk" || m.role === "trash")
        .map((m) => m.id),
    );
    const outsideSpamAndTrash = (message: Message) =>
      !message.mailboxIds.some((id) => excluded.has(id));

    // Like Gmail: messages in Spam or Trash show up only there.
    let matches: (message: Message) => boolean;
    if (mailbox?.role === "all") matches = outsideSpamAndTrash;
    else if (mailbox?.role === "flagged")
      matches = (message) =>
        message.flags.flagged && outsideSpamAndTrash(message);
    else if (excluded.has(mailboxId))
      matches = (message) => message.mailboxIds.includes(mailboxId);
    else
      matches = (message) =>
        message.mailboxIds.includes(mailboxId) && outsideSpamAndTrash(message);

    return this.#messages
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

function withMembership(
  message: Message,
  add: readonly MailboxId[],
  remove: readonly MailboxId[],
): Message {
  return {
    ...message,
    mailboxIds: [
      ...new Set([
        ...message.mailboxIds.filter((id) => !remove.includes(id)),
        ...add,
      ]),
    ],
  };
}

/** What a search looks at. */
function searchableText(message: Message): string {
  return [
    message.subject,
    message.snippet,
    ...[message.from, ...message.to].flatMap((address) =>
      address ? [address.name ?? "", address.address] : [],
    ),
  ].join(" ");
}
