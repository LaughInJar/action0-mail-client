import {
  attachmentOf,
  type Draft,
  type DraftInput,
  type OutgoingAttachment,
} from "../../core/compose";
import { isMailError, MailError } from "../../core/errors";
import {
  asCursor,
  asDraftId,
  asMailboxId,
  asMessageId,
  asSyncToken,
  asThreadId,
  type AttachmentId,
  type Cursor,
  type DraftId,
  type MailboxId,
  type MessageId,
  type SyncToken,
  type ThreadId,
} from "../../core/ids";
import type {
  EmailAddress,
  Invitation,
  Mailbox,
  MailboxColor,
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
  MessageOrder,
  MutationResult,
  NewMailbox,
  ProviderCapabilities,
} from "../../core/provider";
import { encodeBase64 } from "../../lib/base64url";
import { readJson, writeJson } from "../../lib/storage";
import { sendOneClickUnsubscribe } from "../oneClickUnsubscribe";
import {
  CATEGORIES_GROUP,
  categoryName,
  FLAGGED_VIEW_ID,
  FOLDER_SELECT,
  folderIdsOf,
  internalIds,
  isViewId,
  mapFolders,
  OUTLOOK_CATEGORY_COLORS,
  presetOf,
  ROOT_FOLDER,
  toCategory,
  toMailbox,
  WELL_KNOWN_NAMES,
  type WellKnownFolders,
} from "./folders";
import {
  GRAPH_BASE,
  graphErrorCode,
  type BatchRequest,
  type BatchResult,
  type GraphHttp,
  type QueryParams,
} from "./http";
import {
  ATTACHMENT_SELECT,
  headerOf,
  MESSAGE_SELECT,
  messageIds,
  SUMMARY_SELECT,
  toAddresses,
  toInvitation,
  toMessage,
  toMessageSummary,
  toRecipient,
} from "./mappers";
import type {
  GraphAttachment,
  GraphCategory,
  GraphMailFolder,
  GraphMessage,
  GraphPage,
  GraphPerson,
  GraphUploadSession,
  GraphUser,
} from "./types";

/** Files up to this size go up in one request; bigger ones use an upload session. */
export const SMALL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Upload session chunks: a multiple of 320 KiB, as Graph requires. */
export const UPLOAD_CHUNK_BYTES = 12 * 320 * 1024;

/** Live updates follow mail received in this many days (older mail: read state and moves only). */
export const DELTA_WINDOW_DAYS = 30;

/** More changes than this at once: callers reload instead. */
const MAX_CHANGES = 100;

/** Oldest-first search results kept for paging. */
const MAX_SNAPSHOTS = 5;

/** At most this many search results are sorted oldest first. */
const MAX_SORTED_RESULTS = 1000;

/** Pages fetched at most to fill one page of a view (filtered client-side). */
const MAX_VIEW_PAGES = 5;

/** Messages of one conversation fetched at most. */
const MAX_THREAD_MESSAGES = 100;

/** Messages read at most to list conversations oldest first. */
const MAX_OLDEST_SCAN = 20_000;

/** `$select` for ordering conversations: just enough to group and filter. */
const ORDER_SELECT = "id,conversationId,receivedDateTime,parentFolderId,flag";

/** Options of {@link GraphProvider}. */
export interface GraphProviderOptions {
  /** A personal account (Outlook.com): 20 MB of attachments instead of 25. */
  readonly personal?: boolean;
  /** Where signatures live (localStorage), under {@link signatureKey}. */
  readonly settings?: Storage | undefined;
  /** Storage key of this account's signatures. */
  readonly signatureKey?: string;
  /** For requests to senders (one-click unsubscribe). */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** What {@link GraphProvider.changesSince} keeps in its (opaque) token. */
interface DeltaState {
  /** Start of the last poll (ISO): messages created after it are new. */
  readonly since: string;
  /** Delta link per tracked folder. */
  readonly folders: Readonly<Record<string, string>>;
  /** Delta link of the folder tree. */
  readonly tree: string;
}

const enc = encodeURIComponent;

/** A `$search` value: quoted, as Graph requires. */
function searchValue(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The first failure of a batch, thrown; the bodies otherwise. */
function bodiesOrThrow<T>(results: readonly BatchResult<T>[]): T[] {
  return results.map((result) => {
    if (!result.ok) throw result.error;
    return result.body;
  });
}

/** A leaf name for a folder: trimmed and not empty. */
function checkedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "")
    throw new MailError("provider", "A folder needs a name.", {
      reason: "folderNeedsName",
    });
  return trimmed;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The fields of a draft that a create or update sets. */
function draftFields(draft: DraftInput) {
  return {
    subject: draft.subject,
    body: { contentType: "html", content: draft.html },
    toRecipients: draft.to.map(toRecipient),
    ccRecipients: draft.cc.map(toRecipient),
    bccRecipients: draft.bcc.map(toRecipient),
  };
}

/**
 * {@link MailProvider} for Exchange Online and Outlook.com, through
 * Microsoft Graph. Folders are exclusive (`folder` mailboxes); Flagged and
 * All mail are views. Message ids are immutable, so they survive moves.
 */
export class GraphProvider implements MailProvider {
  readonly capabilities: ProviderCapabilities;
  readonly #http: GraphHttp;
  readonly #options: GraphProviderOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #wellKnown: Promise<WellKnownFolders> | undefined;
  /** Files of drafts already uploaded: draft id → (local id → attachment id). */
  readonly #uploaded = new Map<string, Map<string, string>>();
  /** Sorted results kept for paging (messages, or conversation ids), by key. */
  readonly #snapshots = new Map<string, readonly unknown[]>();
  #nextSnapshot = 1;

  constructor(http: GraphHttp, options: GraphProviderOptions = {}) {
    this.#http = http;
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.capabilities = {
      // Folders, and Outlook's categories as labels.
      mailboxKinds: ["folder", "label", "view"],
      archive: true,
      settableFlags: ["seen", "flagged"],
      move: true,
      labels: true,
      trash: true,
      spam: true,
      deleteForever: true,
      compose: true,
      contacts: true,
      maxAttachmentBytes: (options.personal ? 20 : 25) * 1024 * 1024,
      manageMailboxes: true,
      mailboxEditing: {
        folder: { rename: true, colors: [], nest: true, hide: false },
        // Graph can only change a category's colour.
        label: {
          rename: false,
          colors: OUTLOOK_CATEGORY_COLORS,
          nest: false,
          hide: false,
        },
      },
      threads: true,
      senders: true,
      editSignatures: true,
      signatureStore: "browser",
    };
  }

