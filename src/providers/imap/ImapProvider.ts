/**
 * IMAP/SMTP accounts through the apps' native side: a folder account like
 * Outlook. The native side talks IMAP and SMTP and parses mail (see
 * `bridge.ts`); this turns it into the mailbox model: archive, trash and
 * spam move into role folders (created when missing), drafts live in the
 * Drafts folder, and sending goes over SMTP with a copy in Sent.
 */
import { MailError } from "../../core/errors";
import {
  attachmentOf,
  type Draft,
  type DraftInput,
  type OutgoingAttachment,
} from "../../core/compose";
import {
  asCursor,
  asDraftId,
  asMessageId,
  asSyncToken,
  type AttachmentId,
  type DraftId,
  type MailboxId,
  type MessageId,
  type SyncToken,
  type ThreadId,
} from "../../core/ids";
import type {
  EmailAddress,
  Mailbox,
  Message,
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
  MailProvider,
  MutationResult,
  NewMailbox,
  ProviderCapabilities,
  SenderSettings,
  CalendarMail,
} from "../../core/provider";
import {
  buildMessage,
  newMessageId,
  type MimeAttachment,
} from "../mime/buildMessage";
import { sendOneClickUnsubscribe } from "../oneClickUnsubscribe";
import { SenderStore, type OwnAddress } from "../senderStore";
import type {
  ImapBridge,
  ImapCallName,
  ImapCalls,
  ImapMailbox,
} from "./bridge";
import {
  toMailbox,
  toMailError,
  toMessage,
  toSummary,
  toThread,
} from "./mappers";

/** When the SMTP server doesn't say: Gmail's limit, which most come close to. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Attachments grow by a third when encoded (base64), and the server's
 * limit counts the whole mail.
 */
const ENCODING_GROWTH = 1.37;

/** Role folders action0 creates when an account has none, by role. */
const CREATED_NAMES = {
  archive: "Archive",
  trash: "Trash",
  junk: "Junk",
  sent: "Sent",
  drafts: "Drafts",
} as const;

type CreatedRole = keyof typeof CREATED_NAMES;

/** Options of {@link ImapProvider}. */
export interface ImapProviderOptions {
  readonly bridge: ImapBridge;
  /** The account id (`imap:<address>`). */
  readonly key: string;
  readonly address: string;
  /** The name mail goes out with. */
  readonly name?: string;
  /** The mail server's host, for messages ("imap.example.com"). */
  readonly service: string;
  /** The SMTP server's size limit (`SIZE`), if it said. */
  readonly maxBytes?: number;
  /**
   * The SMTP server keeps a copy in Sent itself (Gmail), so action0 doesn't
   * add another.
   */
  readonly savesSent?: boolean;
  /** From addresses and signatures (IMAP servers keep neither). */
  readonly senders?: SenderStore;
  /** For one-click unsubscribe (the native fetch in the apps). */
  readonly fetch?: typeof fetch;
  /** Told when the server refuses the login, so Reconnect shows. */
  readonly onAuthFailed?: () => void;
  /** Searches the address books for this account (CardDAV; the apps). */
  readonly searchContacts?: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<readonly EmailAddress[]>;
}

/** See the module docs. */
export class ImapProvider implements MailProvider {
  readonly capabilities: ProviderCapabilities;
  readonly #options: ImapProviderOptions;
  readonly #fetch: typeof fetch;

  constructor(options: ImapProviderOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.capabilities = {
      mailboxKinds: ["folder", "view"],
      archive: true,
      settableFlags: ["seen", "flagged"],
      move: true,
      labels: false,
      trash: true,
      spam: true,
      deleteForever: true,
      compose: true,
      // The account's (or another calendar server's) address books, then recent mail.
      contacts: options.searchContacts !== undefined,
      ...(options.searchContacts ? { recentToo: true } : {}),
      maxAttachmentBytes: Math.floor(
        (options.maxBytes ?? DEFAULT_MAX_BYTES) / ENCODING_GROWTH,
      ),
      manageMailboxes: true,
      mailboxEditing: {
        folder: { rename: true, colors: [], nest: true, hide: false },
      },
      threads: true,
      senders: true,
      editSenders: true,
      rawSource: true,
      calendarMail: true,
      signatureStore: "browser",
      // Like mail programs (Thunderbird): Sent, Trash, Junk, in the UI's language.
      roleNames: "client",
    };
  }

