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
  asMailboxId,
  asDraftId,
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
  Mailbox,
  MailboxColor,
  Message,
  Sender,
  Thread,
  ThreadSummary,
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
  CalendarMail,
} from "../../core/provider";
import { decodeBase64Url } from "../../lib/base64url";
import { parseAddressList } from "./addresses";
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
  BACK_LABEL,
  BACK_VIEW,
  BACK_VIEW_ID,
  SCHEDULED_ID,
  SNOOZED_LABEL,
  snoozeLabelName,
  snoozeTimeOf,
  SYNTHETIC_PREFIX,
  toUserMailbox,
} from "./labels";
import { SUMMARY_HEADERS, toMessage, toMessageSummary } from "./mappers";
import { formatSendAtMarker, type Schedule } from "../../core/schedule";
import { getHeader } from "./mime";
import type {
  GmailListSendAsResponse,
  GmailListThreadsResponse,
  GmailThread,
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
const VIEW_IDS: ReadonlySet<string> = new Set([
  ALL_MAIL_ID,
  "STARRED",
  SCHEDULED_ID,
  BACK_VIEW_ID,
]);

/** User labels' ids (Gmail's own are names like `INBOX`). */
const isUserLabel = (id: string) => id.startsWith("Label_");

/** action0's snooze labels among `labels`. */
function snoozeLabelsOf(labels: readonly GmailLabel[]): SnoozeLabels {
  const times = new Map<string, string>();
  let snoozed: string | undefined;
  let back: string | undefined;
  for (const label of labels) {
    if (label.name === SNOOZED_LABEL) snoozed = label.id;
    else if (label.name === BACK_LABEL) back = label.id;
    else {
      const time = snoozeTimeOf(label.name);
      if (time !== undefined) times.set(label.id, time);
    }
  }
  return {
    times,
    ...(snoozed === undefined ? {} : { snoozed }),
    ...(back === undefined ? {} : { back }),
  };
}

/** action0's snooze labels, by id (see `SNOOZED_LABEL`). */
interface SnoozeLabels {
  readonly snoozed?: string;
  readonly back?: string;
  /** Return time (ISO) of each time label. */
  readonly times: ReadonlyMap<string, string>;
}

/** An error if any id is one we invented for the tree (Gmail doesn't know them). */
function inventedIdError(ids: readonly MailboxId[]): MailError | undefined {
  const invented = ids.find(
    (id) =>
      id === ALL_MAIL_ID ||
      id === CATEGORIES_ID ||
      id === SCHEDULED_ID ||
      id === BACK_VIEW_ID ||
      id.startsWith("synthetic:"),
  );
  return invented === undefined
    ? undefined
    : new MailError("provider", `"${invented}" is not a Gmail label.`, {
        reason: "notALabel",
        params: { name: invented },
      });
}

/** A clear message for Gmail's answers to an unusable label name. */
function labelNameError(error: unknown, path: string): unknown {
  if (!isMailError(error)) return error;
  if (error.status === 409)
    return new MailError(
      "provider",
      `There’s already a label called “${path}”.`,
      {
        status: 409,
        cause: error,
        reason: "labelExists",
        params: { name: path },
      },
    );
  if (error.status === 400 && /label name/i.test(error.message))
    return new MailError(
      "provider",
      `Gmail doesn’t allow the label name “${path}”.`,
      {
        status: 400,
        cause: error,
        reason: "labelNotAllowed",
        params: { name: path },
      },
    );
  return error;
}

/** A leaf name for a label: trimmed, not empty, no "/" (Gmail nests on it). */
function checkedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "")
    throw new MailError("provider", "A label needs a name.", {
      reason: "labelNeedsName",
    });
  if (trimmed.includes("/"))
    throw new MailError("provider", "Label names can’t contain “/”.", {
      reason: "labelNoSlash",
    });
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
    {
      status: 403,
      cause: error,
      reason: disabled ? "peopleApiDisabled" : "contactsDeclined",
    },
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

/** What `#listAllIds` lists. */
type ListedKind = "messages" | "threads";

