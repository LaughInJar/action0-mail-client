// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import {
  asAttachmentId,
  asCursor,
  asDraftId,
  asMailboxId,
  asMessageId,
  asSyncToken,
  asThreadId,
} from "../../core/ids";
import {
  gmailLabel,
  gmailMessage,
  leafPart,
  multipart,
  utf8Base64Url,
} from "../../test/gmailFixtures";
import { GmailProvider } from "./GmailProvider";
import {
  GMAIL_API_BASE,
  GMAIL_UPLOAD_BASE,
  GmailHttp,
  PEOPLE_API_BASE,
} from "./http";
import { ALL_MAIL_ID, GMAIL_LABEL_COLORS } from "./labels";
import type { GmailLabel } from "./types";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const url = (path: string) => `${GMAIL_API_BASE}${path}`;
const provider = () =>
  new GmailProvider(
    new GmailHttp({
      auth: new StaticAuthSession(),
      sleep: () => Promise.resolve(),
    }),
  );

describe("GmailProvider.listMailboxes", () => {
  it("fetches counts for mapped labels only", async () => {
    const fetched: string[] = [];
    server.use(
      http.get(url("labels"), () =>
        HttpResponse.json({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "UNREAD", name: "UNREAD", type: "system" },
            { id: "Label_1", name: "Work", type: "user" },
          ],
        }),
      ),
      http.get(url("labels/:id"), ({ params }) => {
        const id = String(params.id);
        fetched.push(id);
        return HttpResponse.json(
          gmailLabel(id, {
            name: id === "Label_1" ? "Work" : id,
            messagesUnread: 4,
          }),
        );
      }),
    );
    const mailboxes = await provider().listMailboxes();
    expect(fetched.sort()).toEqual(["INBOX", "Label_1"]);
    expect(mailboxes.map((m) => m.name)).toEqual(["Inbox", "All Mail", "Work"]);
    expect(mailboxes[0]?.counts?.unread).toBe(4);
  });
});