  async listMailboxes(signal?: AbortSignal): Promise<readonly Mailbox[]> {
    return (await this.#call("folders", {}, signal)).map(toMailbox);
  }

  async listMessages(
    query: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    const page = await this.#call("list", listQuery(query), signal);
    return {
      items: page.items.map(toSummary),
      ...(page.nextCursor === undefined
        ? {}
        : { nextCursor: asCursor(page.nextCursor) }),
    };
  }

  async listThreads(
    query: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<ThreadSummary>> {
    const page = await this.#call("threads", listQuery(query), signal);
    return {
      items: page.items.map(toThread),
      ...(page.nextCursor === undefined
        ? {}
        : { nextCursor: asCursor(page.nextCursor) }),
    };
  }

  async getThread(id: ThreadId, signal?: AbortSignal): Promise<Thread> {
    const messages = await this.#call("thread", { id }, signal);
    if (messages.length === 0)
      throw new MailError("not-found", "The conversation is gone.");
    return { id, messages: messages.map(toMessage) };
  }

  async getMessage(id: MessageId, signal?: AbortSignal): Promise<Message> {
    return toMessage(await this.#call("message", { id }, signal));
  }

  async getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const bytes = await this.#bytes(
      { kind: "part", id: messageId, part: attachmentId },
      signal,
    );
    return new Blob([bytes as Uint8Array<ArrayBuffer>]);
  }

  getRawMessage(id: MessageId, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#bytes({ kind: "raw", id }, signal);
  }

  async archive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveTo(ids, "archive", signal);
  }

