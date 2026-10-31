import { http, HttpResponse, type HttpHandler } from "msw";
import type {
  GraphAutomaticReplies,
  GraphMessageRule,
} from "../providers/microsoft/filters";
import { GRAPH_BASE } from "../providers/microsoft/http";
import type {
  GraphAttachment,
  GraphCategory,
  GraphMailFolder,
  GraphMessage,
} from "../providers/microsoft/types";

/** Where the fake mailbox's upload sessions accept chunks. */
export const UPLOAD_BASE = "https://upload.outlook.test/session/";

/** A message of the fake mailbox, with its attachments and their bytes. */
export interface FakeGraphMessage extends GraphMessage {
  attachments?: (GraphAttachment & { bytes?: string })[];
  /** The MIME source `$value` returns (else a short one is made up). */
  mime?: string;
}

/** One request the fake answered (batched ones too), for assertions. */
export interface SeenRequest {
  readonly method: string;
  /** Path below `v1.0/`, without the query. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly batched: boolean;
  readonly prefer: string | null;
}

/**
 * A tiny in-memory Outlook mailbox behind Microsoft Graph, for MSW: folders
 * (with well-known names), messages, attachments, drafts, upload sessions,
 * delta queries and `$batch`. It answers what {@link GraphProvider} asks,
 * not all of Graph.
 */
export class FakeGraph {
  readonly folders: GraphMailFolder[];
  readonly messages: FakeGraphMessage[];
  /** Well-known name → folder id. */
  readonly wellKnown: Record<string, string>;
  readonly seen: SeenRequest[] = [];
  readonly people: { displayName: string; address: string }[] = [];
  /** The user's categories (`me/outlook/masterCategories`). */
  readonly categories: GraphCategory[] = [];
  /** Inbox rules (`me/mailFolders/inbox/messageRules`), in any order. */
  rules: GraphMessageRule[] = [];
  /** `mailboxSettings.automaticRepliesSetting`. */
  automaticReplies: GraphAutomaticReplies = {
    status: "disabled",
    externalAudience: "all",
    internalReplyMessage: "",
    externalReplyMessage: "",
  };
  me = {
    displayName: "Max Muster",
    mail: "max@contoso.com",
    userPrincipalName: "max@contoso.com",
  };
  /** Upload chunks starting at this byte fail like a lost connection. */
  failUploadAt: number | undefined;
  /**
   * Answer the next requests to these paths (method + path) with this
   * status (and Graph error code).
   */
  readonly failures = new Map<
    string,
    number | { readonly status: number; readonly code: string }
  >();
  #version = 0;
  #nextId = 1;
  /** Membership changes: a message left `from` and/or is now in `to`. */
  readonly #log: {
    version: number;
    id: string;
    from?: string;
    to?: string;
  }[] = [];
  readonly #folderLog: { version: number; id: string; removed?: true }[] = [];
  readonly #uploads = new Map<
    string,
    { messageId: string; attachment: GraphAttachment; received: number }
  >();

  constructor() {
    const root = "root";
    const folder = (
      id: string,
      name: string,
      parent = root,
    ): GraphMailFolder => ({
      id,
      displayName: name,
      parentFolderId: parent,
      childFolderCount: 0,
      unreadItemCount: 0,
      totalItemCount: 0,
    });
    this.folders = [
      folder("inbox-id", "Inbox"),
      folder("drafts-id", "Drafts"),
      folder("sent-id", "Sent Items"),
      folder("trash-id", "Deleted Items"),
      folder("junk-id", "Junk Email"),
      folder("archive-id", "Archive"),
      folder("outbox-id", "Outbox"),
      folder("history-id", "Conversation History"),
      folder("projects-id", "Projects"),
      folder("clients-id", "Clients", "projects-id"),
    ];
    this.wellKnown = {
      msgfolderroot: root,
      inbox: "inbox-id",
      drafts: "drafts-id",
      sentitems: "sent-id",
      deleteditems: "trash-id",
      junkemail: "junk-id",
      archive: "archive-id",
      outbox: "outbox-id",
      conversationhistory: "history-id",
    };
    this.messages = [];
  }

