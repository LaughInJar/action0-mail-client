import { attachmentOf, type Draft, type DraftInput } from "../../core/compose";
import { MailError } from "../../core/errors";
import {
  asAttachmentId,
  asCursor,
  asDraftId,
  asMailboxId,
  asMessageId,
  asSyncToken,
  asThreadId,
  type DraftId,
  type SyncToken,
  type ThreadId,
  type AttachmentId,
  type MailboxId,
  type MessageId,
} from "../../core/ids";
import type {
  EmailAddress,
  Mailbox,
  MailboxColor,
  MailboxRole,
  Message,
  MessageFlags,
  MessageSummary,
  Page,
  Sender,
  Thread,
  ThreadSummary,
} from "../../core/model";
import type {
  ChangeSet,
  ListMessagesQuery,
  MailboxChange,
  MailChange,
  MailProvider,
  MutationResult,
  NewMailbox,
  ProviderCapabilities,
  SenderSettings,
  CalendarMail,
} from "../../core/provider";
import { sleep } from "../../lib/sleep";
import { foldText } from "../../lib/text";
import { buildMessage } from "../mime/buildMessage";

/** In-memory content of a fake account. */
export interface FakeMailData {
  readonly mailboxes: readonly Mailbox[];
  readonly messages: readonly Message[];
  /** Attachment content, keyed by `${messageId}/${attachmentId}`. */
  readonly attachments?: ReadonlyMap<string, Blob>;
  /** The account's own address: sender of sent mail; mail to it arrives in the inbox. */
  readonly me?: EmailAddress;
  /** People for address suggestions; enables {@link MailProvider.searchContacts}. */
  readonly contacts?: readonly EmailAddress[];
  /** Colours labels (in folder mode: categories) may get. */
  readonly mailboxColors?: readonly MailboxColor[];
  /** Addresses the account sends from; by default just `me`, without a signature. */
  readonly senders?: readonly Sender[];
  /**
   * Behave like Outlook: mailboxes are exclusive folders, and archive,
   * trash and spam move messages into the folder with that role.
   */
  readonly folders?: boolean;
  /**
   * The user manages the From addresses in action0 (like IMAP and Outlook
   * accounts), and mail goes out from any address the draft names.
   */
  readonly editSenders?: boolean;
}

