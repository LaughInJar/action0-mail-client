/**
 * An in-memory IMAP account behind a fake {@link ImapBridge}, for tests of
 * the IMAP provider and the Add account wizard: folders with roles,
 * messages, flags, moves, appends and sends, plus scripted answers for
 * looking up settings and adding accounts.
 */
import { vi } from "vitest";
import {
  MailServerError,
  type MailServerAccountInfo,
  type MailServerDiscovery,
  type MailServerSetup,
} from "../accounts/mailServer";
import type {
  ImapBridge,
  ImapCalls,
  ImapMailbox,
  ImapMessage,
  ImapSummary,
} from "../providers/imap/bridge";

/** A stored message: what the bridge answers for it, and its bytes. */
interface Stored {
  message: ImapMessage;
  raw: Uint8Array;
}

/** Options of {@link fakeImapBridge}. */
export interface FakeImapOptions {
  /** Folders besides the Inbox, by role or name. */
  readonly folders?: readonly Pick<ImapMailbox, "name" | "role">[];
  readonly messages?: readonly ImapMessage[];
  /** What `discover` answers. */
  readonly discovery?: MailServerDiscovery;
  /** What `connect` answers instead of adding (in order, then success). */
  readonly connectFailures?: readonly MailServerError[];
}

const decoder = new TextDecoder();

/** A message in a folder, with the fields tests don't care about filled in. */
export function imapMessage(
  id: string,
  folder: string,
  overrides: Partial<ImapMessage> = {},
): ImapMessage {
  return {
    id,
    threadId: `<${id}@example.org>`,
    mailboxIds: [folder],
    from: { name: "Anna Berger", address: "anna@example.org" },
    to: [{ address: "me@example.com" }],
    subject: `Message ${id}`,
    snippet: "Hello",
    receivedAt: "2026-10-18T10:00:00.000Z",
    flags: { seen: false, flagged: false },
    hasAttachments: false,
    cc: [],
    bcc: [],
    replyTo: [],
    internetMessageId: `<${id}@example.org>`,
    references: [],
    body: { text: "Hello" },
    attachments: [],
    draft: false,
    ...overrides,
  };
}

/** A header's value in a raw message (unfolded), for appended mail. */
function header(raw: string, name: string): string | undefined {
  const head = raw.split("\r\n\r\n")[0] ?? "";
  const match = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, "im").exec(
    head,
  );
  return match?.[1]?.replace(/\r\n[ \t]/g, " ");
}