  /** Adds a received message to a folder (by id or well-known name). */
  add(message: Partial<FakeGraphMessage> & { id: string }, folder = "inbox") {
    const full: FakeGraphMessage = {
      subject: message.id,
      bodyPreview: "",
      from: { emailAddress: { name: "Anna", address: "anna@example.com" } },
      toRecipients: [{ emailAddress: { address: this.me.mail } }],
      receivedDateTime: "2026-10-18T10:00:00Z",
      createdDateTime: "2026-10-18T10:00:00Z",
      isRead: false,
      isDraft: false,
      hasAttachments: false,
      flag: { flagStatus: "notFlagged" },
      body: { contentType: "html", content: `<p>${message.id}</p>` },
      internetMessageId: `<${message.id}@example.com>`,
      ...message,
      parentFolderId: this.#folderId(folder),
    };
    this.messages.push(full);
    this.#log.push({
      version: ++this.#version,
      id: full.id,
      to: full.parentFolderId ?? "",
    });
    return full;
  }

  /** Changes a message as if from another device (logged for delta). */
  change(id: string, change: Partial<FakeGraphMessage>) {
    const message = this.#message(id);
    if (!message) throw new Error(`no message ${id}`);
    const from = message.parentFolderId;
    Object.assign(message, change);
    this.#log.push({
      version: ++this.#version,
      id,
      ...(from === undefined ? {} : { from }),
      ...(message.parentFolderId === undefined
        ? {}
        : { to: message.parentFolderId }),
    });
  }

  /** Deletes a message for good (logged for delta). */
  remove(id: string) {
    const message = this.#message(id);
    if (!message) return;
    this.messages.splice(this.messages.indexOf(message), 1);
    this.#log.push({
      version: ++this.#version,
      id,
      ...(message.parentFolderId === undefined
        ? {}
        : { from: message.parentFolderId }),
    });
  }

  /** Adds a folder (logged for the folder delta). */
  addFolder(id: string, name: string, parent = "root") {
    this.folders.push({
      id,
      displayName: name,
      parentFolderId: parent,
      childFolderCount: 0,
      unreadItemCount: 0,
      totalItemCount: 0,
    });
    this.#folderLog.push({ version: ++this.#version, id });
  }

  /** Requests answered so far for a method and path pattern. */
  requests(method: string, path: RegExp): SeenRequest[] {
    return this.seen.filter(
      (request) => request.method === method && path.test(request.path),
    );
  }

  handlers(): HttpHandler[] {
    return [
      http.post(`${GRAPH_BASE}$batch`, async ({ request }) => {
        const { requests = [] } = (await request.json()) as {
          requests?: {
            id: string;
            method: string;
            url: string;
            body?: unknown;
            headers?: Record<string, string>;
          }[];
        };
        return HttpResponse.json({
          responses: requests.map((inner) => {
            const url = new URL(inner.url.replace(/^\//, ""), GRAPH_BASE);
            const answer = this.#answer(
              inner.method,
              url,
              inner.body,
              true,
              inner.headers?.Prefer ?? null,
            );
            return { id: inner.id, status: answer.status, body: answer.body };
          }),
        });
      }),
      http.all(`${GRAPH_BASE}*`, async ({ request }) => {
        const url = new URL(request.url);
        const text = request.method === "GET" ? "" : await request.text();
        const answer = this.#answer(
          request.method,
          url,
          text === "" ? undefined : JSON.parse(text),
          false,
          request.headers.get("Prefer"),
        );
        if (answer.blob !== undefined)
          return new HttpResponse(answer.blob, { status: answer.status });
        return answer.body === undefined
          ? new HttpResponse(null, { status: answer.status })
          : HttpResponse.json(answer.body, { status: answer.status });
      }),
      http.put(`${UPLOAD_BASE}:session`, async ({ request, params }) => {
        if (request.headers.has("Authorization"))
          return new HttpResponse(null, { status: 400 });
        const upload = this.#uploads.get(String(params.session));
        if (!upload) return new HttpResponse(null, { status: 404 });
        const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(
          request.headers.get("Content-Range") ?? "",
        );
        const start = Number(range?.[1] ?? -1);
        const end = Number(range?.[2] ?? -1);
        const total = Number(range?.[3] ?? 0);
        if (start === this.failUploadAt) return HttpResponse.error();
        upload.received = end + 1;
        await request.arrayBuffer();
        if (upload.received < total)
          return HttpResponse.json(
            { nextExpectedRanges: [`${String(upload.received)}-`] },
            { status: 200 },
          );
        this.#message(upload.messageId)?.attachments?.push(upload.attachment);
        this.#uploads.delete(String(params.session));
        return new HttpResponse(null, { status: 201 });
      }),
    ];
  }

  #answer(
    method: string,
    url: URL,
    body: unknown,
    batched: boolean,
    prefer: string | null,
  ): { status: number; body?: unknown; blob?: Blob } {
    const path = decodeURIComponent(url.pathname).replace(/^\/v1\.0\//, "");
    const query = url.searchParams;
    this.seen.push({ method, path, query, body, batched, prefer });
    const failure = this.failures.get(`${method} ${path}`);
    if (failure !== undefined) {
      this.failures.delete(`${method} ${path}`);
      const { status, code } =
        typeof failure === "number"
          ? { status: failure, code: "Failure" }
          : failure;
      return {
        status,
        body: { error: { code, message: `HTTP ${String(status)}` } },
      };
    }
    const notFound = {
      status: 404,
      body: { error: { code: "ErrorItemNotFound", message: "Not found." } },
    };
    let match: RegExpExecArray | null;

    if (method === "GET" && path === "me")
      return { status: 200, body: this.me };
    if (method === "GET" && path === "me/people")
      return {
        status: 200,
        body: {
          value: this.people
            .filter((person) =>
              `${person.displayName} ${person.address}`
                .toLowerCase()
                .includes(stripQuotes(query.get("$search")).toLowerCase()),
            )
            .map((person) => ({
              displayName: person.displayName,
              scoredEmailAddresses: [{ address: person.address }],
            })),
        },
      };

    // Categories.
    if (path === "me/outlook/masterCategories") {
      if (method === "GET")
        return { status: 200, body: { value: this.categories } };
      if (method === "POST") {
        const spec = body as { displayName: string; color?: string };
        if (this.categories.some((c) => c.displayName === spec.displayName))
          return {
            status: 409,
            body: {
              error: { code: "ErrorDuplicate", message: "It exists." },
            },
          };
        const created: GraphCategory = {
          id: `cat-${String(this.#nextId++)}`,
          displayName: spec.displayName,
          color: spec.color ?? "none",
        };
        this.categories.push(created);
        return { status: 201, body: created };
      }
    }
    if ((match = /^me\/outlook\/masterCategories\/([^/]+)$/.exec(path))) {
      const index = this.categories.findIndex((c) => c.id === match?.[1]);
      const found = this.categories[index];
      if (!found) return notFound;
      if (method === "PATCH") {
        const { displayName, color } = body as Partial<GraphCategory>;
        if (displayName !== undefined && displayName !== found.displayName)
          return {
            status: 400,
            body: {
              error: { code: "ErrorInvalidRequest", message: "Read-only." },
            },
          };
        const updated = { ...found, ...(color ? { color } : {}) };
        this.categories[index] = updated;
        return { status: 200, body: updated };
      }
      if (method === "DELETE") {
        this.categories.splice(index, 1);
        return { status: 204 };
      }
    }

    // Inbox rules: PATCH replaces conditions, exceptions and actions as a whole.
    if (path === "me/mailFolders/inbox/messageRules") {
      if (method === "GET")
        return {
          status: 200,
          body: {
            value: [...this.rules].sort(
              (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
            ),
          },
        };
      if (method === "POST") {
        const created: GraphMessageRule = {
          isEnabled: true,
          ...(body as Omit<GraphMessageRule, "id">),
          id: `rule-${String(this.#nextId++)}`,
          hasError: false,
          isReadOnly: false,
        };
        this.rules.push(created);
        return { status: 201, body: created };
      }
    }
    if (
      (match = /^me\/mailFolders\/inbox\/messageRules\/([^/]+)$/.exec(path))
    ) {
      const index = this.rules.findIndex((rule) => rule.id === match?.[1]);
      const found = this.rules[index];
      if (!found) return notFound;
      if (method === "GET") return { status: 200, body: found };
      if (method === "PATCH") {
        const updated = { ...found, ...(body as Partial<GraphMessageRule>) };
        this.rules[index] = updated;
        return { status: 200, body: updated };
      }
      if (method === "DELETE") {
        this.rules.splice(index, 1);
        return { status: 204 };
      }
    }

    // Mailbox settings: PATCH merges inside automaticRepliesSetting.
    if (path === "me/mailboxSettings") {
      if (method === "GET")
        return {
          status: 200,
          body: { automaticRepliesSetting: this.automaticReplies },
        };
      if (method === "PATCH") {
        const { automaticRepliesSetting } = body as {
          automaticRepliesSetting?: GraphAutomaticReplies;
        };
        this.automaticReplies = {
          ...this.automaticReplies,
          ...automaticRepliesSetting,
        };
        return {
          status: 200,
          body: { automaticRepliesSetting: this.automaticReplies },
        };
      }
    }

    // Folders.
    if (method === "GET" && path === "me/mailFolders/delta")
      return { status: 200, body: this.#folderDelta(query) };
    if (method === "GET" && path === "me/mailFolders")
      return {
        status: 200,
        body: { value: this.#childrenOf(this.wellKnown.msgfolderroot ?? "") },
      };
    if ((match = /^me\/mailFolders\/([^/]+)\/childFolders$/.exec(path))) {
      const parent = this.#folderId(match[1] ?? "");
      if (method === "GET")
        return { status: 200, body: { value: this.#childrenOf(parent) } };
      if (method === "POST") return this.#createFolder(body, parent);
    }
    if (method === "POST" && path === "me/mailFolders")
      return this.#createFolder(body, this.wellKnown.msgfolderroot ?? "");
    if ((match = /^me\/mailFolders\/([^/]+)\/move$/.exec(path))) {
      const folder = this.#folder(match[1] ?? "");
      if (!folder) return notFound;
      const destination = this.#folderId(
        (body as { destinationId: string }).destinationId,
      );
      (folder as { parentFolderId?: string }).parentFolderId = destination;
      return { status: 201, body: folder };
    }
    if ((match = /^me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(path)))
      return { status: 200, body: this.#delta(match[1] ?? "", query) };
    if ((match = /^me\/mailFolders\/([^/]+)\/messages$/.exec(path))) {
      const folder = this.#folderId(match[1] ?? "");
      return this.#list(
        this.messages.filter((m) => m.parentFolderId === folder),
        url,
      );
    }
    if ((match = /^me\/mailFolders\/([^/]+)$/.exec(path))) {
      const folder = this.#folder(match[1] ?? "");
      if (!folder) return notFound;
      if (method === "GET") return { status: 200, body: folder };
      if (method === "PATCH") {
        Object.assign(folder, body);
        return { status: 200, body: folder };
      }
      if (method === "DELETE") {
        this.folders.splice(this.folders.indexOf(folder), 1);
        return { status: 204 };
      }
    }

    // Messages.
    if (path === "me/messages" && method === "GET")
      return this.#list(this.messages, url);
    if (path === "me/messages" && method === "POST")
      return { status: 201, body: this.#createDraft(body) };
    if (
      (match = /^me\/messages\/([^/]+)\/attachments\/createUploadSession$/.exec(
        path,
      ))
    ) {
      const message = this.#message(match[1] ?? "");
      if (!message) return notFound;
      const item = (body as { AttachmentItem: Record<string, unknown> })
        .AttachmentItem;
      const session = String(this.#nextId++);
      this.#uploads.set(session, {
        messageId: message.id,
        received: 0,
        attachment: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: `att-${session}`,
          name: String(item.name),
          contentType: String(item.contentType),
          size: Number(item.size),
          isInline: item.isInline === true,
          ...(typeof item.contentId === "string"
            ? { contentId: item.contentId }
            : {}),
        },
      });
      return { status: 201, body: { uploadUrl: `${UPLOAD_BASE}${session}` } };
    }
    if ((match = /^me\/messages\/([^/]+)\/\$value$/.exec(path))) {
      const message = this.#message(match[1] ?? "");
      return message
        ? {
            status: 200,
            blob: new Blob([
              message.mime ??
                `Subject: ${message.subject ?? ""}\r\n\r\n${message.id}\r\n`,
            ]),
          }
        : notFound;
    }
    if (
      (match = /^me\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/.exec(
        path,
      ))
    ) {
      const attachment = this.#message(match[1] ?? "")?.attachments?.find(
        (a) => a.id === match?.[2],
      );
      return attachment
        ? { status: 200, blob: new Blob([attachment.bytes ?? ""]) }
        : notFound;
    }
    if ((match = /^me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path))) {
      const message = this.#message(match[1] ?? "");
      const list = message?.attachments ?? [];
      const index = list.findIndex((a) => a.id === match?.[2]);
      if (index < 0 || method !== "DELETE") return notFound;
      list.splice(index, 1);
      return { status: 204 };
    }
    if ((match = /^me\/messages\/([^/]+)\/attachments$/.exec(path))) {
      const message = this.#message(match[1] ?? "");
      if (!message) return notFound;
      message.attachments ??= [];
      if (method === "GET")
        return {
          status: 200,
          body: {
            value: message.attachments.map(
              ({ bytes: _bytes, ...rest }) => rest,
            ),
          },
        };
      const { contentBytes, ...rest } = body as GraphAttachment & {
        contentBytes: string;
      };
      const attachment = {
        ...rest,
        id: `att-${String(this.#nextId++)}`,
        size: atob(contentBytes).length,
        bytes: atob(contentBytes),
      };
      message.attachments.push(attachment);
      return { status: 201, body: attachment };
    }
    if (
      (match =
        /^me\/messages\/([^/]+)\/(move|createReply|createForward|send)$/.exec(
          path,
        ))
    ) {
      const message = this.#message(match[1] ?? "");
      if (!message) return notFound;
      if (match[2] === "move") {
        const destination = this.#folderId(
          (body as { destinationId: string }).destinationId,
        );
        if (!this.#folder(destination))
          return {
            status: 404,
            body: {
              error: { code: "ErrorFolderNotFound", message: "No folder." },
            },
          };
        this.change(message.id, { parentFolderId: destination });
        return { status: 201, body: message };
      }
      if (match[2] === "createForward")
        return {
          status: 201,
          // Like Outlook: the forward carries copies of the attachments.
          body: this.#createDraft({
            subject: `FW: ${message.subject ?? ""}`,
            conversationId: message.conversationId,
            attachments: (message.attachments ?? []).map((attachment) => ({
              ...attachment,
              id: `att-${String(this.#nextId++)}`,
            })),
          }),
        };
      if (match[2] === "createReply")
        return {
          status: 201,
          body: this.#createDraft({
            subject: `RE: ${message.subject ?? ""}`,
            toRecipients: message.from ? [message.from] : [],
            conversationId: message.conversationId,
            internetMessageHeaders: [
              { name: "In-Reply-To", value: message.internetMessageId ?? "" },
            ],
          }),
        };
      // send
      this.change(message.id, {
        parentFolderId: this.wellKnown.sentitems ?? "",
        isDraft: false,
      });
      return { status: 202 };
    }
    if ((match = /^me\/messages\/([^/]+)$/.exec(path))) {
      const message = this.#message(match[1] ?? "");
      if (!message) return notFound;
      if (method === "GET")
        return {
          status: 200,
          body: select(message, query.get("$select")),
        };
      if (method === "PATCH") {
        this.change(message.id, body as Partial<FakeGraphMessage>);
        return { status: 200, body: message };
      }
      if (method === "DELETE") {
        this.remove(message.id);
        return { status: 204 };
      }
    }
    return {
      status: 400,
      body: { error: { code: "BadRequest", message: `${method} ${path}` } },
    };
  }

  #list(
    all: readonly FakeGraphMessage[],
    url: URL,
  ): { status: number; body: unknown } {
    const query = url.searchParams;
    let items = [...all];
    const search = query.get("$search");
    if (search !== null) {
      const text = stripQuotes(search).toLowerCase();
      items = items.filter((m) =>
        (m.subject ?? "").toLowerCase().includes(text),
      );
    }
    const filter = query.get("$filter") ?? "";
    if (filter.includes("flag/flagStatus eq 'flagged'"))
      items = items.filter((m) => m.flag?.flagStatus === "flagged");
    if (filter.includes("isRead eq false"))
      items = items.filter((m) => m.isRead === false);
    const byCategory = /categories\/any\(c:c eq '(.*)'\)/.exec(filter);
    if (byCategory) {
      const name = byCategory[1]?.replace(/''/g, "'") ?? "";
      items = items.filter((m) => m.categories?.includes(name));
    }
    const byId = /internetMessageId eq '(.*)'/.exec(filter);
    if (byId)
      items = items.filter(
        (m) => m.internetMessageId === byId[1]?.replace(/''/g, "'"),
      );
    const byConversation = /conversationId eq '(.*)'/.exec(filter);
    if (byConversation) {
      // Like Graph: filtering by conversation can't be combined with sorting.
      if (query.has("$orderby"))
        return {
          status: 400,
          body: {
            error: { code: "InefficientFilter", message: "Too complex." },
          },
        };
      items = items.filter(
        (m) => m.conversationId === byConversation[1]?.replace(/''/g, "'"),
      );
    }
    const order = query.get("$orderby") ?? "receivedDateTime desc";
    items.sort((a, b) =>
      (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""),
    );
    if (order.endsWith("desc") || search !== null) items.reverse();
    const top = Number(query.get("$top") ?? 10);
    const skip = Number(query.get("$skip") ?? 0);
    const page = items.slice(skip, skip + top);
    const next = new URL(url);
    next.searchParams.set("$skip", String(skip + top));
    return {
      status: 200,
      body: {
        value: page.map((m) => select(m, query.get("$select"))),
        ...(query.get("$count") === "true"
          ? { "@odata.count": items.length }
          : {}),
        ...(skip + top < items.length ? { "@odata.nextLink": next.href } : {}),
      },
    };
  }

  /** Folder delta: rounds end at once; later rounds report changed folders. */
  #delta(folderName: string, query: URLSearchParams) {
    const folder = this.#folderId(folderName);
    const link = (version: number) =>
      `${GRAPH_BASE}me/mailFolders/${folder}/messages/delta?$deltatoken=${String(version)}`;
    const token = query.get("$deltatoken");
    if (token === null)
      return { value: [], "@odata.deltaLink": link(this.#version) };
    const since = Number(token);
    const present = new Set<string>();
    const removed = new Set<string>();
    for (const entry of this.#log) {
      if (entry.version <= since) continue;
      if (entry.to === folder) {
        present.add(entry.id);
        removed.delete(entry.id);
      } else if (entry.from === folder) {
        removed.add(entry.id);
        present.delete(entry.id);
      }
    }
    return {
      value: [
        ...[...present].map((id) => ({ id })),
        ...[...removed].map((id) => ({
          id,
          "@removed": { reason: "deleted" },
        })),
      ],
      "@odata.deltaLink": link(this.#version),
    };
  }

  #folderDelta(query: URLSearchParams) {
    const link = (version: number) =>
      `${GRAPH_BASE}me/mailFolders/delta?$deltatoken=${String(version)}`;
    const token = query.get("$deltatoken");
    if (token === null)
      return {
        value: this.folders.map(({ id }) => ({ id })),
        "@odata.deltaLink": link(this.#version),
      };
    const since = Number(token);
    return {
      value: this.#folderLog
        .filter((entry) => entry.version > since)
        .map(({ id, removed }) => (removed ? { id, "@removed": {} } : { id })),
      "@odata.deltaLink": link(this.#version),
    };
  }

  #createDraft(fields: unknown): FakeGraphMessage {
    const id = `draft-${String(this.#nextId++)}`;
    const created = this.add(
      {
        id,
        from: {
          emailAddress: { name: this.me.displayName, address: this.me.mail },
        },
        toRecipients: [],
        isRead: true,
        isDraft: true,
        internetMessageId: `<${id}@contoso.com>`,
        ...(fields as Partial<FakeGraphMessage>),
      },
      "drafts",
    );
    return created;
  }

  #createFolder(body: unknown, parent: string) {
    const name = (body as { displayName: string }).displayName;
    if (
      this.folders.some(
        (f) => f.parentFolderId === parent && f.displayName === name,
      )
    )
      return {
        status: 409,
        body: { error: { code: "ErrorFolderExists", message: "Exists." } },
      };
    const id = `folder-${String(this.#nextId++)}`;
    this.addFolder(id, name, parent);
    return { status: 201, body: this.#folder(id) };
  }

  #childrenOf(parent: string): GraphMailFolder[] {
    return this.folders
      .filter((folder) => folder.parentFolderId === parent)
      .map((folder) => ({
        ...folder,
        childFolderCount: this.folders.filter(
          (child) => child.parentFolderId === folder.id,
        ).length,
        unreadItemCount: this.messages.filter(
          (m) => m.parentFolderId === folder.id && m.isRead === false,
        ).length,
        totalItemCount: this.messages.filter(
          (m) => m.parentFolderId === folder.id,
        ).length,
      }));
  }

  #folderId(nameOrId: string): string {
    return this.wellKnown[nameOrId.toLowerCase()] ?? nameOrId;
  }

  #folder(nameOrId: string): GraphMailFolder | undefined {
    const id = this.#folderId(nameOrId);
    if (id === this.wellKnown.msgfolderroot) return { id };
    return this.folders.find((folder) => folder.id === id);
  }

  #message(id: string): FakeGraphMessage | undefined {
    return this.messages.find((message) => message.id === id);
  }
}

function stripQuotes(value: string | null): string {
  return (value ?? "").replace(/^"|"$/g, "").replace(/\\"/g, '"');
}

/** The `$select`ed fields of a message (all without `$select`). */
function select(message: FakeGraphMessage, fields: string | null): unknown {
  const { attachments: _attachments, ...rest } = message;
  if (fields === null) return rest;
  const wanted = new Set(fields.split(","));
  return Object.fromEntries(
    Object.entries(rest).filter(([key]) => key === "id" || wanted.has(key)),
  );
}