  async listMailboxes(signal?: AbortSignal): Promise<readonly Mailbox[]> {
    const wellKnown = await this.#wellKnownFolders();
    const internal = internalIds(wellKnown);
    const all: GraphMailFolder[] = [];
    let level = await this.#all<GraphMailFolder>(
      "me/mailFolders",
      { $select: FOLDER_SELECT, $top: 250 },
      signal,
    );
    while (level.length > 0) {
      all.push(...level);
      const parents = level.filter(
        (folder) =>
          (folder.childFolderCount ?? 0) > 0 && !internal.has(folder.id),
      );
      const pages = bodiesOrThrow(
        await this.#http.batch<GraphPage<GraphMailFolder>>(
          parents.map((folder) => ({
            method: "GET",
            path: `me/mailFolders/${enc(folder.id)}/childFolders?$select=${FOLDER_SELECT}&$top=250`,
          })),
          signal,
        ),
      );
      level = pages.flatMap((page) => page.value ?? []);
    }
    const categories = await this.#categories(signal);
    return [
      ...mapFolders(all, wellKnown),
      ...(categories.length > 0 ? [CATEGORIES_GROUP, ...categories] : []),
    ];
  }

  /**
   * The user's categories as labels, by name, with their unread mail where
   * Graph counts it. None while the permission for them is missing (an
   * account that hasn't reconnected since).
   */
  async #categories(signal: AbortSignal | undefined): Promise<Mailbox[]> {
    let categories: readonly GraphCategory[];
    try {
      categories =
        (
          await this.#http.get<GraphPage<GraphCategory>>(
            "me/outlook/masterCategories",
            undefined,
            signal,
          )
        ).value ?? [];
    } catch (error) {
      if (error instanceof MailError && error.status === 403) return [];
      throw error;
    }
    const sorted = [...categories].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    const counts = await this.#http.batch<{ "@odata.count"?: number }>(
      sorted.map((category) => ({
        method: "GET",
        path: `me/messages?${new URLSearchParams({
          $filter: `isRead eq false and ${categoryFilter(category.displayName)}`,
          $count: "true",
          $top: "1",
          $select: "id",
        }).toString()}`,
        headers: { ConsistencyLevel: "eventual" },
      })),
      signal,
    );
    return sorted.map((category, index) => {
      const result = counts[index];
      const unread = result?.ok ? result.body["@odata.count"] : undefined;
      return toCategory(category, unread);
    });
  }

  async listMessages(
    { mailboxId, search, order = "newest", cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    const text = search?.trim();
    const keep = await this.#viewFilter(mailboxId);
    if (text && order === "oldest")
      return this.#snapshotPage(
        cursor,
        limit,
        async () =>
          (await this.#matches(mailboxId, text, keep, signal)).sort((a, b) =>
            a.receivedAt.localeCompare(b.receivedAt),
          ),
        (items) => Promise.resolve(items),
      );

    const view = isViewId(mailboxId);
    let url: URL;
    if (cursor) url = new URL(cursor);
    else if (text) {
      url = this.#http.url(
        view ? "me/messages" : `me/mailFolders/${enc(mailboxId)}/messages`,
        { $search: searchValue(text), $select: SUMMARY_SELECT, $top: limit },
      );
    } else {
      url = this.#listUrl(mailboxId, order, SUMMARY_SELECT, limit);
    }

    // Views filter what Graph returns, so a page may need a few requests.
    const items: MessageSummary[] = [];
    let next: string | undefined = url.href;
    for (let pages = 0; next !== undefined && pages < MAX_VIEW_PAGES; pages++) {
      const page: GraphPage<GraphMessage> = await this.#http.get<
        GraphPage<GraphMessage>
      >(new URL(next), undefined, signal);
      items.push(...(page.value ?? []).map(toMessageSummary).filter(keep));
      next = page["@odata.nextLink"];
      if (!view || items.length > 0) break;
    }
    return {
      items,
      ...(next === undefined ? {} : { nextCursor: asCursor(next) }),
    };
  }

  /**
   * Outlook's conversations (its conversation id) with a message in the
   * mailbox. Graph can't list conversations, so newest first walks the
   * mailbox's messages page by page and shows each conversation on the page
   * that holds its newest message there (so it appears exactly once). Search
   * and oldest first collect and sort the conversations first, then page
   * through them as a snapshot.
   */
  async listThreads(
    { mailboxId, search, order = "newest", cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<ThreadSummary>> {
    const text = search?.trim();
    const keep = await this.#viewFilter(mailboxId);
    if (text || order === "oldest")
      return this.#snapshotPage(
        cursor,
        limit,
        () => this.#conversationOrder(mailboxId, text, order, keep, signal),
        async (ids) => {
          const threads = await this.#threadSummaries(ids, signal);
          return ids.flatMap((id) => {
            const thread = threads.get(id);
            return thread ? [thread] : [];
          });
        },
      );

    const belongs = (message: MessageSummary) =>
      isViewId(mailboxId)
        ? keep(message)
        : message.mailboxIds.includes(mailboxId);
    const items: ThreadSummary[] = [];
    let next: string | undefined =
      cursor ?? this.#listUrl(mailboxId, "newest", SUMMARY_SELECT, limit).href;
    for (let pages = 0; next !== undefined && pages < MAX_VIEW_PAGES; pages++) {
      const page: GraphPage<GraphMessage> = await this.#http.get<
        GraphPage<GraphMessage>
      >(new URL(next), undefined, signal);
      next = page["@odata.nextLink"];
      const listed = (page.value ?? []).map(toMessageSummary).filter(keep);
      const onPage = new Set<string>(listed.map((message) => message.id));
      const ids = [...new Set(listed.map(conversationOf))];
      const threads = await this.#threadSummaries(ids, signal, listed);
      for (const id of ids) {
        const thread = threads.get(id);
        const newest = thread?.messages.filter(belongs).at(-1);
        // Shown on an earlier page if its newest message there is newer.
        if (thread && newest && onPage.has(newest.id)) items.push(thread);
      }
      if (items.length > 0) break;
    }
    return {
      items,
      ...(next === undefined ? {} : { nextCursor: asCursor(next) }),
    };
  }

  /** A whole conversation from every folder, with bodies and attachments, oldest first. */
  async getThread(id: ThreadId, signal?: AbortSignal): Promise<Thread> {
    let messages = await this.#all<GraphMessage>(
      "me/messages",
      {
        $filter: conversationFilter(id),
        $select: MESSAGE_SELECT,
        $top: 50,
      },
      signal,
      MAX_THREAD_MESSAGES,
    );
    if (messages.length === 0) {
      // A message without a conversation id is a conversation of its own.
      const { message } = await this.#fetchMessage(asMessageId(id), signal);
      messages = [message];
    }
    const attachments = bodiesOrThrow(
      await this.#http.batch<GraphPage<GraphAttachment>>(
        messages.map((message) => ({
          method: "GET",
          path: `me/messages/${enc(message.id)}/attachments?$select=${ATTACHMENT_SELECT}`,
        })),
        signal,
      ),
    );
    return {
      id,
      messages: messages
        .map((message, index) =>
          toMessage(message, attachments[index]?.value ?? []),
        )
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
    };
  }

  async getMessage(id: MessageId, signal?: AbortSignal): Promise<Message> {
    const { message, attachments } = await this.#fetchMessage(id, signal);
    return toMessage(
      message,
      attachments,
      await this.#invitationOf(message, signal),
    );
  }

  /**
   * The invitation an event message (Outlook's invitations, cancellations
   * and answers) is about: its event's UID. Other mail has none; a failed
   * lookup just leaves it out.
   */
  async #invitationOf(
    message: GraphMessage,
    signal: AbortSignal | undefined,
  ): Promise<Invitation | undefined> {
    if (!message["@odata.type"]?.includes("eventMessage")) return undefined;
    try {
      const event = await this.#http.get<GraphMessage>(
        `me/messages/${enc(message.id)}/microsoft.graph.eventMessage`,
        {
          $select: "id,meetingMessageType",
          $expand: "event($select=iCalUId)",
        },
        signal,
      );
      return toInvitation(event);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.#http.getBlob(
      `me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/$value`,
      signal,
    );
  }

  archive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveAll(ids, "archive", signal);
  }

  unarchive(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveAll(ids, "inbox", signal);
  }

  async setFlags(
    ids: readonly MessageId[],
    flags: Partial<MessageFlags>,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const body = {
      ...(flags.seen === undefined ? {} : { isRead: flags.seen }),
      ...(flags.flagged === undefined
        ? {}
        : { flag: { flagStatus: flags.flagged ? "flagged" : "notFlagged" } }),
    };
    bodiesOrThrow(
      await this.#http.batch(
        ids.map((id) => ({
          method: "PATCH",
          path: `me/messages/${enc(id)}`,
          body,
        })),
        signal,
      ),
    );
    return {};
  }

  move(
    ids: readonly MessageId[],
    { to }: { readonly from: MailboxId; readonly to: MailboxId },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    if (isViewId(to)) return Promise.reject(notAFolder(to));
    return this.#moveAll(ids, to, signal);
  }

  /** Adds and removes categories (the only labels Outlook has). */
  async setLabels(
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
    const names = (mailboxIds: readonly MailboxId[]) =>
      mailboxIds.map((id) => {
        const name = categoryName(id);
        if (name === undefined) throw notACategory(id);
        return name;
      });
    const added = names(add);
    const removed = new Set(names(remove));
    // Graph replaces the whole list, so read each message's first.
    const current = bodiesOrThrow(
      await this.#http.batch<Pick<GraphMessage, "categories">>(
        ids.map((id) => ({
          method: "GET",
          path: `me/messages/${enc(id)}?$select=categories`,
        })),
        signal,
      ),
    );
    bodiesOrThrow(
      await this.#http.batch(
        ids.map((id, index) => ({
          method: "PATCH",
          path: `me/messages/${enc(id)}`,
          body: {
            categories: [
              ...new Set([
                ...(current[index]?.categories ?? []).filter(
                  (name) => !removed.has(name),
                ),
                ...added,
              ]),
            ],
          },
        })),
        signal,
      ),
    );
    return {};
  }

  trash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveAll(ids, "deleteditems", signal);
  }

  /** Graph doesn't say where a message was before, so it goes back to the inbox. */
  untrash(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveAll(ids, "inbox", signal);
  }

  reportSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveAll(ids, "junkemail", signal);
  }

  notSpam(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    return this.#moveAll(ids, "inbox", signal);
  }

  /** Like Outlook's Shift+Delete: "Recover deleted items" can still bring them back for a while. */
  async deleteForever(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    bodiesOrThrow(
      await this.#http.batch(
        ids.map((id) => ({ method: "DELETE", path: `me/messages/${enc(id)}` })),
        signal,
      ),
    );
    return {};
  }

  async emptyMailbox(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<{ readonly deleted: number }> {
    const wellKnown = await this.#wellKnownFolders();
    if (
      mailboxId !== wellKnown.get("deleteditems") &&
      mailboxId !== wellKnown.get("junkemail")
    )
      throw new MailError("provider", "Only Trash and Spam can be emptied.", {
        reason: "onlyTrashSpam",
      });
    let deleted = 0;
    for (;;) {
      const page = await this.#http.get<GraphPage<GraphMessage>>(
        `me/mailFolders/${enc(mailboxId)}/messages`,
        { $select: "id", $top: 200 },
        signal,
      );
      const ids = (page.value ?? []).map((message) => asMessageId(message.id));
      if (ids.length === 0) return { deleted };
      await this.deleteForever(ids, signal);
      deleted += ids.length;
    }
  }

  async saveDraft(
    draft: DraftInput,
    signal?: AbortSignal,
  ): Promise<{ readonly id: DraftId; readonly messageId: MessageId }> {
    let id = draft.id as string | undefined;
    if (id === undefined) {
      id = await this.#createDraft(draft, signal);
    } else {
      await this.#http.patch(
        `me/messages/${enc(id)}`,
        draftFields(draft),
        signal,
      );
    }
    await this.#syncAttachments(id, draft.attachments, signal);
    return { id: asDraftId(id), messageId: asMessageId(id) };
  }

  async draftIdOf(
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<DraftId | undefined> {
    try {
      const message = await this.#http.get<GraphMessage>(
        `me/messages/${enc(messageId)}`,
        { $select: "id,isDraft" },
        signal,
      );
      return message.isDraft ? asDraftId(message.id) : undefined;
    } catch (error) {
      if (isMailError(error, "not-found")) return undefined;
      throw error;
    }
  }

  async getDraft(id: DraftId, signal?: AbortSignal): Promise<Draft> {
    const { message: raw, attachments } = await this.#fetchMessage(
      asMessageId(id),
      signal,
    );
    const message = toMessage(raw, attachments);
    const [inReplyTo] = messageIds(
      headerOf(raw.internetMessageHeaders, "In-Reply-To"),
    );
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
      bcc: toAddresses(raw.bccRecipients),
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
        ...(inReplyTo ? { inReplyTo } : {}),
        references: message.references,
      },
    };
  }

  async deleteDraft(id: DraftId, signal?: AbortSignal): Promise<void> {
    this.#uploaded.delete(id);
    await this.#http.delete(`me/messages/${enc(id)}`, signal);
  }

  /** Saves the final content and sends; the message keeps its id in Sent Items. */
  async sendDraft(
    draft: DraftInput & { readonly id: DraftId },
    signal?: AbortSignal,
  ): Promise<{ readonly messageId: MessageId }> {
    await this.saveDraft(draft, signal);
    await this.#http.post(`me/messages/${enc(draft.id)}/send`, undefined, {
      retry: false,
      ...(signal ? { signal } : {}),
    });
    this.#uploaded.delete(draft.id);
    return { messageId: asMessageId(draft.id) };
  }

  /** People you correspond with (Microsoft's People list), best first. */
  async searchContacts(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly EmailAddress[]> {
    try {
      const page = await this.#http.get<GraphPage<GraphPerson>>(
        "me/people",
        {
          $search: searchValue(query),
          $top: 10,
          $select: "displayName,scoredEmailAddresses",
        },
        signal,
      );
      return (page.value ?? []).flatMap((person) => {
        const name = person.displayName?.trim();
        return (person.scoredEmailAddresses ?? []).flatMap(({ address }) =>
          address
            ? [{ ...(name && name !== address ? { name } : {}), address }]
            : [],
        );
      });
    } catch (error) {
      if (isMailError(error) && (error.status === 403 || error.status === 400))
        throw new MailError(
          "unavailable",
          "Microsoft’s list of people isn’t available for this account.",
          { status: error.status, cause: error, reason: "peopleUnavailable" },
        );
      throw error;
    }
  }

  async changesSince(
    token: SyncToken | undefined,
    signal?: AbortSignal,
  ): Promise<ChangeSet> {
    const state = token === undefined ? undefined : parseState(token);
    if (state === undefined)
      return this.#startOver(signal, token !== undefined);
    const started = new Date(this.#now()).toISOString();

    const links = new Map(Object.entries(state.folders));
    const present = new Set<string>();
    const removed = new Set<string>();
    let treeChanged = false;
    let tree = state.tree;

    const results = await this.#http.batch<GraphPage<GraphMessage>>(
      [
        ...[...links.values()].map((link): BatchRequest => ({
          method: "GET",
          path: relativePath(link),
        })),
        { method: "GET", path: relativePath(tree) },
      ],
      signal,
    );
    const folderIds = [...links.keys()];
    const internal = internalIds(await this.#wellKnownFolders());
    for (const [index, result] of results.entries()) {
      const folderId = folderIds[index];
      if (!result.ok) {
        // A folder that's gone (or whose sync state expired): rebuild.
        if (result.error.code === "not-found" || result.error.status === 410) {
          treeChanged = true;
          if (folderId !== undefined) links.delete(folderId);
          continue;
        }
        throw result.error;
      }
      const { values, link } = await this.#finishRound(result.body, signal);
      if (folderId === undefined) {
        tree = link;
        // New or deleted folders; renames and counts just refresh the tree.
        if (
          values.some(
            (folder) =>
              !internal.has(folder.id) &&
              (folder["@removed"] !== undefined || !links.has(folder.id)),
          )
        )
          treeChanged = true;
        continue;
      }
      links.set(folderId, link);
      for (const message of values) {
        if (message["@removed"]) removed.add(message.id);
        else present.add(message.id);
      }
    }

    if (treeChanged) {
      // New folders start being tracked; vanished ones are dropped.
      const current = folderIdsOf(await this.listMailboxes(signal));
      for (const id of links.keys())
        if (!current.includes(asMailboxId(id))) links.delete(id);
      await Promise.all(
        current
          .filter((id) => !links.has(id))
          .map(async (id) => {
            links.set(id, await this.#startFolder(id, signal));
          }),
      );
    }

    const touched = [...new Set([...present, ...removed])];
    if (touched.length > MAX_CHANGES) return this.#startOver(signal, true);
    const summaries = await this.#http.batch<GraphMessage>(
      touched.map((id) => ({
        method: "GET",
        path: `me/messages/${enc(id)}?$select=${SUMMARY_SELECT}`,
      })),
      signal,
    );
    const changes: MailChange[] = [];
    for (const [index, result] of summaries.entries()) {
      const id = touched[index] ?? "";
      if (!result.ok) {
        if (result.error.code !== "not-found") throw result.error;
        changes.push({ kind: "removed", id: asMessageId(id) });
        continue;
      }
      const message = toMessageSummary(result.body);
      const created = result.body.createdDateTime ?? "";
      const isNew =
        present.has(id) && !removed.has(id) && created >= state.since;
      changes.push({ kind: isNew ? "added" : "updated", message });
    }
    return {
      token: stateToken({
        since: started,
        folders: Object.fromEntries(links),
        tree,
      }),
      reset: false,
      changes,
    };
  }

  async createMailbox(
    { name, parentId, kind, color }: NewMailbox,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    if (kind === "label") return this.#createCategory(name, color, signal);
    const leaf = checkedName(name);
    if (parentId !== undefined && isViewId(parentId))
      throw notAFolder(parentId);
    const wellKnown = await this.#wellKnownFolders();
    try {
      const folder = await this.#http.post<GraphMailFolder>(
        parentId === undefined
          ? "me/mailFolders"
          : `me/mailFolders/${enc(parentId)}/childFolders`,
        { displayName: leaf },
        { retry: false, ...(signal ? { signal } : {}) },
      );
      return toMailbox(folder, wellKnown);
    } catch (error) {
      throw folderNameError(error, leaf);
    }
  }

  async updateMailbox(
    id: MailboxId,
    change: MailboxChange,
    signal?: AbortSignal,
  ): Promise<Mailbox> {
    const category = categoryName(id);
    if (category !== undefined)
      return this.#updateCategory(category, change, signal);
    const { name, parentId } = change;
    const wellKnown = await this.#userFolder(id);
    const leaf = name === undefined ? undefined : checkedName(name);
    if (parentId === id)
      throw new MailError("provider", "A folder can’t go inside itself.", {
        reason: "folderInsideItself",
      });
    if (parentId !== undefined && parentId !== null && isViewId(parentId))
      throw notAFolder(parentId);
    try {
      if (leaf !== undefined)
        await this.#http.patch(
          `me/mailFolders/${enc(id)}`,
          { displayName: leaf },
          signal,
        );
      if (parentId !== undefined)
        await this.#http.post(
          `me/mailFolders/${enc(id)}/move`,
          {
            destinationId:
              parentId ?? wellKnown.get(ROOT_FOLDER) ?? ROOT_FOLDER,
          },
          signal ? { signal } : {},
        );
    } catch (error) {
      if (graphErrorCode(error) === "ErrorMoveCopyFailed")
        throw new MailError("provider", "A folder can’t go inside itself.", {
          cause: error,
          reason: "folderInsideItself",
        });
      throw folderNameError(error, leaf ?? "");
    }
    const folder = await this.#http.get<GraphMailFolder>(
      `me/mailFolders/${enc(id)}`,
      { $select: FOLDER_SELECT },
      signal,
    );
    return toMailbox(folder, wellKnown);
  }

  /**
   * Like Outlook: the folder and its mail move to Deleted Items (where they
   * can be restored). A folder that's already there is deleted.
   */
  async deleteMailbox(id: MailboxId, signal?: AbortSignal): Promise<void> {
    const category = categoryName(id);
    if (category !== undefined) {
      // Like Outlook: it leaves the list; mail keeps the name.
      const { id: categoryId } = await this.#category(category, signal);
      await this.#http.delete(
        `me/outlook/masterCategories/${enc(categoryId)}`,
        signal,
      );
      return;
    }
    const wellKnown = await this.#userFolder(id);
    const trash = wellKnown.get("deleteditems");
    const folder = await this.#http.get<GraphMailFolder>(
      `me/mailFolders/${enc(id)}`,
      { $select: "id,parentFolderId" },
      signal,
    );
    if (trash === undefined || folder.parentFolderId === trash) {
      await this.#http.delete(`me/mailFolders/${enc(id)}`, signal);
      return;
    }
    await this.#http.post(
      `me/mailFolders/${enc(id)}/move`,
      { destinationId: "deleteditems" },
      signal ? { signal } : {},
    );
  }

  /** A new category with one of Outlook's colours. */
  async #createCategory(
    name: string,
    color: MailboxColor | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Mailbox> {
    const displayName = name.trim();
    if (!displayName)
      throw new MailError("provider", "A category needs a name.", {
        reason: "categoryNeedsName",
      });
    try {
      const created = await this.#http.post<GraphCategory>(
        "me/outlook/masterCategories",
        { displayName, color: presetOf(color) },
        { retry: false, ...(signal ? { signal } : {}) },
      );
      return toCategory(created, 0);
    } catch (error) {
      if (error instanceof MailError && error.status === 409)
        throw new MailError("provider", "That category exists already.", {
          cause: error,
          reason: "categoryExists",
          params: { name: displayName },
        });
      throw error;
    }
  }

  /** Changes a category's colour (the only thing Graph can change). */
  async #updateCategory(
    name: string,
    { name: newName, color, parentId }: MailboxChange,
    signal: AbortSignal | undefined,
  ): Promise<Mailbox> {
    if (newName !== undefined && newName !== name)
      throw new MailError("provider", "Outlook can’t rename categories.", {
        reason: "categoryRename",
      });
    if (parentId !== undefined && parentId !== null) throw notAFolder(parentId);
    const category = await this.#category(name, signal);
    const updated =
      color === undefined
        ? category
        : await this.#http.patch<GraphCategory>(
            `me/outlook/masterCategories/${enc(category.id)}`,
            { color: presetOf(color) },
            signal,
          );
    return toCategory(updated, undefined);
  }

  /** The category with a name. */
  async #category(
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<GraphCategory> {
    const { value = [] } = await this.#http.get<GraphPage<GraphCategory>>(
      "me/outlook/masterCategories",
      undefined,
      signal,
    );
    const found = value.find((category) => category.displayName === name);
    if (!found) throw notACategory(name);
    return found;
  }

  oneClickUnsubscribe(url: string, signal?: AbortSignal): Promise<void> {
    return sendOneClickUnsubscribe(url, this.#fetch, signal);
  }

  /** The account's own address; Graph can't list send-as aliases. */
  async listSenders(signal?: AbortSignal): Promise<readonly Sender[]> {
    const me = await this.#http.get<GraphUser>(
      "me",
      { $select: "displayName,mail,userPrincipalName" },
      signal,
    );
    const address = me.mail ?? me.userPrincipalName ?? "";
    const name = me.displayName?.trim();
    return [
      {
        address,
        ...(name ? { name } : {}),
        isDefault: true,
        signature: this.#signatures()[address.toLowerCase()] ?? "",
      },
    ];
  }

  /** Kept in this browser: Graph can't read or write Outlook's signatures. */
  updateSignature(address: string, html: string): Promise<void> {
    const key = this.#options.signatureKey;
    if (key !== undefined)
      writeJson(this.#options.settings, key, {
        ...this.#signatures(),
        [address.toLowerCase()]: html,
      });
    return Promise.resolve();
  }

  #signatures(): Readonly<Record<string, string>> {
    const key = this.#options.signatureKey;
    const stored =
      key === undefined ? undefined : readJson(this.#options.settings, key);
    if (typeof stored !== "object" || stored === null) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  /** Folder ids by well-known name, resolved once. */
  #wellKnownFolders(): Promise<WellKnownFolders> {
    this.#wellKnown ??= this.#http
      .batch<GraphMailFolder>(
        WELL_KNOWN_NAMES.map((name) => ({
          method: "GET",
          path: `me/mailFolders/${name}?$select=id`,
        })),
      )
      .then((results) => {
        const found = new Map<string, string>();
        for (const [index, result] of results.entries()) {
          const name = WELL_KNOWN_NAMES[index];
          if (name === undefined) continue;
          // A missing folder (e.g. no Archive yet) is fine; anything else isn't.
          if (result.ok) found.set(name, result.body.id);
          else if (result.error.code !== "not-found") throw result.error;
        }
        return found;
      })
      .catch((error: unknown) => {
        this.#wellKnown = undefined;
        throw error;
      });
    return this.#wellKnown;
  }

  /** Throws unless `id` is one of the user's own folders. */
  async #userFolder(id: MailboxId): Promise<WellKnownFolders> {
    if (isViewId(id)) throw notAFolder(id);
    const wellKnown = await this.#wellKnownFolders();
    if ([...wellKnown.values()].includes(id))
      throw new MailError("provider", "System folders can’t be changed.", {
        reason: "systemMailbox",
      });
    return wellKnown;
  }

  /** Keeps only what a view shows: no Deleted Items, Junk or internal folders (and for Flagged, flagged mail). */
  async #viewFilter(
    mailboxId: MailboxId,
  ): Promise<(message: MessageSummary) => boolean> {
    if (!isViewId(mailboxId)) return () => true;
    const wellKnown = await this.#wellKnownFolders();
    const hidden = new Set([
      ...internalIds(wellKnown),
      ...["deleteditems", "junkemail"].flatMap((name) => {
        const id = wellKnown.get(name);
        return id === undefined ? [] : [id];
      }),
    ]);
    const flaggedOnly = mailboxId === FLAGGED_VIEW_ID;
    // A category: only mail that has it (searches can't filter on the server).
    const category = categoryName(mailboxId) !== undefined;
    return (message) =>
      !message.mailboxIds.some((id) => hidden.has(id)) &&
      (!flaggedOnly || message.flags.flagged) &&
      (!category || message.mailboxIds.includes(mailboxId));
  }

  /** Every search match the mailbox shows (up to {@link MAX_SORTED_RESULTS}). */
  async #matches(
    mailboxId: MailboxId,
    text: string,
    keep: (message: MessageSummary) => boolean,
    signal: AbortSignal | undefined,
  ): Promise<MessageSummary[]> {
    return (
      await this.#all<GraphMessage>(
        isViewId(mailboxId)
          ? "me/messages"
          : `me/mailFolders/${enc(mailboxId)}/messages`,
        { $search: searchValue(text), $select: SUMMARY_SELECT, $top: 250 },
        signal,
        MAX_SORTED_RESULTS,
      )
    )
      .map(toMessageSummary)
      .filter(keep);
  }

  /**
   * Conversation ids of a mailbox (or of the search matches in it), sorted
   * by their newest message there: newest or oldest first.
   */
  async #conversationOrder(
    mailboxId: MailboxId,
    text: string | undefined,
    order: MessageOrder,
    keep: (message: MessageSummary) => boolean,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const messages = text
      ? await this.#matches(mailboxId, text, keep, signal)
      : (
          await this.#all<GraphMessage>(
            this.#listUrl(mailboxId, "oldest", ORDER_SELECT, 1000),
            {},
            signal,
            MAX_OLDEST_SCAN,
          )
        )
          .map(toMessageSummary)
          .filter(keep);
    const newest = new Map<string, string>();
    for (const message of messages) {
      const id = conversationOf(message);
      const known = newest.get(id);
      if (known === undefined || message.receivedAt > known)
        newest.set(id, message.receivedAt);
    }
    const sorted = [...newest].sort((a, b) => a[1].localeCompare(b[1]));
    if (order === "newest") sorted.reverse();
    return sorted.map(([id]) => id);
  }

  /**
   * One page of sorted results kept as a snapshot. Cursors are
   * `snapshot:<key>:<offset>`; a snapshot that's gone (e.g. after a reload)
   * is collected again and paging continues at the offset.
   */
  async #snapshotPage<T, R>(
    cursor: Cursor | undefined,
    limit: number,
    collect: () => Promise<readonly T[]>,
    load: (slice: readonly T[]) => Promise<readonly R[]>,
  ): Promise<Page<R>> {
    const [, oldKey = "", offsetText = "0"] = cursor?.startsWith("snapshot:")
      ? cursor.split(":")
      : [];
    let key = oldKey;
    let items = this.#snapshots.get(key) as readonly T[] | undefined;
    if (items === undefined) {
      items = await collect();
      key = String(this.#nextSnapshot++);
      this.#snapshots.set(key, items);
      for (const old of this.#snapshots.keys()) {
        if (this.#snapshots.size <= MAX_SNAPSHOTS) break;
        this.#snapshots.delete(old);
      }
    }
    const offset = Number(offsetText) || 0;
    const end = offset + limit;
    return {
      items: await load(items.slice(offset, end)),
      ...(end < items.length
        ? { nextCursor: asCursor(`snapshot:${key}:${String(end)}`) }
        : {}),
    };
  }

  /** The listing of a folder or view by date. */
  #listUrl(
    mailboxId: MailboxId,
    order: MessageOrder,
    select: string,
    top: number,
  ): URL {
    const filter = viewFilterOf(mailboxId);
    return this.#http.url(
      isViewId(mailboxId)
        ? "me/messages"
        : `me/mailFolders/${enc(mailboxId)}/messages`,
      {
        $select: select,
        $top: top,
        $orderby: `receivedDateTime ${order === "oldest" ? "asc" : "desc"}`,
        // Graph wants the $orderby property in $filter too, and first.
        ...(filter === undefined
          ? {}
          : {
              $filter: `receivedDateTime ge 1900-01-01T00:00:00Z and ${filter}`,
            }),
      },
    );
  }

  /**
   * Conversations with all their messages (every folder), as summaries,
   * oldest first; batched. `known` messages complete them (a message without
   * a conversation id is a conversation of its own).
   */
  async #threadSummaries(
    ids: readonly string[],
    signal: AbortSignal | undefined,
    known: readonly MessageSummary[] = [],
  ): Promise<Map<string, ThreadSummary>> {
    const results = await this.#http.batch<GraphPage<GraphMessage>>(
      ids.map((id) => ({
        method: "GET",
        path: `me/messages?${new URLSearchParams({
          $filter: conversationFilter(id),
          $select: SUMMARY_SELECT,
          $top: String(MAX_THREAD_MESSAGES),
        }).toString()}`,
      })),
      signal,
    );
    const threads = new Map<string, ThreadSummary>();
    for (const [index, id] of ids.entries()) {
      const result = results[index];
      if (result && !result.ok) throw result.error;
      const messages = new Map<string, MessageSummary>();
      for (const message of known)
        if (conversationOf(message) === id) messages.set(message.id, message);
      for (const message of result?.body.value ?? [])
        messages.set(message.id, toMessageSummary(message));
      if (messages.size === 0) continue;
      threads.set(id, {
        id: asThreadId(id),
        messages: [...messages.values()].sort((a, b) =>
          a.receivedAt.localeCompare(b.receivedAt),
        ),
      });
    }
    return threads;
  }

  /** Every item of a collection, following `@odata.nextLink` (up to `max`). */
  async #all<T>(
    path: string | URL,
    params: QueryParams,
    signal: AbortSignal | undefined,
    max = Infinity,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = await this.#http.get<GraphPage<T>>(path, params, signal);
    for (;;) {
      items.push(...(page.value ?? []));
      const next = page["@odata.nextLink"];
      if (next === undefined || items.length >= max) return items;
      page = await this.#http.get<GraphPage<T>>(
        new URL(next),
        undefined,
        signal,
      );
    }
  }

  async #fetchMessage(
    id: MessageId,
    signal: AbortSignal | undefined,
  ): Promise<{
    message: GraphMessage;
    attachments: readonly GraphAttachment[];
  }> {
    const [message, attachments] = await Promise.all([
      this.#http.get<GraphMessage>(
        `me/messages/${enc(id)}`,
        { $select: MESSAGE_SELECT },
        signal,
      ),
      this.#all<GraphAttachment>(
        `me/messages/${enc(id)}/attachments`,
        { $select: ATTACHMENT_SELECT },
        signal,
      ),
    ]);
    return { message, attachments };
  }

  /** Moves messages (batched); the ids stay the same. */
  async #moveAll(
    ids: readonly MessageId[],
    destinationId: string,
    signal: AbortSignal | undefined,
  ): Promise<MutationResult> {
    const results = await this.#http.batch(
      ids.map((id) => ({
        method: "POST",
        path: `me/messages/${enc(id)}/move`,
        body: { destinationId },
      })),
      signal,
    );
    const failed = results.find(
      (result): result is Extract<BatchResult<unknown>, { ok: false }> =>
        !result.ok,
    );
    if (failed) {
      if (destinationId === "archive" && failed.error.code === "not-found")
        throw new MailError("provider", "This mailbox has no Archive folder.", {
          cause: failed.error,
          reason: "noArchiveFolder",
        });
      throw failed.error;
    }
    return {};
  }

  /**
   * Creates a draft. A reply starts from Outlook's `createReply` on the
   * original (found by its Message-ID), so the conversation and threading
   * headers are right; its content is then replaced.
   */
  async #createDraft(
    draft: DraftInput,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const options = { retry: false, ...(signal ? { signal } : {}) };
    const inReplyTo = draft.threading?.inReplyTo;
    const original =
      inReplyTo === undefined
        ? undefined
        : await this.#findByMessageId(inReplyTo, signal);
    if (original === undefined) {
      const created = await this.#http.post<GraphMessage>(
        "me/messages",
        draftFields(draft),
        options,
      );
      return created.id;
    }
    const reply = await this.#http.post<GraphMessage>(
      `me/messages/${enc(original)}/createReply`,
      undefined,
      options,
    );
    await this.#http.patch(
      `me/messages/${enc(reply.id)}`,
      draftFields(draft),
      signal,
    );
    return reply.id;
  }

  async #findByMessageId(
    internetMessageId: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const page = await this.#http.get<GraphPage<GraphMessage>>(
      "me/messages",
      {
        $filter: `internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`,
        $select: "id",
        $top: 1,
      },
      signal,
    );
    return page.value?.[0]?.id;
  }

  /**
   * Makes the draft's attachments match `wanted`: removes the others and
   * uploads what isn't there yet (files this provider uploaded before, and
   * the draft's own parts, aren't uploaded again).
   */
  async #syncAttachments(
    draftId: string,
    wanted: readonly OutgoingAttachment[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const path = `me/messages/${enc(draftId)}/attachments`;
    const onServer = await this.#all<GraphAttachment>(
      path,
      { $select: "id,name,size" },
      signal,
    );
    const serverIds = new Set(onServer.map((attachment) => attachment.id));
    const uploaded = this.#uploaded.get(draftId) ?? new Map<string, string>();
    this.#uploaded.set(draftId, uploaded);

    const keep = new Set<string>();
    const missing: OutgoingAttachment[] = [];
    for (const part of wanted) {
      const existing =
        part.source?.messageId === draftId
          ? part.source.attachmentId
          : uploaded.get(part.id);
      if (existing !== undefined && serverIds.has(existing)) keep.add(existing);
      else missing.push(part);
    }

    bodiesOrThrow(
      await this.#http.batch(
        onServer
          .filter((attachment) => !keep.has(attachment.id))
          .map((attachment) => ({
            method: "DELETE",
            path: `${path}/${enc(attachment.id)}`,
          })),
        signal,
      ),
    );
    for (const part of missing) {
      const id = await this.#upload(draftId, part, signal);
      if (id !== undefined) uploaded.set(part.id, id);
    }

    // Upload sessions don't say the new attachment's id: match by name.
    const unmatched = missing.filter((part) => !uploaded.has(part.id));
    if (unmatched.length === 0) return;
    const known = new Set([...keep, ...uploaded.values()]);
    const now = await this.#all<GraphAttachment>(
      path,
      { $select: "id,name,size" },
      signal,
    );
    for (const part of unmatched) {
      const match = now.find(
        (attachment) =>
          !known.has(attachment.id) && attachment.name === part.filename,
      );
      if (match) {
        uploaded.set(part.id, match.id);
        known.add(match.id);
      }
    }
  }

  /** Uploads one file; resolves to its attachment id when Graph says it. */
  async #upload(
    draftId: string,
    part: OutgoingAttachment,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const blob = await this.#bytesOf(part, signal);
    const options = { retry: false, ...(signal ? { signal } : {}) };
    const inline =
      part.contentId === undefined ? {} : { contentId: part.contentId };
    const path = `me/messages/${enc(draftId)}/attachments`;
    if (blob.size <= SMALL_ATTACHMENT_BYTES) {
      const created = await this.#http.post<GraphAttachment>(
        path,
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: part.filename,
          contentType: part.mimeType,
          contentBytes: encodeBase64(new Uint8Array(await blob.arrayBuffer())),
          isInline: part.contentId !== undefined,
          ...inline,
        },
        options,
      );
      return created.id;
    }
    const session = await this.#http.post<GraphUploadSession>(
      `${path}/createUploadSession`,
      {
        AttachmentItem: {
          attachmentType: "file",
          name: part.filename,
          size: blob.size,
          contentType: part.mimeType,
          isInline: part.contentId !== undefined,
          ...inline,
        },
      },
      options,
    );
    for (let start = 0; start < blob.size; start += UPLOAD_CHUNK_BYTES) {
      try {
        await this.#http.putChunk(
          session.uploadUrl,
          blob.slice(start, start + UPLOAD_CHUNK_BYTES),
          { start, total: blob.size },
          signal,
        );
      } catch (error) {
        // The browser may not be allowed to reach Outlook's upload server.
        if (isMailError(error, "network"))
          throw new MailError(
            "provider",
            `“${part.filename}” couldn’t be uploaded from the browser.`,
            {
              cause: error,
              reason: "attachmentUploadBlocked",
              params: { name: part.filename },
            },
          );
        throw error;
      }
    }
    return undefined;
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

  /** A fresh token: a delta link per folder, no changes; `reset` asks callers to reload. */
  async #startOver(
    signal: AbortSignal | undefined,
    reset: boolean,
  ): Promise<ChangeSet> {
    const since = new Date(this.#now()).toISOString();
    const folders: Record<string, string> = {};
    const ids = folderIdsOf(await this.listMailboxes(signal));
    await Promise.all(
      ids.map(async (id) => {
        folders[id] = await this.#startFolder(id, signal);
      }),
    );
    const tree = await this.#roundLink(
      this.#http.url("me/mailFolders/delta", { $select: "id" }),
      signal,
    );
    return {
      token: stateToken({ since, folders, tree }),
      reset,
      changes: [],
    };
  }

  /** A delta link for a folder: changes of mail received in the last {@link DELTA_WINDOW_DAYS} days. */
  #startFolder(id: string, signal: AbortSignal | undefined): Promise<string> {
    const from = new Date(
      this.#now() - DELTA_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    return this.#roundLink(
      this.#http.url(`me/mailFolders/${enc(id)}/messages/delta`, {
        $select: "id",
        $filter: `receivedDateTime ge ${from}`,
      }),
      signal,
    );
  }

  /** Runs a whole delta round and returns its delta link. */
  async #roundLink(url: URL, signal: AbortSignal | undefined): Promise<string> {
    const first = await this.#http.get<GraphPage<GraphMessage>>(
      url,
      undefined,
      signal,
      "odata.maxpagesize=200",
    );
    return (await this.#finishRound(first, signal)).link;
  }

  /** Follows a delta round's next links; returns its entries and the new delta link. */
  async #finishRound(
    first: GraphPage<GraphMessage>,
    signal: AbortSignal | undefined,
  ): Promise<{ values: GraphMessage[]; link: string }> {
    const values = [...(first.value ?? [])];
    let page = first;
    for (;;) {
      const done = page["@odata.deltaLink"];
      if (done !== undefined) return { values, link: done };
      const next = page["@odata.nextLink"];
      if (next === undefined)
        throw new MailError("provider", "Outlook: a change list ended early.");
      page = await this.#http.get<GraphPage<GraphMessage>>(
        new URL(next),
        undefined,
        signal,
        "odata.maxpagesize=200",
      );
      values.push(...(page.value ?? []));
    }
  }
}

