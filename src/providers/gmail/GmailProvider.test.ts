// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import {
  asAttachmentId,
  asCursor,
  asMailboxId,
  asMessageId,
} from "../../core/ids";
import {
  gmailLabel,
  gmailMessage,
  leafPart,
  multipart,
  utf8Base64Url,
} from "../../test/gmailFixtures";
import { GmailProvider } from "./GmailProvider";
import { GMAIL_API_BASE, GmailHttp } from "./http";
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
