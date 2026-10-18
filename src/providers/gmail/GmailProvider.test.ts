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
import { ALL_MAIL_ID } from "./labels";

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
    forwarded: [],
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
      forwarded: [
        {
          messageId: asMessageId("orig"),
          attachmentId: asAttachmentId("att1"),
          filename: "a.bin",
          mimeType: "application/octet-stream",
          size: 3,
        },
        {
          messageId: asMessageId("orig"),
          attachmentId: asAttachmentId("loaded"),
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
    expect(loaded.forwarded).toEqual([
      expect.objectContaining({
        messageId: "m-b",
        attachmentId: "att9",
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
