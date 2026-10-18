import {
  attachmentOf,
  uniqueAddresses,
  type Draft,
  type DraftInput,
  type OutgoingAttachment,
} from "../../core/compose";
import { isMailError, MailError } from "../../core/errors";
import {
  asCursor,
  asDraftId,
  asMessageId,
  asSyncToken,
  type AttachmentId,
  type Cursor,
  type DraftId,
  type MailboxId,
  type MessageId,
  type SyncToken,
} from "../../core/ids";
import type {
  EmailAddress,
  Mailbox,
  MailboxColor,
  Message,
  MessageFlags,
  MessageSummary,
  Page,
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
} from "../../core/provider";
import { decodeBase64Url } from "../../lib/base64url";
import { buildMessage } from "../mime/buildMessage";
import { sendOneClickUnsubscribe } from "../oneClickUnsubscribe";
import type { GmailHttp, QueryParams } from "./http";
import {
  ALL_MAIL_ID,
  CATEGORIES_ID,
  GMAIL_LABEL_COLORS,
  idOfPath,
  isMappedLabel,
  isMembershipLabel,
  leafName,
  mapLabels,
  parentPathOf,
  SYNTHETIC_PREFIX,
  toUserMailbox,
} from "./labels";
import { SUMMARY_HEADERS, toMessage, toMessageSummary } from "./mappers";
import { getHeader } from "./mime";
import type {
  GmailAttachment,
  GmailDraft,
  GmailHistoryResponse,
  GmailListDraftsResponse,
  GmailProfile,
  PeoplePerson,
  PeopleSearchResponse,
  GmailLabel,
  GmailListLabelsResponse,
  GmailListMessagesResponse,
  GmailMessage,
  GmailMessagePart,
} from "./types";

/** Mailboxes whose messages `messages.list` excludes unless asked explicitly. */
const SPAM_TRASH = new Set(["SPAM", "TRASH"]);

/** Mailbox ids that are views, not labels. */
const VIEW_IDS: ReadonlySet<string> = new Set([ALL_MAIL_ID, "STARRED"]);

/** An error if any id is one we invented for the tree (Gmail doesn't know them). */
function inventedIdError(ids: readonly MailboxId[]): MailError | undefined {
  const invented = ids.find(
    (id) =>
      id === ALL_MAIL_ID || id === CATEGORIES_ID || id.startsWith("synthetic:"),
  );
  return invented === undefined
    ? undefined
    : new MailError("provider", `"${invented}" is not a Gmail label.`);
}

/** A clear message for Gmail's answers to an unusable label name. */
function labelNameError(error: unknown, path: string): unknown {
  if (!isMailError(error)) return error;
  if (error.status === 409)
    return new MailError(
      "provider",
      `There’s already a label called “${path}”.`,
      { status: 409, cause: error },
    );
  if (error.status === 400 && /label name/i.test(error.message))
    return new MailError(
      "provider",
      `Gmail doesn’t allow the label name “${path}”.`,
      { status: 400, cause: error },
    );
  return error;
}

/** A leaf name for a label: trimmed, not empty, no "/" (Gmail nests on it). */
function checkedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new MailError("provider", "A label needs a name.");
  if (trimmed.includes("/"))
    throw new MailError("provider", "Label names can’t contain “/”.");
  return trimmed;
}

/** The `message` part of draft metadata: files a reply into its thread. */
function threadOf(draft: DraftInput): { threadId?: string } {
  const threadId = draft.threading?.threadId;
  return threadId === undefined ? {} : { threadId };
}

/** A colour in the shape of Gmail's label resource. */
function gmailColor(color: MailboxColor): {
  backgroundColor: string;
  textColor: string;
} {
  return { backgroundColor: color.background, textColor: color.text };
}

/** One address per email of a People API person. */
function personAddresses(person: PeoplePerson | undefined): EmailAddress[] {
  const name = person?.names?.[0]?.displayName?.trim();
  return (person?.emailAddresses ?? []).flatMap(({ value }) =>
    value ? [{ ...(name ? { name } : {}), address: value }] : [],
  );
}