  /** IMAP doesn't remember where a message was, so it goes back to the Inbox. */
  async unarchive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveTo(ids, "inbox", signal);
  }

  async setFlags(
    ids: readonly MessageId[],
    flags: Partial<{ seen: boolean; flagged: boolean }>,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    await this.#call("flags", { ids, ...flags }, signal);
    return {};
  }

  async markAllRead(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<readonly MessageId[]> {
    return (await this.#call("markAllRead", { mailboxId }, signal)).map(
      asMessageId,
    );
  }

  async move(
    ids: readonly MessageId[],
    target: { readonly from: MailboxId; readonly to: MailboxId },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    await this.#call("move", { ids, to: target.to }, signal);
    return {};
  }

  setLabels(): Promise<MutationResult> {
    return Promise.reject(
      new MailError("unavailable", "IMAP accounts have folders, not labels."),
    );
  }

  trash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveTo(ids, "trash", signal);
  }

  untrash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveTo(ids, "inbox", signal);
  }

  reportSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveTo(ids, "junk", signal);
  }

  notSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveTo(ids, "inbox", signal);
  }

  async deleteForever(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    await this.#call("delete", { ids }, signal);
    return {};
  }

  async emptyMailbox(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<{ readonly deleted: number }> {
    const mailbox = (await this.#mailboxes(signal)).find(
      (candidate) => candidate.id === mailboxId,
    );
    if (mailbox?.role !== "trash" && mailbox?.role !== "junk")
      throw new MailError("provider", "Only Trash and Junk can be emptied.", {
        reason: "onlyTrashSpam",
      });
    return this.#call("empty", { mailboxId }, signal);
  }

  /**
   * Stores the draft in Drafts and deletes the version before; the draft's
   * id is its message's (both change with every save).
   */
  async saveDraft(
    draft: DraftInput,
    signal?: AbortSignal,
  ): Promise<{ readonly id: DraftId; readonly messageId: MessageId }> {
    const drafts = await this.#roleFolder("drafts", signal);
    const raw = await this.#raw(draft, { signal });
    const { id } = await this.#append(drafts, ["\\Draft", "\\Seen"], raw);
    if (draft.id !== undefined)
      await this.#call("delete", { ids: [draft.id] }, signal).catch(
        () => undefined,
      );
    return { id: asDraftId(id), messageId: asMessageId(id) };
  }

  async draftIdOf(
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<DraftId | undefined> {
    const message = await this.#call("message", { id: messageId }, signal);
    return message.draft ? asDraftId(messageId) : undefined;
  }

  async getDraft(id: DraftId, signal?: AbortSignal): Promise<Draft> {
    const raw = await this.#call("message", { id }, signal);
    const message = toMessage(raw);
    const html =
      message.body.html ??
      (message.body.text === undefined
        ? ""
        : `<div>${escapeHtml(message.body.text).replace(/\n/g, "<br>")}</div>`);
    return {
      id,
      messageId: message.id,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      html,
      text: message.body.text ?? "",
      attachments: message.attachments.map((part) =>
        attachmentOf(message.id, part),
      ),
      threading: {
        ...(message.threadId === undefined
          ? {}
          : { threadId: message.threadId }),
        ...(raw.inReplyTo ? { inReplyTo: raw.inReplyTo } : {}),
        references: message.references,
      },
      ...(message.from ? { from: message.from } : {}),
      ...(message.replyTo.length ? { replyTo: message.replyTo } : {}),
    };
  }

  async deleteDraft(id: DraftId, signal?: AbortSignal): Promise<void> {
    await this.#call("delete", { ids: [id] }, signal);
  }

  /**
   * Sends over SMTP (without the Bcc header), keeps a copy in Sent (with
   * it) unless the server does that itself, and deletes the draft.
   */
  /** Over SMTP, with a copy in Sent (unless the server keeps one). */
  async sendCalendarMail(
    mail: CalendarMail,
    signal?: AbortSignal,
  ): Promise<void> {
    const message = encoder.encode(
      buildMessage({
        ...mail,
        cc: [],
        bcc: [],
        date: new Date(),
        messageId: newMessageId(mail.from.address),
      }),
    );
    try {
      await this.#options.bridge.send(
        this.#options.key,
        {
          from: mail.from.address,
          to: mail.to.map((recipient) => recipient.address),
        },
        message,
      );
    } catch (error) {
      throw this.#error(error);
    }
    if (!this.#options.savesSent)
      await this.#append(
        await this.#roleFolder("sent", signal),
        ["\\Seen"],
        message,
      );
  }

  async sendDraft(
    draft: DraftInput & { readonly id: DraftId },
    signal?: AbortSignal,
  ): Promise<{ readonly messageId: MessageId }> {
    const messageId = newMessageId(this.#from(draft).address);
    const date = new Date();
    const attachments = await this.#attachments(draft.attachments, signal);
    const build = (withoutBcc: boolean) =>
      encoder.encode(
        buildMessage(this.#outgoing(draft, attachments, messageId, date), {
          withoutBcc,
        }),
      );
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc].map(
      (recipient) => recipient.address,
    );
    try {
      await this.#options.bridge.send(
        this.#options.key,
        { from: this.#from(draft).address, to: recipients },
        build(true),
      );
    } catch (error) {
      throw this.#error(error);
    }
    let sentId: string = draft.id;
    if (!this.#options.savesSent) {
      const sent = await this.#roleFolder("sent", signal);
      sentId = (await this.#append(sent, ["\\Seen"], build(false))).id;
    }
    await this.#call("delete", { ids: [draft.id] }, signal).catch(
      () => undefined,
    );
    return { messageId: asMessageId(sentId) };
  }

  /** From the address books of the account's calendar server (CardDAV), if any. */
  searchContacts(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly EmailAddress[]> {
    const search = this.#options.searchContacts;
    if (!search)
      return Promise.reject(
        new MailError("unavailable", "IMAP accounts have no contacts."),
      );
    return search(query, signal);
  }

  async changesSince(
    token: SyncToken | undefined,
    signal?: AbortSignal,
  ): Promise<ChangeSet> {
    const result = await this.#call(
      "changes",
      token === undefined ? {} : { token },
      signal,
    );
    return {
      token: asSyncToken(result.token),
      reset: result.reset,
      changes: result.changes.map((change) =>
        change.kind === "removed"
          ? { kind: "removed", id: asMessageId(change.id) }
          : { kind: change.kind, message: toSummary(change.message) },
      ),
    };
  }

  async createMailbox(
    spec: NewMailbox,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    const name = spec.name.trim();
    if (!name)
      throw new MailError("provider", "A folder needs a name.", {
        reason: "folderNeedsName",
      });
    return toMailbox(
      await this.#call(
        "createFolder",
        {
          name,
          ...(spec.parentId === undefined ? {} : { parentId: spec.parentId }),
        },
        signal,
        name,
      ),
    );
  }

  async updateMailbox(
    id: MailboxId,
    change: MailboxChange,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    const name = change.name?.trim();
    if (change.name !== undefined && !name)
      throw new MailError("provider", "A folder needs a name.", {
        reason: "folderNeedsName",
      });
    return toMailbox(
      await this.#call(
        "updateFolder",
        {
          id,
          ...(name ? { name } : {}),
          ...(change.parentId === undefined
            ? {}
            : { parentId: change.parentId }),
        },
        signal,
        name,
      ),
    );
  }

  /** Into Trash, like Thunderbird; for good when it's in Trash already. */
  async deleteMailbox(id: MailboxId, signal?: AbortSignal): Promise<void> {
    await this.#call("deleteFolder", { id }, signal);
  }

  oneClickUnsubscribe(url: string, signal?: AbortSignal): Promise<void> {
    return sendOneClickUnsubscribe(url, this.#fetch, signal);
  }

  /** The account's own address and the ones added in action0. */
  listSenders(): Promise<readonly Sender[]> {
    return Promise.resolve(this.#senders().list(this.#own()));
  }

  saveSenders(
    senders: readonly SenderSettings[],
    catchAll: readonly string[],
  ): Promise<void> {
    this.#senders().save(this.#own(), senders, catchAll);
    return Promise.resolve();
  }

  catchAllDomains(): Promise<readonly string[]> {
    return Promise.resolve(this.#senders().catchAll());
  }

  /** Kept in the app: IMAP servers don't store signatures. */
  updateSignature(address: string, html: string): Promise<void> {
    this.#senders().updateSignature(address, html);
    return Promise.resolve();
  }

  #own(): OwnAddress {
    const { address, name } = this.#options;
    return name ? { address, name } : { address };
  }

  #senders(): SenderStore {
    return this.#options.senders ?? NO_SENDERS;
  }

  /** Calls the native side; failures become `MailError`s. */
  async #call<K extends ImapCallName>(
    name: K,
    request: ImapCalls[K]["request"],
    signal?: AbortSignal,
    folder?: string,
  ): Promise<ImapCalls[K]["response"]> {
    try {
      return await this.#options.bridge.call(
        this.#options.key,
        name,
        request,
        signal,
      );
    } catch (error) {
      throw this.#error(error, folder);
    }
  }

  async #bytes(
    request: Parameters<ImapBridge["bytes"]>[1],
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      return await this.#options.bridge.bytes(
        this.#options.key,
        request,
        signal,
      );
    } catch (error) {
      throw this.#error(error);
    }
  }

  async #append(
    folder: ImapMailbox,
    flags: readonly string[],
    message: Uint8Array,
  ): Promise<{ readonly id: string }> {
    try {
      return await this.#options.bridge.append(
        this.#options.key,
        { mailboxId: folder.id, flags },
        message,
      );
    } catch (error) {
      throw this.#error(error);
    }
  }

  #error(error: unknown, name?: string): unknown {
    const failure = toMailError(error, {
      service: this.#options.service,
      ...(name === undefined ? {} : { name }),
    });
    if (failure instanceof MailError && failure.code === "auth-required")
      this.#options.onAuthFailed?.();
    return failure;
  }

  #mailboxes(signal?: AbortSignal): Promise<readonly ImapMailbox[]> {
    return this.#call("folders", {}, signal);
  }

  /** The folder with this role, created (with that name) if the account has none. */
  async #roleFolder(
    role: CreatedRole | "inbox",
    signal?: AbortSignal,
  ): Promise<ImapMailbox> {
    const mailboxes = await this.#mailboxes(signal);
    const found = mailboxes.find(
      (mailbox) => mailbox.kind === "folder" && mailbox.role === role,
    );
    if (found) return found;
    if (role === "inbox")
      throw new MailError("not-found", "The account has no Inbox.");
    const name = CREATED_NAMES[role];
    return this.#call("createFolder", { name, role }, signal, name);
  }

  async #moveTo(
    ids: readonly MessageId[],
    role: CreatedRole | "inbox",
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const folder = await this.#roleFolder(role, signal);
    await this.#call("move", { ids, to: folder.id }, signal);
    return {};
  }

  #from(draft: DraftInput): EmailAddress {
    const { address, name } = this.#options;
    return draft.from ?? (name ? { name, address } : { address });
  }

  async #attachments(
    parts: readonly OutgoingAttachment[],
    signal?: AbortSignal,
  ): Promise<MimeAttachment[]> {
    return Promise.all(
      parts.map(async (part) => {
        const blob = await this.#bytesOf(part, signal);
        return {
          filename: part.filename,
          mimeType: part.mimeType,
          content: new Uint8Array(await blob.arrayBuffer()),
          ...(part.contentId === undefined
            ? {}
            : { contentId: part.contentId }),
        };
      }),
    );
  }

  /** An attachment's bytes: loaded already, or fetched from its message. */
  #bytesOf(part: OutgoingAttachment, signal?: AbortSignal): Promise<Blob> {
    if (part.content) return Promise.resolve(part.content);
    if (!part.source)
      return Promise.reject(
        new MailError("provider", `No content for "${part.filename}".`, {
          reason: "noContent",
          params: { name: part.filename },
        }),
      );
    return this.getAttachment(
      part.source.messageId,
      part.source.attachmentId,
      signal,
    );
  }

  #outgoing(
    draft: DraftInput,
    attachments: readonly MimeAttachment[],
    messageId: string,
    date: Date,
  ) {
    return {
      from: this.#from(draft),
      ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      text: draft.text,
      ...(draft.threading?.inReplyTo
        ? { inReplyTo: draft.threading.inReplyTo }
        : {}),
      references: draft.threading?.references ?? [],
      attachments,
      messageId,
      date,
    };
  }

  /** A draft as a message to store. */
  async #raw(
    draft: DraftInput,
    { signal }: { readonly signal?: AbortSignal | undefined },
  ): Promise<Uint8Array> {
    const attachments = await this.#attachments(draft.attachments, signal);
    return encoder.encode(
      buildMessage(
        this.#outgoing(
          draft,
          attachments,
          newMessageId(this.#from(draft).address),
          new Date(),
        ),
      ),
    );
  }
}

const encoder = new TextEncoder();

/** Without a store (tests): nothing is kept. */
const NO_SENDERS = new SenderStore(undefined, "");

function listQuery(query: ListMessagesQuery): ImapCalls["list"]["request"] {
  return {
    mailboxId: query.mailboxId,
    ...(query.search === undefined ? {} : { search: query.search }),
    ...(query.order === undefined ? {} : { order: query.order }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    limit: query.limit,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