describe("GmailProvider.listMessages", () => {
  it("lists a page in order, with metadata, and returns the next cursor", async () => {
    let listParams: URLSearchParams | undefined;
    let metadataParams: URLSearchParams | undefined;
    server.use(
      http.get(url("messages"), ({ request }) => {
        listParams = new URL(request.url).searchParams;
        return HttpResponse.json({
          messages: [
            { id: "b", threadId: "tb" },
            { id: "a", threadId: "ta" },
          ],
          nextPageToken: "page-2",
        });
      }),
      http.get(url("messages/:id"), async ({ params, request }) => {
        metadataParams = new URL(request.url).searchParams;
        // Answer out of order to prove the page keeps the list order.
        if (params.id === "b")
          await new Promise((resolve) => setTimeout(resolve, 10));
        return HttpResponse.json(gmailMessage(String(params.id)));
      }),
    );
    const page = await provider().listMessages({
      mailboxId: asMailboxId("INBOX"),
      cursor: asCursor("page-1"),
      limit: 50,
    });
    expect(page.items.map((m) => m.id)).toEqual(["b", "a"]);
    expect(page.nextCursor).toBe("page-2");
    expect(listParams?.getAll("labelIds")).toEqual(["INBOX"]);
    expect(listParams?.get("pageToken")).toBe("page-1");
    expect(listParams?.has("includeSpamTrash")).toBe(false);
    expect(metadataParams?.get("format")).toBe("metadata");
    expect(metadataParams?.getAll("metadataHeaders")).toContain("Subject");
  });

  it("lists All Mail without a label filter and Spam with includeSpamTrash", async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(url("messages"), ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({});
      }),
    );
    const gmail = provider();
    await gmail.listMessages({
      mailboxId: asMailboxId(ALL_MAIL_ID),
      limit: 10,
    });
    await gmail.listMessages({ mailboxId: asMailboxId("SPAM"), limit: 10 });
    expect(seen[0]?.has("labelIds")).toBe(false);
    expect(seen[1]?.get("includeSpamTrash")).toBe("true");
  });

  it("passes a search as q, together with the mailbox's label", async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(url("messages"), ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({});
      }),
    );
    const gmail = provider();
    await gmail.listMessages({
      mailboxId: asMailboxId("INBOX"),
      search: "  from:bob has:attachment ",
      limit: 10,
    });
    await gmail.listMessages({
      mailboxId: asMailboxId(ALL_MAIL_ID),
      search: "invoice",
      limit: 10,
    });
    expect(seen[0]?.get("q")).toBe("from:bob has:attachment");
    expect(seen[0]?.getAll("labelIds")).toEqual(["INBOX"]);
    expect(seen[1]?.get("q")).toBe("invoice");
    expect(seen[1]?.has("labelIds")).toBe(false);
  });

  it("skips messages deleted between list and get", async () => {
    server.use(
      http.get(url("messages"), () =>
        HttpResponse.json({
          messages: [
            { id: "gone", threadId: "t" },
            { id: "here", threadId: "t" },
          ],
        }),
      ),
      http.get(url("messages/gone"), () =>
        HttpResponse.json({ error: { message: "not found" } }, { status: 404 }),
      ),
      http.get(url("messages/here"), () =>
        HttpResponse.json(gmailMessage("here")),
      ),
    );
    const page = await provider().listMessages({
      mailboxId: asMailboxId("INBOX"),
      limit: 10,
    });
    expect(page.items.map((m) => m.id)).toEqual(["here"]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("GmailProvider.getMessage", () => {
  it("fetches the full message and hydrates large text bodies", async () => {
    server.use(
      http.get(url("messages/m1"), ({ request }) => {
        expect(new URL(request.url).searchParams.get("format")).toBe("full");
        return HttpResponse.json(
          gmailMessage("m1", {
            payload: multipart("alternative", [
              leafPart("text/plain", utf8Base64Url("short text")),
              leafPart("text/html", "", {
                attachmentId: "big-html",
                size: 900_000,
              }),
            ]),
          }),
        );
      }),
      http.get(url("messages/m1/attachments/big-html"), () =>
        HttpResponse.json({ size: 13, data: utf8Base64Url("<p>large</p>") }),
      ),
    );
    const message = await provider().getMessage(asMessageId("m1"));
    expect(message.body).toEqual({ html: "<p>large</p>", text: "short text" });
  });
});

describe("GmailProvider.getAttachment", () => {
  it("downloads attachments by id", async () => {
    server.use(
      http.get(url("messages/m1/attachments/a1"), () =>
        HttpResponse.json({ size: 3, data: utf8Base64Url("abc") }),
      ),
    );
    const blob = await provider().getAttachment(
      asMessageId("m1"),
      asAttachmentId("a1"),
    );
    expect(await blob.text()).toBe("abc");
  });

  it("extracts small inlined parts from the message", async () => {
    server.use(
      http.get(url("messages/m1"), () =>
        HttpResponse.json(
          gmailMessage("m1", {
            payload: multipart("mixed", [
              leafPart("text/plain", utf8Base64Url("body"), { partId: "0" }),
              leafPart("image/gif", utf8Base64Url("GIF"), {
                partId: "1",
                filename: "x.gif",
              }),
            ]),
          }),
        ),
      ),
    );
    const blob = await provider().getAttachment(
      asMessageId("m1"),
      asAttachmentId("part:1"),
    );
    expect(await blob.text()).toBe("GIF");
  });
});

describe("GmailProvider writes", () => {
  function captureBatchModify() {
    const bodies: unknown[] = [];
    server.use(
      http.post(url("messages/batchModify"), async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return bodies;
  }
  const ids = (...names: string[]) => names.map(asMessageId);

  it("archives by removing INBOX and unarchives by adding it", async () => {
    const bodies = captureBatchModify();
    const gmail = provider();
    await expect(gmail.archive(ids("a", "b"))).resolves.toEqual({});
    await gmail.unarchive(ids("a"));
    expect(bodies).toEqual([
      { ids: ["a", "b"], removeLabelIds: ["INBOX"] },
      { ids: ["a"], addLabelIds: ["INBOX"] },
    ]);
  });

  it("maps seen and flagged to the UNREAD and STARRED labels", async () => {
    const bodies = captureBatchModify();
    const gmail = provider();
    await gmail.setFlags(ids("a"), { seen: true });
    await gmail.setFlags(ids("a"), { seen: false, flagged: true });
    await gmail.setFlags(ids("a"), { flagged: false });
    expect(bodies).toEqual([
      { ids: ["a"], removeLabelIds: ["UNREAD"] },
      { ids: ["a"], addLabelIds: ["UNREAD", "STARRED"] },
      { ids: ["a"], removeLabelIds: ["STARRED"] },
    ]);
  });

  it("splits large batches and skips empty ones", async () => {
    const bodies = captureBatchModify();
    const many = Array.from({ length: 2500 }, (_, i) => asMessageId(`m${i}`));
    await provider().archive(many);
    expect((bodies as { ids: string[] }[]).map((b) => b.ids.length)).toEqual([
      1000, 1000, 500,
    ]);
    await provider().archive([]);
    await provider().setFlags(ids("a"), {});
    expect(bodies).toHaveLength(3);
  });

  it("reports write failures as MailErrors", async () => {
    server.use(
      http.post(url("messages/batchModify"), () =>
        HttpResponse.json(
          { error: { message: "Invalid label" } },
          { status: 400 },
        ),
      ),
    );
    await expect(provider().archive(ids("a"))).rejects.toMatchObject({
      code: "provider",
    });
  });
});

describe("GmailProvider move and labels", () => {
  function captureBatchModify() {
    const bodies: unknown[] = [];
    server.use(
      http.post(url("messages/batchModify"), async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return bodies;
  }
  const ids = (...names: string[]) => names.map(asMessageId);
  const box = asMailboxId;

  it("moves by adding the target and removing the source label", async () => {
    const bodies = captureBatchModify();
    await provider().move(ids("a"), { from: box("INBOX"), to: box("Label_1") });
    expect(bodies).toEqual([
      { ids: ["a"], addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("only adds when moving out of a view, so it never unstars", async () => {
    const bodies = captureBatchModify();
    await provider().move(ids("a"), {
      from: box(ALL_MAIL_ID),
      to: box("Label_1"),
    });
    await provider().move(ids("a"), {
      from: box("STARRED"),
      to: box("Label_1"),
    });
    expect(bodies).toEqual([
      { ids: ["a"], addLabelIds: ["Label_1"] },
      { ids: ["a"], addLabelIds: ["Label_1"] },
    ]);
  });

  it("sets labels in one call", async () => {
    const bodies = captureBatchModify();
    await provider().setLabels(ids("a", "b"), {
      add: [box("Label_1")],
      remove: [box("Label_2"), box("INBOX")],
    });
    expect(bodies).toEqual([
      {
        ids: ["a", "b"],
        addLabelIds: ["Label_1"],
        removeLabelIds: ["Label_2", "INBOX"],
      },
    ]);
  });

  it("rejects mailbox ids that only exist in our tree", async () => {
    const gmail = provider();
    await expect(
      gmail.move(ids("a"), { from: box("INBOX"), to: box(ALL_MAIL_ID) }),
    ).rejects.toMatchObject({ code: "provider" });
    await expect(
      gmail.setLabels(ids("a"), { add: [box("synthetic:Work")], remove: [] }),
    ).rejects.toMatchObject({ code: "provider" });
  });
});

describe("GmailProvider trash, spam and deletion", () => {
  const ids = (...names: string[]) => names.map(asMessageId);

  it("trashes and restores with one empty-bodied request per message", async () => {
    const calls: string[] = [];
    server.use(
      http.post(url("messages/:id/:action"), async ({ params, request }) => {
        expect(await request.text()).toBe("");
        expect(request.headers.get("Content-Type")).toBeNull();
        calls.push(`${String(params.action)} ${String(params.id)}`);
        return HttpResponse.json({ id: params.id });
      }),
    );
    await provider().trash(ids("a", "b"));
    await provider().untrash(ids("a"));
    expect(calls.sort()).toEqual(["trash a", "trash b", "untrash a"]);
  });

  it("reports spam and not spam with batchModify", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(url("messages/batchModify"), async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await provider().reportSpam(ids("a"));
    await provider().notSpam(ids("a"));
    expect(bodies).toEqual([
      { ids: ["a"], addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
      { ids: ["a"], addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
    ]);
  });

  it("deletes forever in chunks of 1000", async () => {
    const sizes: number[] = [];
    server.use(
      http.post(url("messages/batchDelete"), async ({ request }) => {
        sizes.push(((await request.json()) as { ids: string[] }).ids.length);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await provider().deleteForever(
      Array.from({ length: 1500 }, (_, i) => asMessageId(`m${i}`)),
    );
    expect(sizes).toEqual([1000, 500]);
  });

  it("empties Trash by listing every page and deleting all of it", async () => {
    const deleted: string[] = [];
    let listParams: URLSearchParams | undefined;
    server.use(
      http.get(url("messages"), ({ request }) => {
        listParams = new URL(request.url).searchParams;
        return listParams.get("pageToken") === "2"
          ? HttpResponse.json({ messages: [{ id: "c", threadId: "t" }] })
          : HttpResponse.json({
              messages: [
                { id: "a", threadId: "t" },
                { id: "b", threadId: "t" },
              ],
              nextPageToken: "2",
            });
      }),
      http.post(url("messages/batchDelete"), async ({ request }) => {
        deleted.push(...((await request.json()) as { ids: string[] }).ids);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      provider().emptyMailbox(asMailboxId("TRASH")),
    ).resolves.toEqual({ deleted: 3 });
    expect(deleted).toEqual(["a", "b", "c"]);
    expect(listParams?.get("includeSpamTrash")).toBe("true");
    expect(listParams?.getAll("labelIds")).toEqual(["TRASH"]);
  });

  it("refuses to empty anything but Trash and Spam", async () => {
    await expect(
      provider().emptyMailbox(asMailboxId("INBOX")),
    ).rejects.toMatchObject({
      code: "provider",
    });
  });
});

describe("GmailProvider.listMessages, oldest first", () => {
  /** Six messages m1 (oldest) … m6 (newest), listed two per page. */
  function serveSixMessages() {
    const listCalls: URLSearchParams[] = [];
    const pages: Record<string, { ids: string[]; next?: string }> = {
      "": { ids: ["m6", "m5"], next: "p2" },
      p2: { ids: ["m4", "m3"], next: "p3" },
      p3: { ids: ["m2", "m1"] },
    };
    server.use(
      http.get(url("messages"), ({ request }) => {
        const params = new URL(request.url).searchParams;
        listCalls.push(params);
        const page = pages[params.get("pageToken") ?? ""];
        return HttpResponse.json({
          messages: page?.ids.map((id) => ({ id, threadId: id })),
          ...(page?.next ? { nextPageToken: page.next } : {}),
        });
      }),
      http.get(url("messages/:id"), ({ params }) =>
        HttpResponse.json(gmailMessage(String(params.id))),
      ),
    );
    return listCalls;
  }

  it("lists every id once, then pages through them in reverse", async () => {
    const listCalls = serveSixMessages();
    const gmail = provider();
    const query = {
      mailboxId: asMailboxId("INBOX"),
      search: "report",
      order: "oldest",
      limit: 4,
    } as const;

    const first = await gmail.listMessages(query);
    expect(first.items.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(listCalls).toHaveLength(3);
    expect(listCalls[0]?.get("maxResults")).toBe("500");
    expect(listCalls[0]?.get("q")).toBe("report");
    expect(listCalls[0]?.getAll("labelIds")).toEqual(["INBOX"]);

    const second = await gmail.listMessages({
      ...query,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items.map((m) => m.id)).toEqual(["m5", "m6"]);
    expect(second.nextCursor).toBeUndefined();
    // The second page came from the snapshot: no new list requests.
    expect(listCalls).toHaveLength(3);
  });

  it("lists again when the snapshot is gone or belongs to another list", async () => {
    const listCalls = serveSixMessages();
    const query = {
      mailboxId: asMailboxId("INBOX"),
      order: "oldest",
      limit: 4,
    } as const;
    const { nextCursor } = await provider().listMessages(query);
    expect(nextCursor).toBeDefined();

    // E.g. after a reload: a new provider doesn't know the snapshot.
    const later = await provider().listMessages({
      ...query,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
    expect(later.items.map((m) => m.id)).toEqual(["m5", "m6"]);
    expect(listCalls).toHaveLength(6);

    const gmail = provider();
    const own = await gmail.listMessages(query);
    const other = await gmail.listMessages({
      ...query,
      search: "something else",
      ...(own.nextCursor ? { cursor: own.nextCursor } : {}),
    });
    expect(other.items.map((m) => m.id)).toEqual(["m5", "m6"]);
    expect(listCalls.at(-1)?.get("q")).toBe("something else");
  });
});

describe("GmailProvider drafts and sending", () => {
  const upload = (path: string) => `${GMAIL_UPLOAD_BASE}${path}`;
  const draft = {
    to: [{ name: "Anna", address: "anna@example.org" }],
    cc: [],
    bcc: [],
    subject: "Grüße",
    html: "<p>Hi</p>",
    text: "Hi",
    attachments: [],
    threading: {
      threadId: asThreadId("t1"),
      inReplyTo: "<m1@x>",
      references: ["<m1@x>"],
    },
  };

  /** Splits a multipart/related upload into its JSON metadata and raw message. */
  async function readUpload(request: Request) {
    const type = request.headers.get("Content-Type") ?? "";
    const boundary = /boundary=(\S+)/.exec(type)?.[1] ?? "";
    const parts = (await request.text())
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((part) => part.slice(part.indexOf("\r\n\r\n") + 4, -2));
    return {
      type,
      uploadType: new URL(request.url).searchParams.get("uploadType"),
      metadata: JSON.parse(parts[0] ?? "{}") as unknown,
      raw: parts[1] ?? "",
    };
  }

  it("creates a draft in the thread, then replaces it", async () => {
    const uploads: Awaited<ReturnType<typeof readUpload>>[] = [];
    server.use(
      http.post(upload("drafts"), async ({ request }) => {
        uploads.push(await readUpload(request));
        return HttpResponse.json({ id: "d1", message: { id: "m-a" } });
      }),
      http.put(upload("drafts/d1"), async ({ request }) => {
        uploads.push(await readUpload(request));
        return HttpResponse.json({ id: "d1", message: { id: "m-b" } });
      }),
    );
    const gmail = provider();
    expect(await gmail.saveDraft(draft)).toEqual({
      id: "d1",
      messageId: "m-a",
    });
    expect(
      await gmail.saveDraft({ ...draft, id: asDraftId("d1"), subject: "Two" }),
    ).toEqual({ id: "d1", messageId: "m-b" });

    expect(uploads[0]?.type).toMatch(/^multipart\/related; boundary=/);
    expect(uploads[0]?.uploadType).toBe("multipart");
    expect(uploads[0]?.metadata).toEqual({ message: { threadId: "t1" } });
    expect(uploads[0]?.raw).toContain("To: Anna <anna@example.org>");
    expect(uploads[0]?.raw).toContain("In-Reply-To: <m1@x>");
    expect(uploads[0]?.raw).toContain("Subject: =?UTF-8?B?");
    expect(uploads[1]?.metadata).toEqual({
      id: "d1",
      message: { threadId: "t1" },
    });
    expect(uploads[1]?.raw).toContain("Subject: Two");
  });

  it("doesn't repeat creating a draft after a server error", async () => {
    let attempts = 0;
    server.use(
      http.post(upload("drafts"), () => {
        attempts++;
        return HttpResponse.json(
          { error: { message: "oops" } },
          { status: 503 },
        );
      }),
    );
    await expect(provider().saveDraft(draft)).rejects.toMatchObject({
      code: "provider",
    });
    expect(attempts).toBe(1);
  });

  it("sends the final content, with the forwarded files", async () => {
    let sent: Awaited<ReturnType<typeof readUpload>> | undefined;
    server.use(
      http.get(url("messages/orig/attachments/att1"), () =>
        HttpResponse.json({ size: 3, data: "AQID" }),
      ),
      http.post(upload("drafts/send"), async ({ request }) => {
        sent = await readUpload(request);
        return HttpResponse.json({ id: "sent-1", threadId: "t1" });
      }),
    );
    const result = await provider().sendDraft({
      ...draft,
      id: asDraftId("d1"),
      attachments: [
        {
          id: "a",
          filename: "a.bin",
          mimeType: "application/octet-stream",
          size: 3,
          source: {
            messageId: asMessageId("orig"),
            attachmentId: asAttachmentId("att1"),
          },
        },
        {
          id: "b",
          filename: "b.txt",
          mimeType: "text/plain",
          size: 2,
          content: new Blob(["ok"]),
        },
      ],
    });
    expect(result).toEqual({ messageId: "sent-1" });
    expect(sent?.metadata).toEqual({ id: "d1", message: { threadId: "t1" } });
    expect(sent?.raw).toContain('filename="a.bin"');
    expect(sent?.raw).toContain("AQID");
    expect(sent?.raw).toContain("b2s="); // "ok", loaded already: not fetched
    expect(sent?.raw).toMatch(/\r\nDate: /);
  });

  it("finds a draft by its message, reads and deletes it", async () => {
    let deleted = false;
    server.use(
      http.get(url("drafts"), ({ request }) => {
        const page = new URL(request.url).searchParams.get("pageToken");
        return HttpResponse.json(
          page === null
            ? {
                drafts: [{ id: "d0", message: { id: "x" } }],
                nextPageToken: "p2",
              }
            : { drafts: [{ id: "d1", message: { id: "m-b" } }] },
        );
      }),
      http.get(url("drafts/d1"), () => {
        const message = gmailMessage("m-b", {
          payload: multipart("mixed", [
            leafPart("text/html", utf8Base64Url("<p>Draft</p>")),
            leafPart("application/pdf", "", {
              filename: "x.pdf",
              attachmentId: "att9",
              size: 10,
              partId: "1",
            }),
          ]),
        });
        return HttpResponse.json({
          id: "d1",
          message: {
            ...message,
            threadId: "t1",
            payload: {
              ...message.payload,
              headers: [
                { name: "Content-Type", value: "multipart/mixed; boundary=x" },
                { name: "To", value: "Anna <anna@example.org>" },
                { name: "Subject", value: "Re: Plans" },
                { name: "In-Reply-To", value: "<m1@x>" },
                { name: "References", value: "<m0@x> <m1@x>" },
              ],
            },
          },
        });
      }),
      http.delete(url("drafts/d1"), () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const gmail = provider();
    expect(await gmail.draftIdOf(asMessageId("m-b"))).toBe("d1");
    expect(await gmail.draftIdOf(asMessageId("nope"))).toBeUndefined();

    const loaded = await gmail.getDraft(asDraftId("d1"));
    expect(loaded).toMatchObject({
      id: "d1",
      messageId: "m-b",
      to: [{ name: "Anna", address: "anna@example.org" }],
      subject: "Re: Plans",
      html: "<p>Draft</p>",
      threading: {
        threadId: "t1",
        inReplyTo: "<m1@x>",
        references: ["<m0@x>", "<m1@x>"],
      },
    });
    expect(loaded.attachments).toEqual([
      expect.objectContaining({
        source: { messageId: "m-b", attachmentId: "att9" },
        filename: "x.pdf",
      }),
    ]);

    await gmail.deleteDraft(asDraftId("d1"));
    expect(deleted).toBe(true);
  });
});

describe("GmailProvider.searchContacts", () => {
  const peopleUrl = (path: string) => `${PEOPLE_API_BASE}${path}`;
  const withPeople = () =>
    new GmailProvider(
      new GmailHttp({
        auth: new StaticAuthSession(),
        sleep: () => Promise.resolve(),
      }),
      {
        people: new GmailHttp({
          auth: new StaticAuthSession(),
          baseUrl: PEOPLE_API_BASE,
          service: "Google Contacts",
          sleep: () => Promise.resolve(),
        }),
      },
    );

  it("warms up once, then merges contacts and other contacts", async () => {
    const queries: string[] = [];
    server.use(
      http.get(peopleUrl("people:searchContacts"), ({ request }) => {
        const query = new URL(request.url).searchParams.get("query") ?? "";
        queries.push(`contacts:${query}`);
        return HttpResponse.json({
          results: query
            ? [
                {
                  person: {
                    names: [{ displayName: "Anna Berger" }],
                    emailAddresses: [
                      { value: "anna@example.org" },
                      { value: "anna@work.example" },
                    ],
                  },
                },
              ]
            : [],
        });
      }),
      http.get(peopleUrl("otherContacts:search"), ({ request }) => {
        const query = new URL(request.url).searchParams.get("query") ?? "";
        queries.push(`other:${query}`);
        return HttpResponse.json({
          results: query
            ? [
                { person: { emailAddresses: [{ value: "ANNA@example.org" }] } },
                { person: { emailAddresses: [{ value: "annika@x.com" }] } },
              ]
            : [],
        });
      }),
    );
    const gmail = withPeople();
    expect(gmail.capabilities.contacts).toBe(true);
    expect(provider().capabilities.contacts).toBe(false);

    expect(await gmail.searchContacts("ann")).toEqual([
      { name: "Anna Berger", address: "anna@example.org" },
      { name: "Anna Berger", address: "anna@work.example" },
      { address: "annika@x.com" },
    ]);
    await gmail.searchContacts("anni");
    expect(queries.filter((q) => q.endsWith(":"))).toHaveLength(2);
  });

  it("reports a disabled API or a declined permission as unavailable", async () => {
    server.use(
      http.get(peopleUrl("people:searchContacts"), () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message:
                "People API has not been used in project 123 before or it is disabled.",
              status: "PERMISSION_DENIED",
            },
          },
          { status: 403 },
        ),
      ),
      http.get(peopleUrl("otherContacts:search"), () =>
        HttpResponse.json({ results: [] }),
      ),
    );
    await expect(withPeople().searchContacts("a")).rejects.toMatchObject({
      code: "unavailable",
      message: "The People API isn't enabled in the Google Cloud project.",
    });
  });
});

describe("GmailProvider, large drafts", () => {
  const upload = (path: string) => `${GMAIL_UPLOAD_BASE}${path}`;
  const big = {
    to: [{ address: "anna@example.org" }],
    cc: [],
    bcc: [],
    subject: "Big",
    html: "<p>Files</p>",
    text: "Files",
    attachments: [
      {
        id: "big",
        filename: "big.bin",
        mimeType: "application/octet-stream",
        size: 4_500_000,
        content: new Blob([new Uint8Array(4_500_000)]),
      },
    ],
  };

  it("uploads through a resumable session", async () => {
    const steps: string[] = [];
    let uploaded = 0;
    server.use(
      http.post(upload("drafts"), async ({ request }) => {
        const params = new URL(request.url).searchParams;
        steps.push(`start:${params.get("uploadType") ?? ""}`);
        expect(request.headers.get("X-Upload-Content-Type")).toBe(
          "message/rfc822",
        );
        expect(await request.json()).toEqual({ message: {} });
        return new HttpResponse(null, {
          headers: { Location: `${upload("drafts")}?upload_id=s1` },
        });
      }),
      http.put(upload("drafts"), async ({ request }) => {
        steps.push(
          `put:${new URL(request.url).searchParams.get("upload_id") ?? ""}`,
        );
        uploaded = (await request.text()).length;
        return HttpResponse.json({ id: "d9", message: { id: "m9" } });
      }),
    );
    expect(await provider().saveDraft(big)).toEqual({
      id: "d9",
      messageId: "m9",
    });
    expect(steps).toEqual(["start:resumable", "put:s1"]);
    expect(uploaded).toBeGreaterThan(6_000_000);
  });

  it("falls back to one multipart request without a session URL", async () => {
    const types: string[] = [];
    server.use(
      http.post(upload("drafts"), ({ request }) => {
        const type = new URL(request.url).searchParams.get("uploadType") ?? "";
        types.push(type);
        return type === "resumable"
          ? new HttpResponse(null)
          : HttpResponse.json({ id: "d1", message: { id: "m1" } });
      }),
    );
    expect(await provider().saveDraft(big)).toEqual({
      id: "d1",
      messageId: "m1",
    });
    expect(types).toEqual(["resumable", "multipart"]);
  });
});

describe("GmailProvider.changesSince", () => {
  it("starts from the profile's history id", async () => {
    server.use(
      http.get(url("profile"), () =>
        HttpResponse.json({ emailAddress: "me@example.com", historyId: "100" }),
      ),
    );
    expect(await provider().changesSince(undefined)).toEqual({
      token: "100",
      reset: false,
      changes: [],
    });
  });

  it("reports added, changed and deleted messages since the token", async () => {
    const asked: URLSearchParams[] = [];
    server.use(
      http.get(url("history"), ({ request }) => {
        const params = new URL(request.url).searchParams;
        asked.push(params);
        return HttpResponse.json(
          params.get("pageToken") === null
            ? {
                history: [
                  { id: "101", messagesAdded: [{ message: { id: "new" } }] },
                  {
                    id: "102",
                    labelsAdded: [
                      { message: { id: "old" }, labelIds: ["STARRED"] },
                    ],
                  },
                ],
                nextPageToken: "p2",
                historyId: "103",
              }
            : {
                history: [
                  {
                    id: "103",
                    messagesDeleted: [{ message: { id: "gone" } }],
                    labelsRemoved: [{ message: { id: "gone" } }],
                  },
                ],
                historyId: "104",
              },
        );
      }),
      http.get(url("messages/:id"), ({ params }) =>
        params.id === "old" || params.id === "new"
          ? HttpResponse.json(gmailMessage(params.id))
          : HttpResponse.json({ error: { message: "x" } }, { status: 404 }),
      ),
    );
    const set = await provider().changesSince(asSyncToken("100"));
    expect(asked[0]?.get("startHistoryId")).toBe("100");
    expect(asked[0]?.getAll("historyTypes")).toEqual([
      "messageAdded",
      "messageDeleted",
      "labelAdded",
      "labelRemoved",
    ]);
    expect(set.token).toBe("104");
    expect(set.reset).toBe(false);
    expect(
      set.changes.map((c) =>
        c.kind === "removed" ? `removed:${c.id}` : `${c.kind}:${c.message.id}`,
      ),
    ).toEqual(["added:new", "updated:old", "removed:gone"]);
  });

  it("starts over when the history is too old or too long", async () => {
    server.use(
      http.get(url("history"), ({ request }) =>
        new URL(request.url).searchParams.get("startHistoryId") === "1"
          ? HttpResponse.json({ error: { message: "old" } }, { status: 404 })
          : HttpResponse.json({
              history: Array.from({ length: 101 }, (_, i) => ({
                id: String(i),
                messagesAdded: [{ message: { id: `m${String(i)}` } }],
              })),
              historyId: "500",
            }),
      ),
      http.get(url("profile"), () =>
        HttpResponse.json({ emailAddress: "me@example.com", historyId: "900" }),
      ),
    );
    expect(await provider().changesSince(asSyncToken("1"))).toEqual({
      token: "900",
      reset: true,
      changes: [],
    });
    expect(await provider().changesSince(asSyncToken("2"))).toMatchObject({
      token: "900",
      reset: true,
    });
  });
});

describe("GmailProvider label management", () => {
  /** A small label store behind the labels endpoints; records the writes. */
  function labelServer(initial: GmailLabel[]) {
    const labels = new Map(initial.map((label) => [label.id, { ...label }]));
    const writes: { method: string; id?: string; body?: unknown }[] = [];
    let next = 100;
    const notFound = () =>
      HttpResponse.json({ error: { message: "Not Found" } }, { status: 404 });
    server.use(
      http.get(url("labels"), () =>
        HttpResponse.json({ labels: [...labels.values()] }),
      ),
      http.get(url("labels/:id"), ({ params }) => {
        const label = labels.get(String(params.id));
        return label ? HttpResponse.json(label) : notFound();
      }),
      http.post(url("labels"), async ({ request }) => {
        const body = (await request.json()) as GmailLabel;
        writes.push({ method: "POST", body });
        if ([...labels.values()].some((l) => l.name === body.name))
          return HttpResponse.json(
            { error: { code: 409, message: "Label name exists or conflicts" } },
            { status: 409 },
          );
        const label: GmailLabel = {
          ...body,
          id: `Label_${next++}`,
          type: "user",
        };
        labels.set(label.id, label);
        return HttpResponse.json(label);
      }),
      http.put(url("labels/:id"), async ({ params, request }) => {
        const id = String(params.id);
        const body = (await request.json()) as GmailLabel;
        writes.push({ method: "PUT", id, body });
        labels.set(id, { ...body, type: "user" });
        return HttpResponse.json(labels.get(id));
      }),
      http.patch(url("labels/:id"), async ({ params, request }) => {
        const id = String(params.id);
        const body = (await request.json()) as Partial<GmailLabel>;
        const label = labels.get(id);
        if (!label) return notFound();
        writes.push({ method: "PATCH", id, body });
        labels.set(id, { ...label, ...body });
        return HttpResponse.json(labels.get(id));
      }),
      http.delete(url("labels/:id"), ({ params }) => {
        const id = String(params.id);
        writes.push({ method: "DELETE", id });
        labels.delete(id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return { labels, writes };
  }
  const user = (id: string, name: string, extra: Partial<GmailLabel> = {}) =>
    gmailLabel(id, {
      name,
      type: "user",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
      ...extra,
    });
  const red = GMAIL_LABEL_COLORS[0]!;
  const box = asMailboxId;

  it("creates labels by path, with colour and hidden", async () => {
    const { writes } = labelServer([user("Label_1", "Work")]);
    const gmail = provider();
    expect(gmail.capabilities.manageMailboxes).toBe(true);
    expect(gmail.capabilities.mailboxColors).toHaveLength(16);

    const created = await gmail.createMailbox({
      name: " 2026 ",
      parentId: box("Label_1"),
      color: red,
      hidden: true,
    });
    expect(writes[0]?.body).toEqual({
      name: "Work/2026",
      labelListVisibility: "labelHide",
      messageListVisibility: "show",
      color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
    });
    expect(created).toMatchObject({
      id: "Label_100",
      name: "2026",
      parentId: "Label_1",
      kind: "label",
      hidden: true,
      assignable: true,
      color: red,
    });

    // Inside a parent that only exists as part of other labels' names.
    await gmail.createMailbox({
      name: "Alpha",
      parentId: box("synthetic:Projects"),
    });
    expect(writes[1]?.body).toMatchObject({ name: "Projects/Alpha" });
  });

  it("says clearly when a name is taken or not allowed", async () => {
    labelServer([user("Label_1", "Work")]);
    await expect(provider().createMailbox({ name: "Work" })).rejects.toThrow(
      "There’s already a label called “Work”.",
    );
    await expect(provider().createMailbox({ name: "a/b" })).rejects.toThrow(
      "Label names can’t contain “/”.",
    );
  });

  it("renames the labels inside a renamed label", async () => {
    const { labels, writes } = labelServer([
      user("Label_1", "Work", {
        color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
      }),
      user("Label_2", "Work/Clients"),
      user("Label_3", "Work/Clients/Acme"),
      user("Label_4", "Workshop"),
    ]);
    const updated = await provider().updateMailbox(box("Label_1"), {
      name: "Job",
    });
    expect(writes[0]).toEqual({
      method: "PUT",
      id: "Label_1",
      body: {
        id: "Label_1",
        name: "Job",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
      },
    });
    expect([...labels.values()].map((label) => label.name)).toEqual([
      "Job",
      "Job/Clients",
      "Job/Clients/Acme",
      "Workshop",
    ]);
    expect(updated).toMatchObject({ id: "Label_1", name: "Job" });
  });

  it("moves a label, removes its colour and hides it", async () => {
    const { labels, writes } = labelServer([
      user("Label_1", "Work"),
      user("Label_2", "Work/Clients", {
        color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
      }),
      user("Label_5", "Personal"),
    ]);
    const gmail = provider();
    const moved = await gmail.updateMailbox(box("Label_2"), {
      parentId: box("Label_5"),
      color: null,
      hidden: true,
    });
    expect(writes[0]?.body).toEqual({
      id: "Label_2",
      name: "Personal/Clients",
      messageListVisibility: "show",
      labelListVisibility: "labelHide",
    });
    expect(moved).toMatchObject({ parentId: "Label_5", hidden: true });
    expect(moved.color).toBeUndefined();

    await gmail.updateMailbox(box("Label_2"), { parentId: null });
    expect(labels.get("Label_2")?.name).toBe("Clients");
    await expect(
      gmail.updateMailbox(box("Label_1"), { parentId: box("Label_1") }),
    ).rejects.toThrow("A label can’t go inside itself.");
  });

  it("deletes user labels, never system ones", async () => {
    const { writes } = labelServer([
      user("Label_1", "Work"),
      gmailLabel("INBOX", { name: "INBOX" }),
    ]);
    const gmail = provider();
    await gmail.deleteMailbox(box("Label_1"));
    expect(writes).toEqual([{ method: "DELETE", id: "Label_1" }]);
    await expect(gmail.deleteMailbox(box("INBOX"))).rejects.toThrow(
      "System labels can’t be changed.",
    );
    await expect(gmail.deleteMailbox(box(ALL_MAIL_ID))).rejects.toMatchObject({
      code: "provider",
    });
    expect(writes).toHaveLength(1);
  });
});

describe("GmailProvider.oneClickUnsubscribe", () => {
  it("posts the RFC 8058 body, without credentials", async () => {
    let seen:
      { body: string; type: string | null; cookie: string | null } | undefined;
    server.use(
      http.post("https://news.example/unsubscribe", async ({ request }) => {
        seen = {
          body: await request.text(),
          type: request.headers.get("Content-Type"),
          cookie: request.headers.get("Cookie"),
        };
        return new HttpResponse(null, { status: 202 });
      }),
    );
    await provider().oneClickUnsubscribe("https://news.example/unsubscribe");
    expect(seen).toEqual({
      body: "List-Unsubscribe=One-Click",
      type: "application/x-www-form-urlencoded",
      cookie: null,
    });
  });

  it("fails when the sender can't be reached or refuses", async () => {
    server.use(
      http.post("https://down.example/u", () => HttpResponse.error()),
      http.post("https://refuses.example/u", () =>
        HttpResponse.text("no", { status: 500 }),
      ),
    );
    await expect(
      provider().oneClickUnsubscribe("https://down.example/u"),
    ).rejects.toMatchObject({ code: "network" });
    await expect(
      provider().oneClickUnsubscribe("https://refuses.example/u"),
    ).rejects.toMatchObject({ code: "provider", status: 500 });
    await expect(
      provider().oneClickUnsubscribe("http://plain.example/u"),
    ).rejects.toMatchObject({ code: "provider" });
  });
});