/** See the module docs. */
export function fakeImapBridge(options: FakeImapOptions = {}) {
  const folders: ImapMailbox[] = [
    folder("INBOX", "Inbox", "inbox"),
    ...(
      options.folders ?? [
        { name: "Sent", role: "sent" },
        { name: "Drafts", role: "drafts" },
        { name: "Trash", role: "trash" },
        { name: "Junk", role: "junk" },
      ]
    ).map(({ name, role }) => folder(name, name, role)),
  ];
  const store = new Map<string, Stored>(
    (options.messages ?? []).map((message) => [
      message.id,
      { message, raw: new TextEncoder().encode(`Subject: ${message.subject}`) },
    ]),
  );
  const sent: {
    envelope: { from: string; to: readonly string[] };
    raw: string;
  }[] = [];
  const appended: {
    mailboxId: string;
    flags: readonly string[];
    raw: string;
  }[] = [];
  const failures = [...(options.connectFailures ?? [])];
  const connected: MailServerSetup[] = [];
  const accounts = new Map<string, MailServerAccountInfo>();
  let next = 1;
  let version = 0;

  function folder(
    path: string,
    name: string,
    role?: ImapMailbox["role"],
  ): ImapMailbox {
    return {
      id: `f:${path}`,
      name,
      kind: "folder",
      ...(role ? { role } : {}),
      selectable: true,
      hidden: false,
      assignable: role !== "sent" && role !== "drafts",
    };
  }

  const inFolder = (id: string) =>
    [...store.values()]
      .map(({ message }) => message)
      .filter((message) => message.mailboxIds.includes(id));

  const withCounts = (mailbox: ImapMailbox): ImapMailbox => {
    const messages = inFolder(mailbox.id);
    return {
      ...mailbox,
      counts: {
        total: messages.length,
        unread: messages.filter((m) => !m.flags.seen).length,
      },
    };
  };

  const summary = ({
    cc: _cc,
    bcc: _bcc,
    replyTo: _replyTo,
    internetMessageId: _messageId,
    references: _references,
    inReplyTo: _inReplyTo,
    body: _body,
    attachments: _attachments,
    listUnsubscribe: _unsubscribe,
    listUnsubscribePost: _post,
    calendar: _calendar,
    draft: _draft,
    ...rest
  }: ImapMessage): ImapSummary => rest;

  const get = (id: string): Stored => {
    const found = store.get(id);
    if (!found) throw new MailServerError("notFound", `No message ${id}.`);
    return found;
  };

  const calls: {
    [K in keyof ImapCalls]: (
      request: ImapCalls[K]["request"],
    ) => ImapCalls[K]["response"];
  } = {
    folders: () => folders.map(withCounts),
    list: ({ mailboxId, search }) => ({
      items: inFolder(mailboxId)
        .filter(
          (message) =>
            !search ||
            `${message.subject} ${message.snippet}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .map(summary),
    }),
    threads: ({ mailboxId }) => ({
      items: inFolder(mailboxId).map((message) => ({
        id: message.threadId,
        messages: [summary(message)],
      })),
    }),
    thread: ({ id }) =>
      [...store.values()]
        .map(({ message }) => message)
        .filter((message) => message.threadId === id),
    message: ({ id }) => get(id).message,
    flags: ({ ids, seen, flagged }) => {
      for (const id of ids) {
        const stored = get(id);
        stored.message = {
          ...stored.message,
          flags: {
            seen: seen ?? stored.message.flags.seen,
            flagged: flagged ?? stored.message.flags.flagged,
          },
        };
      }
      version++;
      return {};
    },
    move: ({ ids, to }) => {
      for (const id of ids) {
        const stored = get(id);
        stored.message = { ...stored.message, mailboxIds: [to] };
      }
      version++;
      return {};
    },
    delete: ({ ids }) => {
      for (const id of ids) store.delete(id);
      version++;
      return {};
    },
    empty: ({ mailboxId }) => {
      const gone = inFolder(mailboxId);
      for (const message of gone) store.delete(message.id);
      return { deleted: gone.length };
    },
    markAllRead: ({ mailboxId }) => {
      const unread = inFolder(mailboxId).filter((m) => !m.flags.seen);
      for (const message of unread)
        get(message.id).message = {
          ...message,
          flags: { ...message.flags, seen: true },
        };
      return unread.map((message) => message.id);
    },
    createFolder: ({ name, parentId, role }) => {
      if (folders.some((f) => f.name === name && f.parentId === parentId))
        throw new MailServerError("exists", `${name} exists.`);
      const created = {
        ...folder(parentId ? `${parentId.slice(2)}/${name}` : name, name, role),
        ...(parentId ? { parentId } : {}),
      };
      folders.push(created);
      return created;
    },
    updateFolder: ({ id, name, parentId }) => {
      const index = folders.findIndex((f) => f.id === id);
      const current = folders[index];
      if (!current) throw new MailServerError("notFound", "No folder.");
      const { parentId: _old, ...rest } = current;
      const updated: ImapMailbox = {
        ...rest,
        ...(name ? { name } : {}),
        ...(parentId === null
          ? {}
          : parentId
            ? { parentId }
            : current.parentId
              ? { parentId: current.parentId }
              : {}),
      };
      folders[index] = updated;
      return updated;
    },
    deleteFolder: ({ id }) => {
      const index = folders.findIndex((f) => f.id === id);
      if (index >= 0) folders.splice(index, 1);
      return {};
    },
    changes: ({ token }) => ({
      token: String(version),
      reset: false,
      changes: token === undefined ? [] : [],
    }),
  };

  const bridge: ImapBridge = {
    discover: vi.fn(() =>
      Promise.resolve(options.discovery ?? { source: "none" as const }),
    ),
    connect: vi.fn((setup: MailServerSetup) => {
      connected.push(setup);
      const failure = failures.shift();
      if (failure) return Promise.reject(failure);
      const info: MailServerAccountInfo = {
        key: `imap:${setup.address.toLowerCase()}`,
        address: setup.address,
        name: setup.name,
        settings: setup.settings,
        signIn:
          "password" in setup.credentials
            ? "password"
            : setup.credentials.oauth,
        pinned: setup.trust !== undefined,
      };
      accounts.set(info.key, info);
      return Promise.resolve(info);
    }),
    accounts: () =>
      Promise.resolve({ persistent: true, accounts: [...accounts.values()] }),
    reconnect: vi.fn(() => Promise.resolve()),
    remove: vi.fn((key: string) => {
      accounts.delete(key);
      return Promise.resolve();
    }),
    forgetCertificate: vi.fn((key: string) => {
      const info = accounts.get(key);
      if (info) accounts.set(key, { ...info, pinned: false });
      return Promise.resolve();
    }),
    call: (_key, name, request) => {
      try {
        const answer = (
          calls[name] as (
            request: unknown,
          ) => ImapCalls[typeof name]["response"]
        )(request);
        return Promise.resolve(answer);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    bytes: (_key, request) => {
      const stored = store.get(request.id);
      return stored
        ? Promise.resolve(stored.raw)
        : Promise.reject(new MailServerError("notFound", "No message."));
    },
    append: (_key, { mailboxId, flags }, message) => {
      const raw = decoder.decode(message);
      appended.push({ mailboxId, flags, raw });
      const id = `appended-${String(next++)}`;
      const to = header(raw, "To");
      const replyTo = header(raw, "Reply-To");
      store.set(id, {
        raw: message,
        message: imapMessage(id, mailboxId, {
          subject: header(raw, "Subject") ?? "",
          to: to ? [{ address: to.replace(/.*<|>.*/g, "") }] : [],
          replyTo: replyTo
            ? [{ address: replyTo.replace(/.*<|>.*/g, "") }]
            : [],
          flags: { seen: flags.includes("\\Seen"), flagged: false },
          draft: flags.includes("\\Draft"),
          internetMessageId: header(raw, "Message-ID") ?? "",
        }),
      });
      version++;
      return Promise.resolve({ id });
    },
    send: vi.fn<ImapBridge["send"]>((_key, envelope, message) => {
      sent.push({ envelope, raw: decoder.decode(message) });
      return Promise.resolve();
    }),
  };
  return { bridge, store, folders, sent, appended, connected, accounts };
}