/** People API failures that mean "no contacts here" become `unavailable`. */
function contactsError(error: unknown): unknown {
  if (!isMailError(error) || error.status !== 403) return error;
  const disabled = /has not been used|is disabled|SERVICE_DISABLED/i.test(
    `${error.message} ${JSON.stringify(error.cause ?? "")}`,
  );
  return new MailError(
    "unavailable",
    disabled
      ? "The People API isn't enabled in the Google Cloud project."
      : "Access to your Google contacts wasn't granted.",
    { status: 403, cause: error },
  );
}

/** `messages.list` parameters that select messages. */
type ListFilter = Partial<
  Pick<QueryParams, "labelIds" | "includeSpamTrash" | "q">
>;

/** The messages of a mailbox, or only those matching `search`. */
function listFilter(
  mailboxId: MailboxId,
  search: string | undefined,
): ListFilter {
  return {
    labelIds: mailboxId === ALL_MAIL_ID ? undefined : [mailboxId],
    includeSpamTrash: SPAM_TRASH.has(mailboxId) ? true : undefined,
    q: search?.trim() || undefined,
  };
}

/** More changes than this at once: callers reload instead. */
const MAX_CHANGES = 100;

/** Oldest-first id lists kept for paging (each holds ids only). */
const MAX_SNAPSHOTS = 5;

/** `messages.batchModify` accepts at most this many ids per call. */
export const BATCH_MODIFY_LIMIT = 1000;

/** Label changes of one `batchModify` call. */
interface LabelChange {
  readonly addLabelIds?: readonly string[];
  readonly removeLabelIds?: readonly string[];
}