/** Messages (or summaries) by date, oldest first. */
function oldestFirst<T extends { readonly receivedAt: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/** More changes than this at once: callers reload instead. */
const MAX_CHANGES = 100;

/** Oldest-first id lists kept for paging (each holds ids only). */
const MAX_SNAPSHOTS = 5;

/** Drafts the Scheduled view looks through at most. */
const MAX_DRAFTS_SCANNED = 2000;

/** One page of a list held in full, by offset (the cursor). */
function pageOf<T>(
  all: readonly T[],
  cursor: Cursor | undefined,
  limit: number,
): Page<T> {
  const offset = cursor ? Number(cursor) : 0;
  const next = offset + limit;
  return {
    items: all.slice(offset, next),
    ...(next < all.length ? { nextCursor: asCursor(String(next)) } : {}),
  };
}

/** `messages.batchModify` accepts at most this many ids per call. */
export const BATCH_MODIFY_LIMIT = 1000;

/** Label changes of one `batchModify` call. */
interface LabelChange {
  readonly addLabelIds?: readonly string[];
  readonly removeLabelIds?: readonly string[];
}

/** {@link MailProvider} for Gmail, using the REST API (full `https://mail.google.com/` scope, which deleting forever needs). */
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
    mailboxEditing: {
      label: {
        rename: true,
        colors: GMAIL_LABEL_COLORS,
        nest: true,
        hide: true,
      },
    },
    threads: true,
    senders: true,
    // Gmail lists its own send-as addresses.
    editSenders: false,
    rawSource: true,
    calendarMail: true,
    signatureStore: "provider",
    // Gmail's API can't schedule: drafts wait with a marker until action0 sends them.
    scheduling: "drafts",
    // Nor snooze: action0's labels do (see `SNOOZED_LABEL`).
    snooze: true,
  };
  readonly #http: GmailHttp;
  readonly #people: GmailHttp | undefined;
  readonly #fetch: typeof fetch;
  /** Google asks for one empty search before real ones ("warm-up"). */
  #peopleWarmUp: Promise<unknown> | undefined;
  /** Id lists of oldest-first listings, by cursor key (see `#listOldest`). */
  readonly #snapshots = new Map<
    string,
    { readonly filterKey: string; readonly ids: readonly string[] }
  >();
  /**
   * Drafts' scheduled rows by message id (`null`: not scheduled), so the
   * Scheduled view reads each draft's headers once. Ids only change.
   */
  readonly #markers = new Map<string, MessageSummary | null>();
  /** action0's snooze labels (loaded when needed; they're made here or on another device). */
  #snoozeLabels: Promise<SnoozeLabels> | undefined;

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
    // Snooze's labels come with it.
    this.#snoozeLabels = Promise.resolve(snoozeLabelsOf(labels));
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
    return [...mapLabels(detailed), BACK_VIEW];
  }

  async listMessages(
    { mailboxId, search, order = "newest", cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<MessageSummary>> {
    if (mailboxId === SCHEDULED_ID)
      return pageOf(await this.#scheduled(search, signal), cursor, limit);
    if (mailboxId === BACK_VIEW_ID) {
      const { back } = await this.#loadSnoozeLabels(signal);
      if (back === undefined) return { items: [] };
      const list = await this.#http.get<GmailListMessagesResponse>(
        "messages",
        { labelIds: ["INBOX", back], maxResults: limit, pageToken: cursor },
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
    if (
      isUserLabel(mailboxId) &&
      mailboxId === (await this.#loadSnoozeLabels(signal)).snoozed
    )
      return pageOf(await this.#snoozedMessages(search, signal), cursor, limit);
    const filter = listFilter(mailboxId, search);
    if (order === "oldest")
      return this.#listOldest(
        "messages",
        filter,
        cursor,
        limit,
        (ids) => this.#summaries(ids, signal),
        signal,
      );

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

  async listThreads(
    { mailboxId, search, order = "newest", cursor, limit }: ListMessagesQuery,
    signal?: AbortSignal,
  ): Promise<Page<ThreadSummary>> {
    if (mailboxId === SCHEDULED_ID)
      // One row per scheduled mail, like Drafts.
      return pageOf(
        (await this.#scheduled(search, signal)).map((message) => ({
          id: message.threadId ?? asThreadId(message.id),
          messages: [message],
        })),
        cursor,
        limit,
      );
    const filter = listFilter(mailboxId, search);
    const load = (ids: readonly string[]) => this.#threadSummaries(ids, signal);
    if (order === "oldest")
      return this.#listOldest("threads", filter, cursor, limit, load, signal);
    const list = await this.#http.get<GmailListThreadsResponse>(
      "threads",
      { ...filter, maxResults: limit, pageToken: cursor },
      signal,
    );
    return {
      items: await load((list.threads ?? []).map(({ id }) => id)),
      ...(list.nextPageToken
        ? { nextCursor: asCursor(list.nextPageToken) }
        : {}),
    };
  }

  async getThread(id: ThreadId, signal?: AbortSignal): Promise<Thread> {
    const thread = await this.#http.get<GmailThread>(
      `threads/${encodeURIComponent(id)}`,
      { format: "full" },
      signal,
    );
    const messages = await Promise.all(
      (thread.messages ?? []).map(async (message) => {
        if (message.payload)
          await this.#hydrateLargeTextParts(
            asMessageId(message.id),
            message.payload,
            signal,
          );
        return toMessage(message);
      }),
    );
    return {
      id: asThreadId(thread.id),
      messages: oldestFirst(await this.#withSnooze(messages, signal)),
    };
  }

  async saveDraft(
    draft: DraftInput,
    signal?: AbortSignal,
  ): Promise<{ readonly id: DraftId; readonly messageId: MessageId }> {
    const raw = await this.#raw(draft, signal, undefined, draft.schedule);
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
    const [from] = parseAddressList(getHeader(raw.payload?.headers, "From"));
    return {
      id: asDraftId(draft.id),
      messageId: message.id,
      ...(message.sendAt
        ? {
            schedule: {
              sendAt: new Date(message.sendAt),
              by: message.scheduledBy ?? "",
            },
          }
        : {}),
      ...(from ? { from } : {}),
      ...(message.replyTo.length ? { replyTo: message.replyTo } : {}),
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

  /** Saves the draft with the marker: action0 sends it when it's due. */
  async scheduleDraft(
    draft: DraftInput & { readonly id: DraftId },
    schedule: Schedule,
    signal?: AbortSignal,
  ): Promise<{ readonly messageId: MessageId }> {
    const { messageId } = await this.saveDraft({ ...draft, schedule }, signal);
    return { messageId };
  }

  /** Saves the draft again without the marker. */
  async unscheduleDraft(
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<{ readonly id: DraftId; readonly messageId: MessageId }> {
    const id = await this.draftIdOf(messageId, signal);
    if (id === undefined)
      throw new MailError("not-found", "This draft no longer exists.", {
        reason: "draftGone",
      });
    const { schedule: _schedule, ...draft } = await this.getDraft(id, signal);
    return this.saveDraft(draft, signal);
  }

  /**
   * The drafts marked with a send time, soonest first. Gmail can't search
   * for the marker, so this lists every draft and reads the headers of
   * those it hasn't seen yet (a message's headers never change: a saved
   * draft is a new message).
   */
  async #scheduled(
    search: string | undefined,
    signal?: AbortSignal,
  ): Promise<MessageSummary[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page: GmailListMessagesResponse = await this.#http.get(
        "messages",
        {
          labelIds: ["DRAFT"],
          maxResults: 500,
          pageToken,
          q: search?.trim() || undefined,
        },
        signal,
      );
      ids.push(...(page.messages ?? []).map(({ id }) => id));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined && ids.length < MAX_DRAFTS_SCANNED);
    const unknown = ids.filter((id) => !this.#markers.has(id));
    for (const summary of await this.#summaries(unknown, signal))
      this.#markers.set(summary.id, summary.sendAt ? summary : null);
    // Forget drafts that are gone (sent, deleted or saved again).
    const listed = new Set(ids);
    if (!search?.trim())
      for (const id of this.#markers.keys())
        if (!listed.has(id)) this.#markers.delete(id);
    return ids
      .flatMap((id) => this.#markers.get(id) ?? [])
      .sort((a, b) => (a.sendAt ?? "").localeCompare(b.sendAt ?? ""));
  }

  /**
   * Into action0's Snoozed label with a label for the return time (made
   * if needed), out of the Inbox; a snoozed message's old time label goes.
   */
  async snooze(
    ids: readonly MessageId[],
    until: Date,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const snoozed = await this.#snoozeLabel(SNOOZED_LABEL, signal);
    const time = await this.#snoozeLabel(snoozeLabelName(until), signal);
    const labels = await this.#loadSnoozeLabels(signal);
    const old = [...labels.times.keys()].filter((id) => id !== time);
    await this.#modify(
      ids,
      {
        addLabelIds: [snoozed, time],
        removeLabelIds: [
          "INBOX",
          ...old,
          ...(labels.back === undefined ? [] : [labels.back]),
        ],
      },
      signal,
    );
    await this.#dropEmptyTimeLabels(old, signal);
    return {};
  }

  /** Out of the Snoozed label (and its time label) into `to`; `back`: unread and marked. */
  async unsnooze(
    ids: readonly MessageId[],
    { to, back }: { readonly to: MailboxId | null; readonly back: boolean },
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const backLabel = back
      ? await this.#snoozeLabel(BACK_LABEL, signal)
      : undefined;
    const labels = await this.#loadSnoozeLabels(signal);
    const times = [...labels.times.keys()];
    await this.#modify(
      ids,
      {
        addLabelIds: [
          ...(to === null ? [] : [to]),
          ...(backLabel === undefined ? [] : [backLabel, "UNREAD"]),
        ],
        removeLabelIds: [
          ...(labels.snoozed === undefined ? [] : [labels.snoozed]),
          ...times,
        ],
      },
      signal,
    );
    await this.#dropEmptyTimeLabels(times, signal);
    return {};
  }

  async clearBackFromSnooze(
    ids: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const { back } = await this.#loadSnoozeLabels(signal);
    return back === undefined
      ? {}
      : this.#modify(ids, { removeLabelIds: [back] }, signal);
  }

  /** action0's snooze labels, loaded once (`fresh`: again). */
  #loadSnoozeLabels(
    signal?: AbortSignal,
    fresh = false,
  ): Promise<SnoozeLabels> {
    if (fresh || this.#snoozeLabels === undefined) {
      const loading = this.#http
        .get<GmailListLabelsResponse>("labels", undefined, signal)
        .then(({ labels = [] }) => snoozeLabelsOf(labels));
      // A failed load is tried again next time.
      loading.catch(() => {
        if (this.#snoozeLabels === loading) this.#snoozeLabels = undefined;
      });
      this.#snoozeLabels = loading;
    }
    return this.#snoozeLabels;
  }

  /** The id of a snooze label, made if it doesn't exist (hidden unless it's Snoozed itself). */
  async #snoozeLabel(name: string, signal?: AbortSignal): Promise<string> {
    const find = (labels: SnoozeLabels) =>
      name === SNOOZED_LABEL
        ? labels.snoozed
        : name === BACK_LABEL
          ? labels.back
          : [...labels.times].find(
              ([, time]) => time === snoozeTimeOf(name),
            )?.[0];
    const known = find(await this.#loadSnoozeLabels(signal));
    if (known !== undefined) return known;
    const shown = name === SNOOZED_LABEL;
    try {
      const label = await this.#http.post<GmailLabel>(
        "labels",
        {
          name,
          labelListVisibility: shown ? "labelShow" : "labelHide",
          messageListVisibility: shown ? "show" : "hide",
        },
        signal,
      );
      await this.#loadSnoozeLabels(signal, true);
      return label.id;
    } catch (error) {
      // Made meanwhile (another device): use that one.
      const made = find(await this.#loadSnoozeLabels(signal, true));
      if (made !== undefined) return made;
      throw error;
    }
  }

  /** Deletes time labels no message has any more (best effort). */
  async #dropEmptyTimeLabels(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    let dropped = false;
    for (const id of ids) {
      try {
        const label = await this.#http.get<GmailLabel>(
          `labels/${encodeURIComponent(id)}`,
          undefined,
          signal,
        );
        if ((label.messagesTotal ?? 0) > 0) continue;
        await this.#http.delete(`labels/${encodeURIComponent(id)}`, signal);
        dropped = true;
      } catch {
        // Another try with the next change.
      }
    }
    if (dropped)
      await this.#loadSnoozeLabels(signal, true).catch(() => undefined);
  }

  /**
   * Summaries with their snooze time and Back mark, from their labels
   * (which then leave `mailboxIds`: they aren't mailboxes). A snoozed
   * message whose time label is unknown (made on another device) loads the
   * labels again.
   */
  async #withSnooze<T extends MessageSummary>(
    summaries: readonly T[],
    signal?: AbortSignal,
  ): Promise<T[]> {
    // Snooze's labels are user labels: without any, nothing to look up.
    if (!summaries.some((summary) => summary.mailboxIds.some(isUserLabel)))
      return [...summaries];
    let labels = await this.#loadSnoozeLabels(signal);
    const unknownTime = (summary: T) =>
      labels.snoozed !== undefined &&
      summary.mailboxIds.includes(asMailboxId(labels.snoozed)) &&
      !summary.mailboxIds.some((id) => labels.times.has(id));
    if (summaries.some(unknownTime))
      labels = await this.#loadSnoozeLabels(signal, true);
    return summaries.map((summary) => {
      const time = summary.mailboxIds
        .map((id) => labels.times.get(id))
        .find((found) => found !== undefined);
      const back =
        labels.back !== undefined &&
        summary.mailboxIds.includes(asMailboxId(labels.back));
      if (time === undefined && !back) return summary;
      return {
        ...summary,
        mailboxIds: summary.mailboxIds.filter(
          (id) => !labels.times.has(id) && id !== labels.back,
        ),
        ...(time !== undefined &&
        labels.snoozed !== undefined &&
        summary.mailboxIds.includes(asMailboxId(labels.snoozed))
          ? { snoozedUntil: time }
          : {}),
        ...(back ? { backFromSnooze: true as const } : {}),
      };
    });
  }

  /** The messages in the Snoozed label, back soonest first. */
  async #snoozedMessages(
    search: string | undefined,
    signal?: AbortSignal,
  ): Promise<MessageSummary[]> {
    const { snoozed } = await this.#loadSnoozeLabels(signal);
    if (snoozed === undefined) return [];
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page: GmailListMessagesResponse = await this.#http.get(
        "messages",
        {
          labelIds: [snoozed],
          maxResults: 500,
          pageToken,
          q: search?.trim() || undefined,
        },
        signal,
      );
      ids.push(...(page.messages ?? []).map(({ id }) => id));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined && ids.length < MAX_DRAFTS_SCANNED);
    return (await this.#summaries(ids, signal)).sort((a, b) =>
      (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""),
    );
  }

  /** Sent as it is; Gmail keeps the copy in Sent. */
  async sendCalendarMail(
    mail: CalendarMail,
    signal?: AbortSignal,
  ): Promise<void> {
    const raw = buildMessage({
      ...mail,
      cc: [],
      bcc: [],
      date: new Date(),
    });
    await this.#http.upload<GmailMessage>("POST", "messages/send", {}, raw, {
      retry: false,
      signal,
    });
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
      throw new MailError("provider", "A label can’t go inside itself.", {
        reason: "labelInsideItself",
      });
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

  /** Verified send-as addresses (the primary one always), the default first. */
  async listSenders(signal?: AbortSignal): Promise<readonly Sender[]> {
    const { sendAs = [] } = await this.#http.get<GmailListSendAsResponse>(
      "settings/sendAs",
      undefined,
      signal,
    );
    return sendAs
      .filter(
        (entry) =>
          entry.isPrimary === true || entry.verificationStatus === "accepted",
      )
      .map((entry): Sender => ({
        address: entry.sendAsEmail,
        ...(entry.displayName ? { name: entry.displayName } : {}),
        isDefault: entry.isDefault === true,
        signature: entry.signature ?? "",
      }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  /** Send-as addresses are managed in Gmail's settings. */
  saveSenders(): Promise<void> {
    return Promise.reject(
      new MailError("unavailable", "Gmail manages its own addresses."),
    );
  }

  catchAllDomains(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }

  /** Needs the `gmail.settings.basic` permission; without it: `unavailable`. */
  async updateSignature(
    address: string,
    html: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.#http.patch(
        `settings/sendAs/${encodeURIComponent(address)}`,
        { signature: html },
        signal,
      );
    } catch (error) {
      if (isMailError(error) && error.status === 403)
        throw new MailError(
          "unavailable",
          "Changing Gmail settings wasn’t allowed for this account.",
          { status: 403, cause: error, reason: "settingsNotAllowed" },
        );
      throw error;
    }
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
      throw new MailError("provider", "System labels can’t be changed.", {
        reason: "systemMailbox",
      });
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

  /** The raw message for a draft, with the bytes of its attachments. */
  async #raw(
    draft: DraftInput,
    signal?: AbortSignal,
    date?: Date,
    schedule?: Schedule,
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
    // Without a From header Gmail uses the account's default address.
    return buildMessage({
      ...(draft.from ? { from: draft.from } : {}),
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
      ...(date ? { date } : {}),
      ...(schedule ? { sendAtMarker: formatSendAtMarker(schedule) } : {}),
    });
  }

  /**
   * Oldest first. Gmail only lists newest first, so this lists every matching
   * id (500 per request, ids only), reverses them and pages through that
   * snapshot, loading the items of one page with `load`. Cursors are
   * `<snapshot>:<offset>`. The last few snapshots stay in memory; one that's
   * gone (e.g. after a reload) is listed again.
   */
  async #listOldest<T>(
    kind: ListedKind,
    filter: ListFilter,
    cursor: Cursor | undefined,
    limit: number,
    load: (ids: readonly string[]) => Promise<T[]>,
    signal?: AbortSignal,
  ): Promise<Page<T>> {
    const filterKey = JSON.stringify([kind, filter]);
    const [cursorKey = "", cursorOffset = "0"] = cursor?.split(":") ?? [];
    const offset = Number(cursorOffset) || 0;
    const snapshot = this.#snapshots.get(cursorKey);
    let key = cursorKey;
    let ids = snapshot?.filterKey === filterKey ? snapshot.ids : undefined;
    if (!ids) {
      ids = (await this.#listAllIds(filter, signal, kind)).reverse();
      key = crypto.randomUUID();
      this.#snapshots.set(key, { filterKey, ids });
      for (const old of this.#snapshots.keys()) {
        if (this.#snapshots.size <= MAX_SNAPSHOTS) break;
        this.#snapshots.delete(old);
      }
    }
    const next = offset + limit;
    return {
      items: await load(ids.slice(offset, next)),
      ...(next < ids.length ? { nextCursor: asCursor(`${key}:${next}`) } : {}),
    };
  }

  /** Every message (or thread) id that `filter` selects, newest first. */
  async #listAllIds(
    filter: ListFilter,
    signal?: AbortSignal,
    kind: ListedKind = "messages",
  ): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#http.get<
        GmailListMessagesResponse & GmailListThreadsResponse
      >(kind, { ...filter, maxResults: 500, pageToken }, signal);
      ids.push(...(page[kind] ?? []).map(({ id }) => id));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return ids;
  }

  /** Conversations with all their messages (summaries, oldest first). */
  async #threadSummaries(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<ThreadSummary[]> {
    const threads = await Promise.all(
      ids.map((id) =>
        this.#http
          .get<GmailThread>(
            `threads/${encodeURIComponent(id)}`,
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
    return Promise.all(
      threads
        .filter((thread): thread is GmailThread => thread !== undefined)
        .map(async (thread) => ({
          id: asThreadId(thread.id),
          messages: oldestFirst(
            await this.#withSnooze(
              (thread.messages ?? []).map(toMessageSummary),
              signal,
            ),
          ),
        })),
    );
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
    return this.#withSnooze(
      messages
        .filter((message): message is GmailMessage => message !== undefined)
        .map(toMessageSummary),
      signal,
    );
  }

  async getMessage(id: MessageId, signal?: AbortSignal): Promise<Message> {
    const message = await this.#fetchFull(id, signal);
    if (message.payload)
      await this.#hydrateLargeTextParts(id, message.payload, signal);
    const [full] = await this.#withSnooze([toMessage(message)], signal);
    return full ?? toMessage(message);
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

  /** `format=raw`: the message as Gmail stores it, base64url. */
  async getRawMessage(
    id: MessageId,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const message = await this.#http.get<GmailMessage>(
      `messages/${encodeURIComponent(id)}`,
      { format: "raw" },
      signal,
    );
    return decodeBase64Url(message.raw ?? "");
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
   * Lists the ids of the mailbox's unread messages, every page, with the
   * filter of its listing (so All Mail and Starred leave out Spam and Trash),
   * then removes `UNREAD` from them in `batchModify` chunks.
   */
  async markAllRead(
    mailboxId: MailboxId,
    signal?: AbortSignal,
  ): Promise<readonly MessageId[]> {
    const invalid =
      mailboxId === ALL_MAIL_ID ? undefined : inventedIdError([mailboxId]);
    if (invalid) throw invalid;
    const ids = (
      await this.#listAllIds(listFilter(mailboxId, "is:unread"), signal)
    ).map(asMessageId);
    await this.setFlags(ids, { seen: true }, signal);
    return ids;
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
      throw new MailError("provider", "Only Trash and Spam can be emptied.", {
        reason: "onlyTrashSpam",
      });
    }
    const ids = (
      await this.#listAllIds(
        { labelIds: [mailboxId], includeSpamTrash: true },
        signal,
      )
    ).map(asMessageId);
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
        // Invitations: the calendar part says which event it is.
        (mimeType === "text/calendar" ||
          ((mimeType === "text/html" || mimeType === "text/plain") &&
            !part.filename)) &&
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