/** The conversation a message belongs to (its own id if it has none). */
function conversationOf(message: MessageSummary): string {
  return message.threadId ?? message.id;
}

/** `$filter` for the messages of a conversation. */
function conversationFilter(id: string): string {
  return `conversationId eq '${id.replace(/'/g, "''")}'`;
}

function notACategory(name: string): MailError {
  return new MailError("provider", `“${name}” is not a category.`, {
    reason: "notACategory",
    params: { name },
  });
}

/** What Graph filters a view's listing by (none for All mail). */
function viewFilterOf(mailboxId: MailboxId): string | undefined {
  if (mailboxId === FLAGGED_VIEW_ID) return "flag/flagStatus eq 'flagged'";
  const category = categoryName(mailboxId);
  return category === undefined ? undefined : categoryFilter(category);
}

/** The OData filter for mail with a category. */
function categoryFilter(name: string): string {
  return `categories/any(c:c eq '${name.replace(/'/g, "''")}')`;
}

function notAFolder(id: string): MailError {
  return new MailError("provider", `“${id}” is not a folder.`, {
    reason: "notAFolder",
    params: { name: id },
  });
}

/** A clear message when Outlook refuses a folder name. */
function folderNameError(error: unknown, name: string): unknown {
  const code = graphErrorCode(error);
  if (
    isMailError(error) &&
    (error.status === 409 || code === "ErrorFolderExists")
  )
    return new MailError(
      "provider",
      `There’s already a folder called “${name}” here.`,
      {
        status: error.status ?? 409,
        cause: error,
        reason: "folderExists",
        params: { name },
      },
    );
  return error;
}

/** A Graph link as a path below {@link GRAPH_BASE} (for `$batch`). */
function relativePath(link: string): string {
  if (!link.startsWith(GRAPH_BASE))
    throw new MailError("provider", "Outlook: unexpected change link.");
  return link.slice(GRAPH_BASE.length);
}

function stateToken(state: DeltaState): SyncToken {
  return asSyncToken(JSON.stringify(state));
}

function parseState(token: SyncToken): DeltaState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(token);
  } catch {
    return undefined; // Not one of ours: start over.
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { since, tree, folders } = value as Record<string, unknown>;
  if (
    typeof since !== "string" ||
    typeof tree !== "string" ||
    typeof folders !== "object" ||
    folders === null
  )
    return undefined;
  const entries = Object.entries(folders);
  if (
    !entries.every(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
  )
    return undefined;
  return { since, tree, folders: Object.fromEntries(entries) };
}