/** {@link MailProvider} for Gmail, using the REST API (`gmail.modify` scope). */
export class GmailProvider implements MailProvider {
  readonly capabilities: ProviderCapabilities;
  static readonly #CAPABILITIES: ProviderCapabilities = {
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
    mailboxColors: GMAIL_LABEL_COLORS,
  };
  readonly #http: GmailHttp;
  readonly #people: GmailHttp | undefined;
  readonly #fetch: typeof fetch;
  /** Google asks for one empty search before real ones ("warm-up"). */
  #peopleWarmUp: Promise<unknown> | undefined;
  /** Id lists of oldest-first listings, by cursor key (see `#listOldest`). */
  readonly #snapshots = new Map<
    string,
    { readonly filterKey: string; readonly ids: readonly MessageId[] }
  >();

  /**
   * @param http Gmail API client.
   * @param options.people People API client; enables contact suggestions.
   * @param options.fetch For requests to senders (one-click unsubscribe).
   */
  constructor(
    http: GmailHttp,
    options: { people?: GmailHttp; fetch?: typeof fetch } = {},
  ) {
    this.#http = http;
    this.#people = options.people;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.capabilities = {
      ...GmailProvider.#CAPABILITIES,
      contacts: options.people !== undefined,
    };
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
    { mailboxId, search, order = "newest", cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    const filter = listFilter(mailboxId, search);
    if (order === "oldest")
      return this.#listOldest(filter, cursor, limit, signal);

    const list = await this.#http.get<GmailListMessagesResponse>(
      "messages",
      { ...filter, maxResults: limit, pageToken: cursor },
      signal,
    );
    return {
      items: await this.#summaries(
        (list.messages ?? []).map(({ id }) => id),
        signal,
      ),
      ...(list.nextPageToken
        ? { nextCursor: asCursor(list.nextPageToken) }
        : {}),
    };
  }

  async saveDraft(
    draft: DraftInput,
    signal?: AbortSignal,
  ): Promise<{ readonly id: DraftId; readonly messageId: MessageId }> {
    const raw = await this.#raw(draft, signal);
    const message = threadOf(draft);
    // Creating isn't retried: a lost response would leave a duplicate draft.
    const saved =
      draft.id === undefined
        ? await this.#http.upload<GmailDraft>(
            "POST",
            "drafts",
            { message },
            raw,
            { retry: false, signal },
          )
        : await this.#http.upload<GmailDraft>(
            "PUT",
            `drafts/${encodeURIComponent(draft.id)}`,
            { id: draft.id, message },
            raw,
            { retry: true, signal },
          );
    return {
      id: asDraftId(saved.id),
      messageId: asMessageId(saved.message?.id ?? ""),
    };
  }

  async draftIdOf(
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<DraftId | undefined> {
    let pageToken: string | undefined;
    do {
      const page = await this.#http.get<GmailListDraftsResponse>(
        "drafts",
        { maxResults: 500, pageToken },
        signal,
      );
      const found = page.drafts?.find((d) => d.message?.id === messageId);
      if (found) return asDraftId(found.id);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return undefined;
  }

  async getDraft(id: DraftId, signal?: AbortSignal): Promise<Draft> {
    const draft = await this.#http.get<GmailDraft>(
      `drafts/${encodeURIComponent(id)}`,
      { format: "full" },
      signal,
    );
    const raw = draft.message;
    if (!raw) throw new MailError("not-found", `Gmail: draft ${id} is empty.`);
    if (raw.payload)
      await this.#hydrateLargeTextParts(
        asMessageId(raw.id),
        raw.payload,
        signal,
      );
    const message = toMessage(raw);
    const inReplyTo = getHeader(raw.payload?.headers, "In-Reply-To")?.trim();
    return {
      id: asDraftId(draft.id),
      messageId: message.id,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      html: message.body.html ?? "",
      text: message.body.text ?? "",
      attachments: message.attachments.map((part) =>
        attachmentOf(message.id, part),
      ),
      threading: {
        ...(message.threadId === undefined
          ? {}
          : { threadId: message.threadId }),
        ...(inReplyTo ? { inReplyTo } : {}),
        references: message.references,
      },
    };
  }

  async deleteDraft(id: DraftId, signal?: AbortSignal): Promise<void> {
    await this.#http.delete(`drafts/${encodeURIComponent(id)}`, signal);
  }

  async sendDraft(
    draft: DraftInput & { readonly id: DraftId },
    signal?: AbortSignal,
  ): Promise<{ readonly messageId: MessageId }> {
    const raw = await this.#raw(draft, signal, new Date());
    // Uploads the final content and sends it in one request.
    const sent = await this.#http.upload<GmailMessage>(
      "POST",
      "drafts/send",
      { id: draft.id, message: threadOf(draft) },
      raw,
      { retry: false, signal },
    );
    return { messageId: asMessageId(sent.id) };
  }

  async searchContacts(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly EmailAddress[]> {
    const people = this.#people;
    if (!people) return [];
    const search = (path: string, text: string) =>
      people.get<PeopleSearchResponse>(
        path,
        { query: text, readMask: "names,emailAddresses", pageSize: 10 },
        signal,
      );
    const both = (text: string) =>
      Promise.all([
        // "./": a path with a colon would otherwise parse as a URL scheme.
        search("./people:searchContacts", text),
        search("./otherContacts:search", text),
      ]);
    try {
      this.#peopleWarmUp ??= both("").catch((error: unknown) => {
        this.#peopleWarmUp = undefined;
        throw error;
      });
      await this.#peopleWarmUp;
      const [contacts, others] = await both(query);
      return uniqueAddresses(
        [...(contacts.results ?? []), ...(others.results ?? [])].flatMap(
          ({ person }) => personAddresses(person),
        ),
      );
    } catch (error) {
      throw contactsError(error);
    }
  }

  async changesSince(
    token: SyncToken | undefined,
    signal?: AbortSignal,
  ): Promise<ChangeSet> {
    if (token === undefined) return this.#startOver(signal, false);
    const added = new Set<string>();
    const touched = new Set<string>();
    const deleted = new Set<string>();
    let latest: string | undefined;
    let pageToken: string | undefined;
    try {
      do {
        const page = await this.#http.get<GmailHistoryResponse>(
          "history",
          {
            startHistoryId: token,
            historyTypes: [
              "messageAdded",
              "messageDeleted",
              "labelAdded",
              "labelRemoved",
            ],
            maxResults: 500,
            pageToken,
          },
          signal,
        );
        for (const record of page.history ?? []) {
          for (const { message } of record.messagesAdded ?? []) {
            added.add(message.id);
            touched.add(message.id);
          }
          for (const { message } of [
            ...(record.labelsAdded ?? []),
            ...(record.labelsRemoved ?? []),
          ])
            touched.add(message.id);
          for (const { message } of record.messagesDeleted ?? [])
            deleted.add(message.id);
        }
        latest = page.historyId ?? latest;
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
    } catch (error) {
      // History this old is gone: start over.
      if (isMailError(error, "not-found")) return this.#startOver(signal, true);
      throw error;
    }

    for (const id of deleted) touched.delete(id);
    if (touched.size + deleted.size > MAX_CHANGES)
      return this.#startOver(signal, true);
    const summaries = await this.#summaries([...touched], signal);
    const found = new Set(summaries.map((message) => message.id as string));
    return {
      token: asSyncToken(latest ?? token),
      reset: false,
      changes: [
        ...summaries.map((message): MailChange =>
          added.has(message.id)
            ? { kind: "added", message }
            : { kind: "updated", message },
        ),
        // Deleted, or gone before we could read it.
        ...[...deleted, ...[...touched].filter((id) => !found.has(id))].map(
          (id): MailChange => ({ kind: "removed", id: asMessageId(id) }),
        ),
      ],
    };
  }

  async createMailbox(
    { name, parentId, color, hidden = false }: NewMailbox,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    const leaf = checkedName(name);
    const parentPath =
      parentId === undefined ? "" : await this.#pathOf(parentId, signal);
    const path = parentPath ? `${parentPath}/${leaf}` : leaf;
    try {
      const label = await this.#http.post<GmailLabel>(
        "labels",
        {
          name: path,
          labelListVisibility: hidden ? "labelHide" : "labelShow",
          messageListVisibility: "show",
          ...(color ? { color: gmailColor(color) } : {}),
        },
        signal,
      );
      return toUserMailbox(label, parentId);
    } catch (error) {
      throw labelNameError(error, path);
    }
  }

  /**
   * Gmail only stores paths ("Work/Clients"), so renaming or moving a label
   * renames every label below it too. The label itself is replaced as a
   * whole (`labels.update`), which is how its colour can be removed.
   */
  async updateMailbox(
    id: MailboxId,
    { name, parentId, color, hidden }: MailboxChange,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    const current = await this.#userLabel(id, signal);
    const oldPath = current.name;
    const parentPath =
      parentId === undefined
        ? parentPathOf(oldPath)
        : parentId === null
          ? ""
          : await this.#pathOf(parentId, signal);
    if (parentPath === oldPath || parentPath.startsWith(`${oldPath}/`))
      throw new MailError("provider", "A label can’t go inside itself.");
    const leaf = name === undefined ? leafName(oldPath) : checkedName(name);
    const path = parentPath ? `${parentPath}/${leaf}` : leaf;
    const nextColor =
      color === undefined
        ? current.color
        : color === null
          ? undefined
          : gmailColor(color);

    let updated: GmailLabel;
    try {
      updated = await this.#http.put<GmailLabel>(
        `labels/${encodeURIComponent(id)}`,
        {
          id,
          name: path,
          messageListVisibility: current.messageListVisibility ?? "show",
          labelListVisibility:
            hidden === undefined
              ? (current.labelListVisibility ?? "labelShow")
              : hidden
                ? "labelHide"
                : "labelShow",
          ...(nextColor ? { color: nextColor } : {}),
        },
        signal,
      );
    } catch (error) {
      throw labelNameError(error, path);
    }

    const { labels = [] } = await this.#http.get<GmailListLabelsResponse>(
      "labels",
      undefined,
      signal,
    );
    if (path !== oldPath) {
      const below = labels.filter(
        (label) =>
          label.type === "user" && label.name.startsWith(`${oldPath}/`),
      );
      await Promise.all(
        below.map(async (label) => {
          const renamed = path + label.name.slice(oldPath.length);
          try {
            await this.#http.patch(
              `labels/${encodeURIComponent(label.id)}`,
              { name: renamed },
              signal,
            );
          } catch (error) {
            throw labelNameError(error, renamed);
          }
        }),
      );
    }
    return toUserMailbox(updated, idOfPath(parentPath, labels));
  }

  async deleteMailbox(id: MailboxId, signal?: AbortSignal): Promise<void> {
    await this.#userLabel(id, signal);
    await this.#http.delete(`labels/${encodeURIComponent(id)}`, signal);
  }

  oneClickUnsubscribe(url: string, signal?: AbortSignal): Promise<void> {
    return sendOneClickUnsubscribe(url, this.#fetch, signal);
  }

  /** A user label (system labels and the tree's own nodes can't be changed). */
  async #userLabel(id: MailboxId, signal?: AbortSignal): Promise<GmailLabel> {
    const invalid = inventedIdError([id]);
    if (invalid) throw invalid;
    const label = await this.#http.get<GmailLabel>(
      `labels/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
    if (label.type !== "user")
      throw new MailError("provider", "System labels can’t be changed.");
    return label;
  }

  /** The path of a label that others can nest in ("Work/Clients"). */
  async #pathOf(id: MailboxId, signal?: AbortSignal): Promise<string> {
    if (id.startsWith(SYNTHETIC_PREFIX))
      return id.slice(SYNTHETIC_PREFIX.length);
    return (await this.#userLabel(id, signal)).name;
  }

  /** A fresh token (the current history id); `reset` asks callers to reload. */
  async #startOver(
    signal: AbortSignal | undefined,
    reset: boolean,
  ): Promise<ChangeSet> {
    const profile = await this.#http.get<GmailProfile>(
      "profile",
      undefined,
      signal,
    );
    return {
      token: asSyncToken(profile.historyId ?? ""),
      reset,
      changes: [],
    };
  }

  /** An attachment's bytes: loaded already, or fetched from its message. */
  #bytesOf(part: OutgoingAttachment, signal?: AbortSignal): Promise<Blob> {
    if (part.content) return Promise.resolve(part.content);
    if (!part.source)
      return Promise.reject(
        new MailError("provider", `No content for "${part.filename}".`),
      );
    return this.getAttachment(
      part.source.messageId,
      part.source.attachmentId,
      signal,
    );
  }

  /** The raw message for a draft, with the bytes of its attachments. */
  async #raw(
    draft: DraftInput,
    signal?: AbortSignal,
    date?: Date,
  ): Promise<string> {
    const attachments = await Promise.all(
      draft.attachments.map(async (part) => {
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
    // No From header: Gmail fills in the account's address and name.
    return buildMessage({
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
      ...(date ? { date } : {}),
    });
  }

  /**
   * Oldest first. Gmail only lists newest first, so this lists every matching
   * id (500 per request, ids only), reverses them and pages through that
   * snapshot. Cursors are `<snapshot>:<offset>`. The last few snapshots stay
   * in memory; one that's gone (e.g. after a reload) is listed again.
   */
  async #listOldest(
    filter: ListFilter,
    cursor: Cursor | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    const filterKey = JSON.stringify(filter);
    const [cursorKey = "", cursorOffset = "0"] = cursor?.split(":") ?? [];
    const offset = Number(cursorOffset) || 0;
    const snapshot = this.#snapshots.get(cursorKey);
    let key = cursorKey;
    let ids = snapshot?.filterKey === filterKey ? snapshot.ids : undefined;
    if (!ids) {
      ids = (await this.#listAllIds(filter, signal)).reverse();
      key = crypto.randomUUID();
      this.#snapshots.set(key, { filterKey, ids });
      for (const old of this.#snapshots.keys()) {
        if (this.#snapshots.size <= MAX_SNAPSHOTS) break;
        this.#snapshots.delete(old);
      }
    }
    const next = offset + limit;
    return {
      items: await this.#summaries(ids.slice(offset, next), signal),
      ...(next < ids.length ? { nextCursor: asCursor(`${key}:${next}`) } : {}),
    };
  }

  /** Every message id that `filter` selects, newest first. */
  async #listAllIds(
    filter: ListFilter,
    signal?: AbortSignal,
  ): Promise<MessageId[]> {
    const ids: MessageId[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#http.get<GmailListMessagesResponse>(
        "messages",
        { ...filter, maxResults: 500, pageToken },
        signal,
      );
      ids.push(...(page.messages ?? []).map(({ id }) => asMessageId(id)));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return ids;
  }

  /** Summaries of the given messages, in the same order. */
  async #summaries(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<MessageSummary[]> {
    const messages = await Promise.all(
      ids.map((id) =>
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
    return messages
      .filter((message): message is GmailMessage => message !== undefined)
      .map(toMessageSummary);
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

  /**
   * Gmail moves by relabelling: add `to`, remove `from` unless `from` is a
   * view (All Mail, Starred), so moving out of a view never unstars.
   */
  move(
    ids: readonly MessageId[],
    { from, to }: { readonly from: MailboxId; readonly to: MailboxId },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const invalid = inventedIdError([to]);
    if (invalid) return Promise.reject(invalid);
    const removeFrom =
      isMembershipLabel(from) && !VIEW_IDS.has(from) ? [from] : [];
    return this.#modify(
      ids,
      { addLabelIds: [to], removeLabelIds: removeFrom },
      signal,
    );
  }

  setLabels(
    ids: readonly MessageId[],
    {
      add,
      remove,
    }: {
      readonly add: readonly MailboxId[];
      readonly remove: readonly MailboxId[];
    },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const invalid = inventedIdError([...add, ...remove]);
    if (invalid) return Promise.reject(invalid);
    return this.#modify(
      ids,
      { addLabelIds: add, removeLabelIds: remove },
      signal,
    );
  }

  /** Gmail's dedicated call (there's no batch variant); runs within the request limit. */
  trash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#eachMessage(ids, "trash", signal);
  }

  untrash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#eachMessage(ids, "untrash", signal);
  }

  reportSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#modify(
      ids,
      { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
      signal,
    );
  }

  notSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#modify(
      ids,
      { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
      signal,
    );
  }

  /** `messages.batchDelete` (needs the full-access scope). */
  async deleteForever(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    for (let start = 0; start < ids.length; start += BATCH_MODIFY_LIMIT) {
      await this.#http.post(
        "messages/batchDelete",
        { ids: ids.slice(start, start + BATCH_MODIFY_LIMIT) },
        signal,
      );
    }
    return {};
  }

  /** Lists every message of Trash or Spam, then deletes them permanently. */
  async emptyMailbox(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<{ readonly deleted: number }> {
    if (!SPAM_TRASH.has(mailboxId)) {
      throw new MailError("provider", "Only Trash and Spam can be emptied.");
    }
    const ids = await this.#listAllIds(
      { labelIds: [mailboxId], includeSpamTrash: true },
      signal,
    );
    await this.deleteForever(ids, signal);
    return { deleted: ids.length };
  }

  async #eachMessage(
    ids: readonly MessageId[],
    action: "trash" | "untrash",
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    await Promise.all(
      ids.map((id) =>
        this.#http.post(
          `messages/${encodeURIComponent(id)}/${action}`,
          undefined,
          signal,
        ),
      ),
    );
    return {};
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