/** Options of {@link FakeMailProvider}. */
export interface FakeMailProviderOptions {
  /** Simulated network latency per call. */
  readonly latencyMs?: number;
  /** Makes every write fail (to exercise rollback). Can also be toggled via {@link FakeMailProvider.failWrites}. */
  readonly failWrites?: boolean;
  /** Makes contact searches fail as `unavailable` (like a disabled People API). */
  readonly contactsUnavailable?: boolean;
  /**
   * New mail "arrives" this often: checked by {@link FakeMailProvider.changesSince},
   * so no timers run inside the provider.
   */
  readonly arrivals?: {
    readonly everyMs: number;
    /** The `count`th arriving message, received at `now`. */
    readonly create: (now: number, count: number) => Message;
  };
  /** Clock for arrivals (tests). */
  readonly now?: () => number;
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
    compose: true,
    contacts: false,
    maxAttachmentBytes: 25 * 1024 * 1024,
    manageMailboxes: true,
    mailboxEditing: {
      label: { rename: true, colors: [], nest: true, hide: true },
    },
    threads: true,
    senders: true,
    editSenders: false,
    rawSource: true,
    calendarMail: true,
    signatureStore: "provider",
  };
  /** Set to make writes fail with a provider error. */
  failWrites: boolean;
  /** Set to make contact searches fail as `unavailable`. */
  contactsUnavailable: boolean;
  /** One-click unsubscribe URLs "sent" (the demo never goes online). */
  readonly oneClickRequests: string[] = [];
  /** Calendar mails "sent" (invitations and answers). */
  readonly calendarMails: CalendarMail[] = [];
  /** Set to refuse signature changes as `unavailable` (a declined permission). */
  signaturesReadOnly = false;
  #senders: readonly Sender[];
  #catchAll: readonly string[] = [];
  #mailboxes: readonly Mailbox[];
  readonly #attachments: Map<string, Blob>;
  readonly #latencyMs: number;
  readonly #me: EmailAddress;
  readonly #contacts: readonly EmailAddress[];
  readonly #drafts = new Map<
    DraftId,
    { readonly input: DraftInput; readonly messageId: MessageId }
  >();
  #nextId = 1;
  /** Every change to the messages, for {@link changesSince}. */
  readonly #log: {
    readonly version: number;
    readonly id: MessageId;
    readonly kind: "added" | "updated" | "removed";
  }[] = [];
  #version = 0;
  readonly #arrivals: FakeMailProviderOptions["arrivals"];
  readonly #now: () => number;
  #lastArrival: number;
  #arrived = 0;
  #messages: Message[];
  readonly #folders: boolean;

  constructor(data: FakeMailData, options: FakeMailProviderOptions = {}) {
    this.#mailboxes = data.mailboxes;
    this.#messages = [...data.messages];
    this.#attachments = new Map(data.attachments);
    this.#me = data.me ?? { address: "me@example.com" };
    this.#senders = data.senders ?? [
      {
        address: this.#me.address,
        ...(this.#me.name ? { name: this.#me.name } : {}),
        isDefault: true,
        signature: "",
      },
    ];
    this.#contacts = data.contacts ?? [];
    this.#latencyMs = options.latencyMs ?? 0;
    this.failWrites = options.failWrites ?? false;
    this.contactsUnavailable = options.contactsUnavailable ?? false;
    this.#arrivals = options.arrivals;
    this.#now = options.now ?? Date.now;
    this.#lastArrival = this.#now();
    this.#folders = data.folders ?? false;
    const colors = data.mailboxColors ?? [];
    this.capabilities = {
      ...this.capabilities,
      contacts: data.contacts !== undefined,
      editSenders: data.editSenders === true,
      ...(this.#folders
        ? {
            // Like Outlook: folders, and categories as labels.
            mailboxKinds: ["folder", "label", "view"],
            mailboxEditing: {
              folder: { rename: true, colors: [], nest: true, hide: false },
              label: { rename: false, colors, nest: false, hide: false },
            },
          }
        : {
            mailboxEditing: {
              label: { rename: true, colors, nest: true, hide: true },
            },
          }),
    };
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

  /**
   * Like Gmail: conversations with a (matching) message in the mailbox,
   * ordered by their newest message outside Spam and Trash (in Spam and
   * Trash: their newest one there), so a reply moves its conversation up.
   */
  async listThreads(
    { mailboxId, search, order = "newest", cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<ThreadSummary>> {
    await this.#delay(signal);
    const offset = cursor ? Number(cursor) : 0;
    const words = foldText(search ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const matching = this.#messagesIn(mailboxId).filter((message) => {
      const text = foldText(searchableText(message));
      return words.every((word) => text.includes(word));
    });
    const threadIds = [...new Set(matching.map(threadOf))];
    const isolating = this.#isolating();
    const inIsolating = isolating.has(mailboxId);
    const newest = (id: ThreadId) =>
      this.#messages
        .filter(
          (message) =>
            threadOf(message) === id &&
            (inIsolating
              ? message.mailboxIds.includes(mailboxId)
              : !message.mailboxIds.some((m) => isolating.has(m))),
        )
        .reduce(
          (latest, message) =>
            message.receivedAt > latest ? message.receivedAt : latest,
          "",
        );
    const sorted = threadIds
      .map((id) => ({ id, date: newest(id) }))
      .sort((a, b) => b.date.localeCompare(a.date));
    if (order === "oldest") sorted.reverse();
    const next = offset + limit;
    return {
      items: sorted.slice(offset, next).map(({ id }) => ({
        id,
        messages: this.#threadMessages(id).map(toSummary),
      })),
      ...(next < sorted.length ? { nextCursor: asCursor(String(next)) } : {}),
    };
  }

  async getThread(id: ThreadId, signal?: AbortSignal): Promise<Thread> {
    await this.#delay(signal);
    const messages = this.#threadMessages(id);
    if (messages.length === 0)
      throw new MailError("not-found", `No thread ${id}`, { status: 404 });
    return { id, messages };
  }

  /** A conversation's messages, oldest first. */
  #threadMessages(id: ThreadId): Message[] {
    return this.#messages
      .filter((message) => threadOf(message) === id)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  #isolating(): ReadonlySet<MailboxId> {
    return new Set(
      this.#mailboxes
        .filter((m) => m.role === "junk" || m.role === "trash")
        .map((m) => m.id),
    );
  }

  async getMessage(id: MessageId, signal?: AbortSignal): Promise<Message> {
    await this.#delay(signal);
    const message = this.#messages.find((m) => m.id === id);
    if (!message)
      throw new MailError("not-found", `No message ${id}`, { status: 404 });
    return message;
  }

  /**
   * A plausible source: the message built as MIME, below the headers a
   * receiving server adds (two hops, and SPF/DKIM/DMARC that pass, or fail
   * for mail in Spam).
   */
  async getRawMessage(
    id: MessageId,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const message = await this.getMessage(id, signal);
    const attachments = await Promise.all(
      message.attachments.map(async (info) => {
        const blob = this.#attachments.get(`${id}/${info.id}`);
        return {
          filename: info.filename,
          mimeType: info.mimeType,
          content: blob
            ? new Uint8Array(await blob.arrayBuffer())
            : new Uint8Array(),
          ...(info.contentId === undefined
            ? {}
            : { contentId: info.contentId }),
        };
      }),
    );
    const received = Date.parse(message.receivedAt);
    const at = (seconds: number) =>
      new Date(received - seconds * 1000).toUTCString();
    const sender = message.from?.address ?? this.#me.address;
    const domain = sender.slice(sender.indexOf("@") + 1);
    const junk = this.#mailboxes.find((m) => m.role === "junk")?.id;
    const spam = junk !== undefined && message.mailboxIds.includes(junk);
    const [spf, dkim, dmarc] = spam
      ? ["softfail", "fail", "fail"]
      : ["pass", "pass", "pass"];
    let part = 0;
    const source = buildMessage(
      {
        ...(message.from ? { from: message.from } : {}),
        to: message.to,
        cc: message.cc,
        bcc: [],
        subject: message.subject,
        text: message.body.text ?? "",
        html: message.body.html ?? "",
        attachments,
        date: new Date(received - 5000),
      },
      { boundary: () => `demo-${id}-${String(++part)}` },
    );
    const headers = [
      `Received: by mail.demo.example with SMTP id ${id}; ${at(0)}`,
      `Authentication-Results: mx.demo.example; spf=${spf} smtp.mailfrom=${sender}; dkim=${dkim} header.d=${domain}; dmarc=${dmarc} header.from=${domain}`,
      `Received: from mail.${domain} (mail.${domain} [198.51.100.7]) by mx.demo.example with ESMTPS id ${id}; ${at(2)}`,
      `Message-ID: ${message.internetMessageId ?? `<${id}@demo.example>`}`,
    ];
    return new TextEncoder().encode([...headers, source].join("\r\n"));
  }

  async getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<Blob> {
    await this.#delay(signal);
    const blob = this.#attachments.get(`${messageId}/${attachmentId}`);
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
    if (this.#folders) {
      const archive = this.#roleId("archive");
      return this.#write(ids, signal, (message) =>
        inbox !== undefined && message.mailboxIds.includes(inbox)
          ? this.#intoFolder(message, archive)
          : message,
      );
    }
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
    if (this.#folders)
      return this.#write(ids, signal, (message) =>
        this.#intoFolder(message, inbox),
      );
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

  /** Marks what {@link listMessages} lists for the mailbox read, if unread. */
  async markAllRead(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<readonly MessageId[]> {
    const ids = this.#messagesIn(mailboxId)
      .filter((message) => !message.flags.seen)
      .map((message) => message.id);
    await this.setFlags(ids, { seen: true }, signal);
    return ids;
  }

  /** Label semantics, like Gmail: add `to`, leave `from` unless it is a view. */
  move(
    ids: readonly MessageId[],
    { from, to }: { readonly from: MailboxId; readonly to: MailboxId },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    if (this.#folders)
      return this.#write(ids, signal, (message) =>
        this.#intoFolder(message, to),
      );
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
    if (this.#folders)
      return this.#write(ids, signal, (message) =>
        this.#intoFolder(message, trash),
      );
    return this.#write(ids, signal, (message) =>
      trash === undefined ? message : withMembership(message, [trash], []),
    );
  }

  untrash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const trash = this.#roleId("trash");
    if (this.#folders) {
      const inbox = this.#roleId("inbox");
      return this.#write(ids, signal, (message) =>
        this.#intoFolder(message, inbox),
      );
    }
    return this.#write(ids, signal, (message) =>
      trash === undefined ? message : withMembership(message, [], [trash]),
    );
  }

  reportSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const [junk, inbox] = [this.#roleId("junk"), this.#roleId("inbox")];
    if (this.#folders)
      return this.#write(ids, signal, (message) =>
        this.#intoFolder(message, junk),
      );
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
    if (this.#folders)
      return this.#write(ids, signal, (message) =>
        this.#intoFolder(message, inbox),
      );
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
    this.#setMessages(
      this.#messages.filter((message) => !gone.has(message.id)),
    );
    return {};
  }

  async emptyMailbox(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<{ readonly deleted: number }> {
    const role = this.#mailboxes.find((m) => m.id === mailboxId)?.role;
    if (role !== "trash" && role !== "junk") {
      throw new MailError("provider", "Only Trash and Spam can be emptied.", {
        reason: "onlyTrashSpam",
      });
    }
    const ids = this.#messagesIn(mailboxId).map((message) => message.id);
    await this.deleteForever(ids, signal);
    return { deleted: ids.length };
  }

  async saveDraft(
    draft: DraftInput,
    signal?: AbortSignal,
  ): Promise<{ readonly id: DraftId; readonly messageId: MessageId }> {
    await this.#refuseIfFailing(signal);
    const id = draft.id ?? asDraftId(`draft-${String(this.#nextId++)}`);
    const previous = this.#drafts.get(id);
    if (draft.id !== undefined && !previous)
      throw new MailError("not-found", `No draft ${id}`, { status: 404 });
    // Like Gmail: every save is a new message.
    const message = this.#composeMessage(draft, this.#roleIds("drafts"), true);
    this.#setMessages([
      ...this.#messages.filter((m) => m.id !== previous?.messageId),
      message,
    ]);
    this.#drafts.set(id, { input: { ...draft, id }, messageId: message.id });
    return { id, messageId: message.id };
  }

  async draftIdOf(
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<DraftId | undefined> {
    await this.#delay(signal);
    for (const [id, draft] of this.#drafts)
      if (draft.messageId === messageId) return id;
    return undefined;
  }

  async getDraft(id: DraftId, signal?: AbortSignal): Promise<Draft> {
    await this.#delay(signal);
    const draft = this.#drafts.get(id);
    const message = this.#messages.find((m) => m.id === draft?.messageId);
    if (!draft || !message)
      throw new MailError("not-found", `No draft ${id}`, { status: 404 });
    return {
      ...draft.input,
      id,
      messageId: message.id,
      // The parts now belong to the draft's own message.
      attachments: message.attachments.map((part) =>
        attachmentOf(message.id, part),
      ),
    };
  }

  async deleteDraft(id: DraftId, signal?: AbortSignal): Promise<void> {
    await this.#refuseIfFailing(signal);
    const draft = this.#drafts.get(id);
    if (!draft)
      throw new MailError("not-found", `No draft ${id}`, { status: 404 });
    this.#drafts.delete(id);
    this.#setMessages(this.#messages.filter((m) => m.id !== draft.messageId));
  }

  async sendDraft(
    draft: DraftInput & { readonly id: DraftId },
    signal?: AbortSignal,
  ): Promise<{ readonly messageId: MessageId }> {
    await this.#refuseIfFailing(signal);
    const saved = this.#drafts.get(draft.id);
    if (!saved)
      throw new MailError("not-found", `No draft ${draft.id}`, { status: 404 });
    this.#drafts.delete(draft.id);
    // Like Gmail, mail to yourself is one message in Sent and the Inbox.
    const toMe = [...draft.to, ...draft.cc, ...draft.bcc].some((a) =>
      this.#isMine(a.address),
    );
    const sent = this.#composeMessage(
      draft,
      [...this.#roleIds("sent"), ...(toMe ? this.#roleIds("inbox") : [])],
      !toMe,
    );
    this.#setMessages([
      ...this.#messages.filter((m) => m.id !== saved.messageId),
      sent,
    ]);
    return { messageId: sent.id };
  }

  async searchContacts(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly EmailAddress[]> {
    await this.#delay(signal);
    if (this.contactsUnavailable)
      throw new MailError("unavailable", "Demo contacts are switched off.", {
        reason: "demoContactsOff",
      });
    const needle = foldText(query.trim());
    return this.#contacts
      .filter((person) =>
        foldText(`${person.name ?? ""} ${person.address}`).includes(needle),
      )
      .slice(0, 10);
  }

  /** A message made from draft content, with copies of its attachments. */
  #composeMessage(
    draft: DraftInput,
    mailboxIds: readonly MailboxId[],
    seen: boolean,
  ): Message {
    const id = asMessageId(`m-${String(this.#nextId++)}`);
    const attachments = draft.attachments.map((part, index) => {
      const attachmentId = asAttachmentId(`part-${String(index)}`);
      const content =
        part.content ??
        (part.source &&
          this.#attachments.get(
            `${part.source.messageId}/${part.source.attachmentId}`,
          ));
      if (content) this.#attachments.set(`${id}/${attachmentId}`, content);
      return {
        id: attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.size,
        ...(part.contentId === undefined ? {} : { contentId: part.contentId }),
      };
    });
    return {
      id,
      threadId: draft.threading?.threadId ?? asThreadId(`t-${id}`),
      mailboxIds,
      from:
        draft.from &&
        (this.capabilities.editSenders || this.#isMine(draft.from.address))
          ? draft.from
          : this.#me,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      replyTo: [],
      internetMessageId: `<${id}@demo.example>`,
      references: draft.threading?.references ?? [],
      subject: draft.subject,
      snippet: draft.text.replace(/\s+/g, " ").trim().slice(0, 140),
      receivedAt: new Date().toISOString(),
      flags: { seen, flagged: false },
      hasAttachments: attachments.some((a) => a.contentId === undefined),
      body: { html: draft.html, text: draft.text },
      attachments,
    };
  }

  #roleIds(role: MailboxRole): MailboxId[] {
    const id = this.#roleId(role);
    return id === undefined ? [] : [id];
  }

  async #refuseIfFailing(signal: AbortSignal | undefined): Promise<void> {
    await this.#delay(signal);
    if (this.failWrites) {
      throw new MailError("provider", "The demo server refused the change.", {
        status: 500,
        reason: "demoRefused",
      });
    }
  }

  async createMailbox(
    { name, parentId, color, hidden = false, kind }: NewMailbox,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    await this.#refuseIfFailing(signal);
    // Folder mode: a category (label) sits in the categories' group.
    const category = this.#folders && kind === "label";
    const parent = category ? this.#categoriesGroup() : parentId;
    const leaf = this.#checkedName(name, parent, undefined, category);
    if (parent !== undefined && !category) this.#userMailbox(parent);
    const mailbox: Mailbox = {
      id: asMailboxId(`label-${String(this.#nextId++)}`),
      name: leaf,
      kind: this.#folders && !category ? "folder" : "label",
      selectable: true,
      hidden: hidden && !this.#folders,
      assignable: true,
      ...(parent === undefined ? {} : { parentId: parent }),
      ...(color ? { color } : {}),
    };
    this.#setMailboxes([...this.#mailboxes, mailbox]);
    return mailbox;
  }

  async updateMailbox(
    id: MailboxId,
    { name, parentId, color, hidden }: MailboxChange,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    await this.#refuseIfFailing(signal);
    const current = this.#userMailbox(id);
    if (this.#folders && current.kind === "label") {
      // Like Outlook: categories only change colour.
      if ((name !== undefined && name !== current.name) || parentId)
        throw new MailError("provider", "Outlook can’t rename categories.", {
          reason: "categoryRename",
        });
      const { color: oldColor, ...rest } = current;
      const nextColor = color === undefined ? oldColor : (color ?? undefined);
      const updated: Mailbox = {
        ...rest,
        ...(nextColor ? { color: nextColor } : {}),
      };
      this.#setMailboxes(
        this.#mailboxes.map((mailbox) =>
          mailbox.id === id ? updated : mailbox,
        ),
      );
      return updated;
    }
    const parent = parentId === undefined ? current.parentId : parentId;
    if (parent !== null && parent !== undefined) {
      this.#userMailbox(parent);
      for (let at: MailboxId | undefined = parent; at !== undefined;) {
        if (at === id)
          throw new MailError("provider", "A label can’t go inside itself.", {
            reason: "labelInsideItself",
          });
        at = this.#mailboxes.find((m) => m.id === at)?.parentId;
      }
    }
    const leaf = this.#checkedName(
      name ?? current.name,
      parent ?? undefined,
      id,
    );
    const {
      parentId: _oldParent,
      color: oldColor,
      counts: _counts,
      ...rest
    } = current;
    const nextColor = color === undefined ? oldColor : (color ?? undefined);
    const updated: Mailbox = {
      ...rest,
      name: leaf,
      hidden: hidden ?? current.hidden,
      ...(parent === null || parent === undefined ? {} : { parentId: parent }),
      ...(nextColor ? { color: nextColor } : {}),
    };
    this.#setMailboxes(
      this.#mailboxes.map((mailbox) => (mailbox.id === id ? updated : mailbox)),
    );
    return updated;
  }

  /**
   * Labels: nested mailboxes move up a level; messages just lose the label.
   * Folders: the folder moves into the trash, with its messages.
   */
  async deleteMailbox(id: MailboxId, signal?: AbortSignal): Promise<void> {
    await this.#refuseIfFailing(signal);
    const gone = this.#userMailbox(id);
    const trash = this.#roleId("trash");
    if (this.#folders && gone.kind === "label") {
      // Like Outlook: the category leaves the list, mail keeps the name.
      this.#setMailboxes(
        this.#mailboxes.filter((mailbox) => mailbox.id !== id),
      );
      return;
    }
    if (this.#folders && trash !== undefined) {
      this.#setMailboxes(
        this.#mailboxes.map((mailbox) =>
          mailbox.id === id ? { ...mailbox, parentId: trash } : mailbox,
        ),
      );
      return;
    }
    this.#setMailboxes(
      this.#mailboxes.flatMap((mailbox) => {
        if (mailbox.id === id) return [];
        if (mailbox.parentId !== id) return [mailbox];
        const { parentId: _parent, ...rest } = mailbox;
        return [
          gone.parentId === undefined
            ? rest
            : { ...rest, parentId: gone.parentId },
        ];
      }),
    );
    this.#setMessages(
      this.#messages.map((message) =>
        message.mailboxIds.includes(id)
          ? withMembership(message, [], [id])
          : message,
      ),
    );
  }

  async listSenders(signal?: AbortSignal): Promise<readonly Sender[]> {
    await this.#delay(signal);
    return this.#senders;
  }

  async updateSignature(
    address: string,
    html: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#refuseIfFailing(signal);
    if (this.signaturesReadOnly)
      throw new MailError(
        "unavailable",
        "Changing the demo's settings isn't allowed.",
        { status: 403, reason: "settingsNotAllowed" },
      );
    if (!this.#isMine(address))
      throw new MailError("not-found", `No sender ${address}`, {
        status: 404,
      });
    this.#senders = this.#senders.map((sender) =>
      sender.address.toLowerCase() === address.toLowerCase()
        ? { ...sender, signature: html }
        : sender,
    );
  }

  async saveSenders(
    senders: readonly SenderSettings[],
    catchAll: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#refuseIfFailing(signal);
    if (!this.capabilities.editSenders)
      throw new MailError("unavailable", "The demo's addresses are fixed.");
    const signatures = new Map(
      this.#senders.map((s) => [s.address.toLowerCase(), s.signature]),
    );
    const own = this.#me.address.toLowerCase();
    const list = senders.some((s) => s.address.toLowerCase() === own)
      ? senders
      : [{ ...this.#me, isDefault: false }, ...senders];
    const defaultIndex = Math.max(
      0,
      list.findIndex((s) => s.isDefault),
    );
    this.#senders = list.map((sender, index) => ({
      ...sender,
      isDefault: index === defaultIndex,
      signature: signatures.get(sender.address.toLowerCase()) ?? "",
    }));
    this.#catchAll = catchAll.map((domain) => domain.toLowerCase());
  }

  async catchAllDomains(signal?: AbortSignal): Promise<readonly string[]> {
    await this.#delay(signal);
    return this.#catchAll;
  }

  #isMine(address: string): boolean {
    return this.#senders.some(
      (sender) => sender.address.toLowerCase() === address.toLowerCase(),
    );
  }

  async sendCalendarMail(
    mail: CalendarMail,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#refuseIfFailing(signal);
    this.calendarMails.push(mail);
  }

  async oneClickUnsubscribe(url: string, signal?: AbortSignal): Promise<void> {
    await this.#refuseIfFailing(signal);
    this.oneClickRequests.push(url);
  }

  /** A mailbox of the user's own (not a system mailbox). */
  /** Folder semantics: the message leaves its folder for `target`. */
  #intoFolder(message: Message, target: MailboxId | undefined): Message {
    if (target === undefined) return message;
    const isFolder = (id: MailboxId) =>
      this.#mailboxes.find((mailbox) => mailbox.id === id)?.kind === "folder";
    return withMembership(
      message,
      [target],
      message.mailboxIds.filter((id) => id !== target && isFolder(id)),
    );
  }

  #userMailbox(id: MailboxId): Mailbox {
    const mailbox = this.#mailboxes.find((m) => m.id === id);
    if (!mailbox)
      throw new MailError("not-found", `No mailbox ${id}`, { status: 404 });
    if (!mailbox.assignable || mailbox.role !== undefined)
      throw new MailError("provider", "System mailboxes can’t be changed.", {
        reason: "systemMailbox",
      });
    return mailbox;
  }

  /** The group categories sit in (folder mode), if the data has one. */
  #categoriesGroup(): MailboxId | undefined {
    return this.#mailboxes.find((mailbox) => mailbox.standard === "categories")
      ?.id;
  }

  /** A trimmed name that no sibling has yet (ignoring `self`). */
  #checkedName(
    name: string,
    parentId: MailboxId | undefined,
    self: MailboxId | undefined,
    category = false,
  ): string {
    const trimmed = name.trim();
    if (trimmed === "")
      throw new MailError("provider", "A label needs a name.", {
        reason: category
          ? "categoryNeedsName"
          : this.#folders
            ? "folderNeedsName"
            : "labelNeedsName",
      });
    if (!this.#folders && trimmed.includes("/"))
      throw new MailError("provider", "Label names can’t contain “/”.", {
        reason: "labelNoSlash",
      });
    const taken = this.#mailboxes.some(
      (mailbox) =>
        mailbox.id !== self &&
        mailbox.parentId === parentId &&
        mailbox.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (taken)
      throw new MailError(
        "provider",
        `There’s already a label called “${trimmed}”.`,
        {
          status: 409,
          reason: category
            ? "categoryExists"
            : this.#folders
              ? "folderExists"
              : "labelExists",
          params: { name: trimmed },
        },
      );
    return trimmed;
  }

  /** System mailboxes keep their place; the user's own follow, sorted by path. */
  #setMailboxes(next: readonly Mailbox[]) {
    const byId = new Map(next.map((mailbox) => [mailbox.id, mailbox]));
    const pathOf = (mailbox: Mailbox): string => {
      const names = [mailbox.name];
      const seen = new Set([mailbox.id]);
      let parent = mailbox.parentId && byId.get(mailbox.parentId);
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        names.unshift(parent.name);
        parent = parent.parentId && byId.get(parent.parentId);
      }
      return names.join("/");
    };
    const own = (mailbox: Mailbox) =>
      mailbox.assignable && mailbox.role === undefined;
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    this.#mailboxes = [
      ...next.filter((mailbox) => !own(mailbox)),
      ...next
        .filter(own)
        .map((mailbox) => ({ mailbox, path: pathOf(mailbox) }))
        .sort((a, b) => collator.compare(a.path, b.path))
        .map(({ mailbox }) => mailbox),
    ];
  }

  async changesSince(
    token: SyncToken | undefined,
    signal?: AbortSignal,
  ): Promise<ChangeSet> {
    await this.#delay(signal);
    this.#deliverDue();
    const current = asSyncToken(String(this.#version));
    if (token === undefined)
      return { token: current, reset: false, changes: [] };
    const since = Number(token);
    const kinds = new Map<MessageId, "added" | "updated" | "removed">();
    for (const entry of this.#log) {
      if (entry.version <= since) continue;
      const previous = kinds.get(entry.id);
      kinds.set(
        entry.id,
        previous === "added" && entry.kind === "updated" ? "added" : entry.kind,
      );
    }
    const changes = [...kinds].map(([id, kind]): MailChange => {
      const message = this.#messages.find((m) => m.id === id);
      if (!message || kind === "removed") return { kind: "removed", id };
      return { kind, message: toSummary(message) };
    });
    return { token: current, reset: false, changes };
  }

  /** Lets demo mail arrive when it's due. */
  #deliverDue() {
    const arrivals = this.#arrivals;
    const now = this.#now();
    if (!arrivals || now - this.#lastArrival < arrivals.everyMs) return;
    this.#lastArrival = now;
    this.#arrived += 1;
    this.#setMessages([...this.#messages, arrivals.create(now, this.#arrived)]);
  }

  /** Replaces the messages, logging what changed. */
  #setMessages(next: Message[]) {
    const before = new Map(this.#messages.map((m) => [m.id, m]));
    const version = ++this.#version;
    const ids = new Set<MessageId>();
    for (const message of next) {
      ids.add(message.id);
      const old = before.get(message.id);
      if (old !== message)
        this.#log.push({
          version,
          id: message.id,
          kind: old ? "updated" : "added",
        });
    }
    for (const id of before.keys())
      if (!ids.has(id)) this.#log.push({ version, id, kind: "removed" });
    this.#messages = next;
  }

  async #write(
    ids: readonly MessageId[],
    signal: AbortSignal | undefined,
    update: (message: Message) => Message,
  ): Promise<MutationResult> {
    await this.#refuseIfFailing(signal);
    const targets = new Set(ids);
    this.#setMessages(
      this.#messages.map((message) =>
        targets.has(message.id) ? update(message) : message,
      ),
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

/** The conversation of a message (one of its own if it has none). */
function threadOf(message: MessageSummary): ThreadId {
  return message.threadId ?? asThreadId(`t-${message.id}`);
}

function toSummary(message: Message): MessageSummary {
  const {
    cc,
    bcc,
    replyTo,
    internetMessageId,
    references,
    body,
    attachments,
    ...summary
  } = message;
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
