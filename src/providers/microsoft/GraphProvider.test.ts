// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import type { OutgoingAttachment } from "../../core/compose";
import { isMailError } from "../../core/errors";
import {
  asAttachmentId,
  asDraftId,
  asMailboxId,
  asMessageId,
  asSyncToken,
  asThreadId,
} from "../../core/ids";
import { MemoryStorage } from "../../test/memoryStorage";
import { FakeGraph } from "../../test/graphServer";
import { ALL_VIEW_ID, FLAGGED_VIEW_ID } from "./folders";
import { GraphProvider, UPLOAD_CHUNK_BYTES } from "./GraphProvider";
import { GRAPH_BASE, GraphHttp } from "./http";

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

const NOW = Date.parse("2026-10-18T12:00:00Z");

function setup(options: { personal?: boolean } = {}) {
  const graph = new FakeGraph();
  server.use(...graph.handlers());
  const settings = new MemoryStorage();
  /** A provider on the same mailbox, e.g. a fresh one after a reload. */
  const another = () =>
    new GraphProvider(
      new GraphHttp({
        auth: new StaticAuthSession(),
        sleep: () => Promise.resolve(),
      }),
      {
        settings,
        signatureKey: "a0.signatures.test",
        now: () => NOW,
        ...options,
      },
    );
  return { graph, provider: another(), settings, another };
}

const id = asMessageId;
const box = asMailboxId;

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("GraphProvider mailboxes", () => {
  it("maps folders with roles, nests them, hides Outlook's own and adds the views", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "a", isRead: false });
    const mailboxes = await provider.listMailboxes();
    expect(mailboxes.map((m) => [m.name, m.role ?? null])).toEqual([
      ["Inbox", "inbox"],
      ["Drafts", "drafts"],
      ["Sent Items", "sent"],
      ["Deleted Items", "trash"],
      ["Junk Email", "junk"],
      ["Archive", "archive"],
      ["Flagged", "flagged"],
      ["All mail", "all"],
      ["Projects", null],
      ["Clients", null],
    ]);
    const byName = (name: string) => mailboxes.find((m) => m.name === name);
    expect(byName("Clients")?.parentId).toBe("projects-id");
    expect(byName("Projects")?.parentId).toBeUndefined();
    expect(byName("Inbox")).toMatchObject({
      kind: "folder",
      assignable: true,
      counts: { unread: 1, total: 1 },
    });
    expect(byName("Sent Items")?.assignable).toBe(false);
    expect(byName("All mail")).toMatchObject({ kind: "view", hidden: true });
    // Well-known names are resolved once, batched.
    await provider.listMailboxes();
    expect(graph.requests("GET", /^me\/mailFolders\/inbox$/)).toHaveLength(1);
    expect(graph.requests("GET", /^me\/mailFolders\/inbox$/)[0]?.batched).toBe(
      true,
    );
  });

  it("asks for immutable ids in every request", async () => {
    const { graph, provider } = setup();
    await provider.listMailboxes();
    expect(graph.seen.length).toBeGreaterThan(0);
    for (const request of graph.seen)
      expect(request.prefer).toContain('IdType="ImmutableId"');
  });
});

describe("GraphProvider listing", () => {
  it("lists a folder newest first, page by page, and oldest first", async () => {
    const { graph, provider } = setup();
    for (const [n, day] of [
      ["one", 1],
      ["two", 2],
      ["three", 3],
    ] as const)
      graph.add({
        id: n,
        receivedDateTime: `2026-10-0${String(day)}T10:00:00Z`,
      });
    const first = await provider.listMessages({
      mailboxId: box("inbox-id"),
      limit: 2,
    });
    expect(first.items.map((m) => m.id)).toEqual(["three", "two"]);
    expect(first.nextCursor).toBeDefined();
    const second = await provider.listMessages({
      mailboxId: box("inbox-id"),
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items.map((m) => m.id)).toEqual(["one"]);
    expect(second.nextCursor).toBeUndefined();

    const oldest = await provider.listMessages({
      mailboxId: box("inbox-id"),
      order: "oldest",
      limit: 5,
    });
    expect(oldest.items.map((m) => m.id)).toEqual(["one", "two", "three"]);
  });

  it("maps a row: sender, flags, folder and preview", async () => {
    const { graph, provider } = setup();
    graph.add({
      id: "a",
      subject: "Hello",
      bodyPreview: "Hi  there\n",
      isRead: true,
      flag: { flagStatus: "flagged" },
      hasAttachments: true,
      conversationId: "conv-1",
    });
    const { items } = await provider.listMessages({
      mailboxId: box("inbox-id"),
      limit: 10,
    });
    expect(items[0]).toMatchObject({
      id: "a",
      threadId: "conv-1",
      mailboxIds: ["inbox-id"],
      from: { name: "Anna", address: "anna@example.com" },
      subject: "Hello",
      snippet: "Hi there",
      flags: { seen: true, flagged: true },
      hasAttachments: true,
    });
  });

  it("searches a folder, oldest first too, and everywhere except Deleted Items and Junk", async () => {
    const { graph, provider } = setup();
    graph.add({
      id: "a",
      subject: "Invoice 1",
      receivedDateTime: "2026-10-01T10:00:00Z",
    });
    graph.add({
      id: "b",
      subject: "Invoice 2",
      receivedDateTime: "2026-10-02T10:00:00Z",
    });
    graph.add({ id: "c", subject: "Invoice 3" }, "deleteditems");
    graph.add({ id: "d", subject: "Lunch" });
    const inFolder = await provider.listMessages({
      mailboxId: box("inbox-id"),
      search: "invoice",
      limit: 10,
    });
    expect(inFolder.items.map((m) => m.id)).toEqual(["b", "a"]);
    expect(
      graph
        .requests("GET", /^me\/mailFolders\/inbox-id\/messages$/)[0]
        ?.query.get("$search"),
    ).toBe('"invoice"');

    const oldest = await provider.listMessages({
      mailboxId: box("inbox-id"),
      search: "invoice",
      order: "oldest",
      limit: 1,
    });
    expect(oldest.items.map((m) => m.id)).toEqual(["a"]);
    const next = await provider.listMessages({
      mailboxId: box("inbox-id"),
      search: "invoice",
      order: "oldest",
      limit: 1,
      ...(oldest.nextCursor ? { cursor: oldest.nextCursor } : {}),
    });
    expect(next.items.map((m) => m.id)).toEqual(["b"]);

    const everywhere = await provider.listMessages({
      mailboxId: ALL_VIEW_ID,
      search: "invoice",
      limit: 10,
    });
    expect(everywhere.items.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("shows flagged mail of every folder in the Flagged view", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "a", flag: { flagStatus: "flagged" } });
    graph.add({ id: "b", flag: { flagStatus: "flagged" } }, "projects-id");
    graph.add({ id: "c" });
    const { items } = await provider.listMessages({
      mailboxId: FLAGGED_VIEW_ID,
      limit: 10,
    });
    expect(items.map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(
      graph.requests("GET", /^me\/messages$/)[0]?.query.get("$filter"),
    ).toBe(
      "receivedDateTime ge 1900-01-01T00:00:00Z and flag/flagStatus eq 'flagged'",
    );
  });
});

describe("GraphProvider messages", () => {
  it("reads a whole message with attachments, inline images and unsubscribe", async () => {
    const { graph, provider } = setup();
    graph.add({
      id: "a",
      body: { contentType: "html", content: '<img src="cid:logo">' },
      ccRecipients: [{ emailAddress: { address: "cc@example.com" } }],
      internetMessageHeaders: [
        { name: "List-Unsubscribe", value: "<https://news.example/u>" },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        { name: "References", value: "<x@example.com> <y@example.com>" },
      ],
      attachments: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "att-1",
          name: "report.pdf",
          contentType: "application/pdf",
          size: 1234,
          isInline: false,
          bytes: "%PDF",
        },
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "att-2",
          name: "logo.png",
          contentType: "image/png",
          size: 10,
          isInline: true,
          contentId: "logo",
        },
        {
          "@odata.type": "#microsoft.graph.itemAttachment",
          id: "att-3",
          name: "Forwarded",
          size: 99,
        },
        {
          "@odata.type": "#microsoft.graph.referenceAttachment",
          id: "att-4",
          name: "Cloud link",
        },
      ],
    });
    const message = await provider.getMessage(id("a"));
    expect(message.body).toEqual({ html: '<img src="cid:logo">' });
    expect(message.cc).toEqual([{ address: "cc@example.com" }]);
    expect(message.internetMessageId).toBe("<a@example.com>");
    expect(message.references).toEqual(["<x@example.com>", "<y@example.com>"]);
    expect(message.unsubscribe).toEqual({
      oneClick: "https://news.example/u",
      page: "https://news.example/u",
    });
    expect(message.attachments).toEqual([
      {
        id: "att-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 1234,
      },
      {
        id: "att-2",
        filename: "logo.png",
        mimeType: "image/png",
        size: 10,
        contentId: "logo",
      },
      {
        id: "att-3",
        filename: "Forwarded.eml",
        mimeType: "message/rfc822",
        size: 99,
      },
    ]);
    const bytes = await provider.getAttachment(
      id("a"),
      asAttachmentId("att-1"),
    );
    expect(await bytes.text()).toBe("%PDF");
  });

  it("moves for archive, trash, spam and back, batched", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "a" });
    graph.add({ id: "b" }, "projects-id");
    const folderOf = (m: string) =>
      graph.messages.find((message) => message.id === m)?.parentFolderId;

    await provider.archive([id("a")]);
    expect(folderOf("a")).toBe("archive-id");
    await provider.unarchive([id("a")]);
    expect(folderOf("a")).toBe("inbox-id");
    await provider.trash([id("a"), id("b")]);
    expect([folderOf("a"), folderOf("b")]).toEqual(["trash-id", "trash-id"]);
    await provider.untrash([id("a")]);
    expect(folderOf("a")).toBe("inbox-id");
    await provider.reportSpam([id("a")]);
    expect(folderOf("a")).toBe("junk-id");
    await provider.notSpam([id("a")]);
    expect(folderOf("a")).toBe("inbox-id");
    await provider.move([id("b")], {
      from: box("trash-id"),
      to: box("projects-id"),
    });
    expect(folderOf("b")).toBe("projects-id");
    expect(
      graph.requests("POST", /\/move$/).every((request) => request.batched),
    ).toBe(true);

    const error = await failure(
      provider.move([id("a")], { from: box("inbox-id"), to: FLAGGED_VIEW_ID }),
    );
    expect(isMailError(error) && error.reason).toBe("notAFolder");
  });

  it("explains a missing Archive folder", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "a" });
    graph.folders.splice(
      graph.folders.findIndex((f) => f.id === "archive-id"),
      1,
    );
    delete graph.wellKnown.archive;
    const error = await failure(provider.archive([id("a")]));
    expect(isMailError(error) && error.reason).toBe("noArchiveFolder");
  });

  it("sets read and flag state", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "a" });
    await provider.setFlags([id("a")], { seen: true, flagged: true });
    expect(graph.messages[0]).toMatchObject({
      isRead: true,
      flag: { flagStatus: "flagged" },
    });
    await provider.setFlags([id("a")], { flagged: false });
    expect(graph.messages[0]?.flag).toEqual({ flagStatus: "notFlagged" });
    expect(graph.messages[0]?.isRead).toBe(true);
  });

  it("deletes forever and empties only Deleted Items and Junk", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "a" }, "deleteditems");
    graph.add({ id: "b" }, "deleteditems");
    graph.add({ id: "c" });
    await provider.deleteForever([id("c")]);
    expect(graph.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(await provider.emptyMailbox(box("trash-id"))).toEqual({
      deleted: 2,
    });
    expect(graph.messages).toEqual([]);
    const error = await failure(provider.emptyMailbox(box("inbox-id")));
    expect(isMailError(error) && error.reason).toBe("onlyTrashSpam");
  });
});

describe("GraphProvider drafts", () => {
  const file = (
    name: string,
    content: string,
    extra: Partial<OutgoingAttachment> = {},
  ): OutgoingAttachment => ({
    id: `local-${name}`,
    filename: name,
    mimeType: "text/plain",
    size: content.length,
    content: new Blob([content]),
    ...extra,
  });
  const base = {
    to: [{ name: "Anna", address: "anna@example.com" }],
    cc: [],
    bcc: [{ address: "secret@example.com" }],
    subject: "Plans",
    html: "<p>Hi</p>",
    text: "Hi",
    attachments: [],
  };

  it("creates, updates and sends a new mail, uploading each file once", async () => {
    const { graph, provider } = setup();
    const notes = file("notes.txt", "notes");
    const logo = file("logo.png", "png", {
      mimeType: "image/png",
      contentId: "logo1",
    });
    const saved = await provider.saveDraft({
      ...base,
      attachments: [notes, logo],
    });
    expect(saved.id).toBe(saved.messageId);
    const draft = graph.messages.find((m) => m.id === saved.id);
    expect(draft).toMatchObject({
      subject: "Plans",
      isDraft: true,
      parentFolderId: "drafts-id",
      body: { contentType: "html", content: "<p>Hi</p>" },
      bccRecipients: [{ emailAddress: { address: "secret@example.com" } }],
    });
    expect(
      draft?.attachments?.map((a) => [a.name, a.isInline, a.contentId]),
    ).toEqual([
      ["notes.txt", false, undefined],
      ["logo.png", true, "logo1"],
    ]);

    // Saving again changes the text and keeps the files without uploading them again.
    await provider.saveDraft({
      ...base,
      id: saved.id,
      subject: "Plans v2",
      attachments: [notes],
    });
    expect(graph.requests("POST", /\/attachments$/)).toHaveLength(2);
    expect(draft?.subject).toBe("Plans v2");
    expect(draft?.attachments?.map((a) => a.name)).toEqual(["notes.txt"]);

    await provider.sendDraft({ ...base, id: saved.id, attachments: [notes] });
    expect(draft).toMatchObject({ isDraft: false, parentFolderId: "sent-id" });
    expect(graph.requests("POST", /\/send$/)[0]?.body).toBeUndefined();
  });

  it("starts a reply from Outlook's createReply, so it stays in the conversation", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "orig", subject: "Question" });
    const saved = await provider.saveDraft({
      ...base,
      subject: "Re: Question",
      threading: {
        inReplyTo: "<orig@example.com>",
        references: ["<orig@example.com>"],
      },
    });
    expect(
      graph.requests("POST", /^me\/messages\/orig\/createReply$/),
    ).toHaveLength(1);
    const draft = await provider.getDraft(saved.id);
    expect(draft).toMatchObject({
      subject: "Re: Question",
      html: "<p>Hi</p>",
      to: [{ name: "Anna", address: "anna@example.com" }],
      bcc: [{ address: "secret@example.com" }],
      threading: { inReplyTo: "<orig@example.com>" },
    });
    expect(await provider.draftIdOf(saved.messageId)).toBe(saved.id);
    expect(await provider.draftIdOf(id("orig"))).toBeUndefined();
  });

  it("uploads big files in chunks through an upload session, without the token", async () => {
    const { graph, provider } = setup();
    // Two chunks: the attachment exists only once the last one arrived.
    const big = file("video.bin", "x".repeat(UPLOAD_CHUNK_BYTES + 10));
    const saved = await provider.saveDraft({ ...base, attachments: [big] });
    const draft = graph.messages.find((m) => m.id === saved.id);
    expect(draft?.attachments?.map((a) => [a.name, a.size])).toEqual([
      ["video.bin", UPLOAD_CHUNK_BYTES + 10],
    ]);
    await provider.saveDraft({ ...base, id: saved.id, attachments: [big] });
    expect(
      graph.requests("POST", /\/attachments\/createUploadSession$/),
    ).toHaveLength(1);
  });

  it("says whether the upload server didn't answer or the connection dropped", async () => {
    const { graph, provider } = setup();
    const big = file("video.bin", "x".repeat(UPLOAD_CHUNK_BYTES + 10));
    graph.failUploadAt = 0;
    const blocked = await failure(
      provider.saveDraft({ ...base, attachments: [big] }),
    );
    expect(isMailError(blocked) && blocked.reason).toBe(
      "attachmentUploadBlocked",
    );
    graph.failUploadAt = UPLOAD_CHUNK_BYTES;
    const dropped = await failure(
      provider.saveDraft({ ...base, attachments: [big] }),
    );
    expect(isMailError(dropped) && dropped.reason).toBe(
      "attachmentUploadInterrupted",
    );
    expect(isMailError(dropped) && dropped.params).toEqual({
      name: "video.bin",
    });
  });

  it("forwards keep files of the original: fetched, then uploaded", async () => {
    const { graph, provider } = setup();
    graph.add({
      id: "orig",
      attachments: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "att-9",
          name: "plan.txt",
          contentType: "text/plain",
          size: 4,
          bytes: "plan",
        },
      ],
    });
    const saved = await provider.saveDraft({
      ...base,
      attachments: [
        {
          id: "orig/att-9",
          filename: "plan.txt",
          mimeType: "text/plain",
          size: 4,
          source: {
            messageId: id("orig"),
            attachmentId: asAttachmentId("att-9"),
          },
        },
      ],
    });
    const draft = graph.messages.find((m) => m.id === saved.id);
    expect(draft?.attachments?.map((a) => a.bytes)).toEqual(["plan"]);
  });

  it("deletes drafts", async () => {
    const { graph, provider } = setup();
    const saved = await provider.saveDraft(base);
    await provider.deleteDraft(asDraftId(saved.id));
    expect(graph.messages).toEqual([]);
  });
});

describe("GraphProvider live updates", () => {
  it("reports new, changed, moved and deleted mail between polls", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "old" });
    graph.add({ id: "gone" });
    const start = await provider.changesSince(undefined);
    expect(start).toMatchObject({ reset: false, changes: [] });

    graph.add({ id: "new", createdDateTime: "2026-10-18T12:00:30Z" });
    graph.change("old", { parentFolderId: "projects-id" });
    graph.remove("gone");
    const next = await provider.changesSince(start.token);
    expect(next.reset).toBe(false);
    const byId = new Map(
      next.changes.map((change) => [
        change.kind === "removed" ? change.id : change.message.id,
        change,
      ]),
    );
    expect(byId.get(id("new"))?.kind).toBe("added");
    const moved = byId.get(id("old"));
    expect(moved?.kind).toBe("updated");
    expect(moved?.kind === "updated" && moved.message.mailboxIds).toEqual([
      "projects-id",
    ]);
    expect(byId.get(id("gone"))?.kind).toBe("removed");

    // Nothing new: nothing reported.
    const quiet = await provider.changesSince(next.token);
    expect(quiet.changes).toEqual([]);
  });

  it("follows new folders and starts over on a token it can't read", async () => {
    const { graph, provider } = setup();
    const start = await provider.changesSince(undefined);
    graph.addFolder("travel-id", "Travel");
    const afterFolder = await provider.changesSince(start.token);
    graph.add(
      { id: "trip", createdDateTime: "2026-10-18T12:00:30Z" },
      "travel-id",
    );
    const afterMail = await provider.changesSince(afterFolder.token);
    expect(afterMail.changes.map((c) => c.kind)).toEqual(["added"]);

    const reset = await provider.changesSince(asSyncToken("nonsense"));
    expect(reset).toMatchObject({ reset: true, changes: [] });
  });
});

describe("GraphProvider folders", () => {
  it("creates, renames, moves and deletes folders", async () => {
    const { graph, provider } = setup();
    const created = await provider.createMailbox({
      name: " Travel ",
      parentId: box("inbox-id"),
    });
    expect(created).toMatchObject({
      name: "Travel",
      kind: "folder",
      parentId: "inbox-id",
    });
    const duplicate = await failure(
      provider.createMailbox({ name: "Travel", parentId: box("inbox-id") }),
    );
    expect(isMailError(duplicate) && duplicate.reason).toBe("folderExists");
    const empty = await failure(provider.createMailbox({ name: "  " }));
    expect(isMailError(empty) && empty.reason).toBe("folderNeedsName");

    const renamed = await provider.updateMailbox(created.id, { name: "Trips" });
    expect(renamed.name).toBe("Trips");
    const top = await provider.updateMailbox(created.id, { parentId: null });
    expect(top.parentId).toBeUndefined();

    await provider.deleteMailbox(created.id);
    expect(graph.folders.find((f) => f.id === created.id)?.parentFolderId).toBe(
      "trash-id",
    );
    // Deleting it again from Deleted Items deletes it for good.
    await provider.deleteMailbox(created.id);
    expect(graph.folders.find((f) => f.id === created.id)).toBeUndefined();

    const system = await failure(provider.deleteMailbox(box("inbox-id")));
    expect(isMailError(system) && system.reason).toBe("systemMailbox");
  });
});

describe("GraphProvider categories", () => {
  /** Two categories and three messages, one in Archive. */
  function withCategories() {
    const context = setup();
    const { graph } = context;
    graph.categories.push(
      { id: "c1", displayName: "Team", color: "preset7" },
      { id: "c2", displayName: "Bob's", color: "none" },
    );
    graph.add({ id: "a", categories: ["Team"], isRead: false });
    graph.add({
      id: "b",
      categories: ["Team", "Bob's"],
      isRead: true,
      receivedDateTime: "2026-10-18T11:00:00Z",
    });
    graph.add(
      {
        id: "c",
        categories: ["Team"],
        receivedDateTime: "2026-10-17T10:00:00Z",
      },
      "archive",
    );
    graph.add({ id: "d" });
    return context;
  }

  it("lists them as coloured labels in their own group, with unread counts", async () => {
    const { provider } = withCategories();
    const mailboxes = await provider.listMailboxes();
    const group = mailboxes.find((m) => m.standard === "categories");
    expect(group).toMatchObject({ kind: "view", selectable: false });
    const categories = mailboxes.filter((m) => m.parentId === group?.id);
    expect(
      categories.map((m) => [m.name, m.kind, m.color?.background ?? null]),
    ).toEqual([
      ["Bob's", "label", null],
      ["Team", "label", "#4cb4e7"],
    ]);
    expect(categories.map((m) => m.counts?.unread)).toEqual([0, 2]);
    expect(provider.capabilities.mailboxEditing.label).toMatchObject({
      rename: false,
      nest: false,
    });
  });

  it("does without them while the permission is missing", async () => {
    const { graph, provider } = withCategories();
    graph.failures.set("GET me/outlook/masterCategories", 403);
    const mailboxes = await provider.listMailboxes();
    expect(mailboxes.some((m) => m.standard === "categories")).toBe(false);
    expect(mailboxes.some((m) => m.role === "inbox")).toBe(true);
  });

  it("puts the folder first in a message's mailboxes, then its categories", async () => {
    const { provider } = withCategories();
    const team = (await provider.listMailboxes()).find(
      (m) => m.name === "Team",
    );
    const { items } = await provider.listMessages({
      mailboxId: box("inbox-id"),
      limit: 10,
    });
    expect(items.find((m) => m.id === "b")?.mailboxIds[0]).toBe("inbox-id");
    expect(items.find((m) => m.id === "b")?.mailboxIds).toContain(team?.id);
  });

  it("lists a category's mail from every folder, and searches inside it", async () => {
    const { provider } = withCategories();
    const mailboxes = await provider.listMailboxes();
    const team = mailboxes.find((m) => m.name === "Team");
    const bobs = mailboxes.find((m) => m.name === "Bob's");
    if (!team || !bobs) throw new Error("no categories");
    const all = await provider.listMessages({ mailboxId: team.id, limit: 10 });
    expect(all.items.map((m) => m.id)).toEqual(["b", "a", "c"]);
    // Quotes in names are escaped in the filter.
    const quoted = await provider.listMessages({
      mailboxId: bobs.id,
      limit: 10,
    });
    expect(quoted.items.map((m) => m.id)).toEqual(["b"]);
    const searched = await provider.listMessages({
      mailboxId: bobs.id,
      search: "a",
      limit: 10,
    });
    expect(searched.items.map((m) => m.id)).toEqual([]);
  });

  it("adds and removes categories, keeping the others", async () => {
    const { graph, provider } = withCategories();
    const mailboxes = await provider.listMailboxes();
    const team = mailboxes.find((m) => m.name === "Team");
    const bobs = mailboxes.find((m) => m.name === "Bob's");
    if (!team || !bobs) throw new Error("no categories");
    await provider.setLabels([id("a"), id("b")], {
      add: [bobs.id],
      remove: [team.id],
    });
    expect(graph.messages.find((m) => m.id === "a")?.categories).toEqual([
      "Bob's",
    ]);
    expect(graph.messages.find((m) => m.id === "b")?.categories).toEqual([
      "Bob's",
    ]);
    const folder = await failure(
      provider.setLabels([id("a")], { add: [box("projects-id")], remove: [] }),
    );
    expect(isMailError(folder) && folder.reason).toBe("notACategory");
  });

  it("creates, recolours and deletes categories, but can't rename them", async () => {
    const { graph, provider } = withCategories();
    const { OUTLOOK_CATEGORY_COLORS } = await import("./folders");
    const red = OUTLOOK_CATEGORY_COLORS[0];
    const created = await provider.createMailbox({
      name: " Urgent ",
      kind: "label",
      ...(red ? { color: red } : {}),
    });
    expect(created).toMatchObject({ name: "Urgent", kind: "label" });
    expect(graph.categories.at(-1)).toMatchObject({
      displayName: "Urgent",
      color: "preset0",
    });
    const duplicate = await failure(
      provider.createMailbox({ name: "Urgent", kind: "label" }),
    );
    expect(isMailError(duplicate) && duplicate.reason).toBe("categoryExists");

    const blue = OUTLOOK_CATEGORY_COLORS[7];
    await provider.updateMailbox(created.id, blue ? { color: blue } : {});
    expect(graph.categories.at(-1)?.color).toBe("preset7");
    const renamed = await failure(
      provider.updateMailbox(created.id, { name: "Later" }),
    );
    expect(isMailError(renamed) && renamed.reason).toBe("categoryRename");

    await provider.deleteMailbox(created.id);
    expect(graph.categories.map((c) => c.displayName)).toEqual([
      "Team",
      "Bob's",
    ]);
    // Like Outlook: mail keeps the name.
    await provider.deleteMailbox(
      (await provider.listMailboxes()).find((m) => m.name === "Team")?.id ??
        box("x"),
    );
    expect(graph.messages.find((m) => m.id === "a")?.categories).toEqual([
      "Team",
    ]);
  });
});

describe("GraphProvider people, senders and signatures", () => {
  it("suggests people and says when the list isn't available", async () => {
    const { graph, provider } = setup();
    graph.people.push({
      displayName: "Sophie Wagner",
      address: "sophie@example.com",
    });
    expect(await provider.searchContacts("soph")).toEqual([
      { name: "Sophie Wagner", address: "sophie@example.com" },
    ]);
    graph.failures.set("GET me/people", 403);
    const error = await failure(provider.searchContacts("soph"));
    expect(isMailError(error, "unavailable") && error.reason).toBe(
      "peopleUnavailable",
    );
  });

  it("sends from the account's address and keeps signatures in the browser", async () => {
    const { provider, settings } = setup();
    expect(await provider.listSenders()).toEqual([
      {
        address: "max@contoso.com",
        name: "Max Muster",
        isDefault: true,
        signature: "",
      },
    ]);
    await provider.updateSignature("Max@Contoso.com", "<p>Max</p>");
    expect((await provider.listSenders())[0]?.signature).toBe("<p>Max</p>");
    expect(settings.getItem("a0.signatures.test")).toContain("<p>Max</p>");
  });

  it("allows 20 MB of files for personal accounts, 25 MB otherwise", () => {
    expect(setup().provider.capabilities.maxAttachmentBytes).toBe(
      25 * 1024 * 1024,
    );
    expect(
      setup({ personal: true }).provider.capabilities.maxAttachmentBytes,
    ).toBe(20 * 1024 * 1024);
  });
});

describe("GraphProvider conversations", () => {
  /** Anna's conversation: Inbox, your reply in Sent Items, Inbox again. */
  function conversations(graph: FakeGraph) {
    graph.add({
      id: "a1",
      conversationId: "conv-a",
      receivedDateTime: "2026-10-10T10:00:00Z",
    });
    graph.add(
      {
        id: "a2",
        conversationId: "conv-a",
        subject: "Re: a",
        receivedDateTime: "2026-10-12T10:00:00Z",
      },
      "sentitems",
    );
    graph.add({
      id: "a3",
      conversationId: "conv-a",
      receivedDateTime: "2026-10-14T10:00:00Z",
    });
    graph.add({
      id: "b1",
      conversationId: "conv-b",
      receivedDateTime: "2026-10-13T10:00:00Z",
      flag: { flagStatus: "flagged" },
    });
    graph.add({
      id: "c1",
      conversationId: "conv-c",
      receivedDateTime: "2026-10-11T10:00:00Z",
    });
  }
  const ids = (page: {
    items: readonly { id: string; messages: readonly { id: string }[] }[];
  }) =>
    page.items.map((thread) => [
      thread.id,
      thread.messages.map((m) => m.id).join(","),
    ]);

  it("lists each conversation once, newest first, with its messages from every folder", async () => {
    const { graph, provider } = setup();
    conversations(graph);
    // Inbox by date: a3, b1, c1, a1.
    const first = await provider.listThreads({
      mailboxId: box("inbox-id"),
      limit: 2,
    });
    expect(ids(first)).toEqual([
      ["conv-a", "a1,a2,a3"],
      ["conv-b", "b1"],
    ]);
    // a1 is on the next page, but conv-a was already shown with a3.
    const second = await provider.listThreads({
      mailboxId: box("inbox-id"),
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(ids(second)).toEqual([["conv-c", "c1"]]);
    expect(second.nextCursor).toBeUndefined();
    // Conversations are fetched batched, without sorting (Graph refuses that).
    expect(graph.requests("GET", /^me\/messages$/).length).toBeGreaterThan(0);
    expect(
      graph
        .requests("GET", /^me\/messages$/)
        .every((request) => request.batched && !request.query.has("$orderby")),
    ).toBe(true);
  });

  it("lists the conversations of Sent Items and of the Flagged view", async () => {
    const { graph, provider } = setup();
    conversations(graph);
    const sent = await provider.listThreads({
      mailboxId: box("sent-id"),
      limit: 10,
    });
    expect(ids(sent)).toEqual([["conv-a", "a1,a2,a3"]]);
    const flagged = await provider.listThreads({
      mailboxId: FLAGGED_VIEW_ID,
      limit: 10,
    });
    expect(ids(flagged)).toEqual([["conv-b", "b1"]]);
  });

  it("sorts search results and oldest first by conversation, also after a reload", async () => {
    const { graph, provider, another } = setup();
    conversations(graph);
    const oldest = await provider.listThreads({
      mailboxId: box("inbox-id"),
      order: "oldest",
      limit: 1,
    });
    // By each conversation's newest Inbox message: c1 (11th), b1 (13th), a3 (14th).
    expect(ids(oldest)).toEqual([["conv-c", "c1"]]);
    // A fresh provider (a reload) continues where the cursor points.
    const next = await another().listThreads({
      mailboxId: box("inbox-id"),
      order: "oldest",
      limit: 2,
      ...(oldest.nextCursor ? { cursor: oldest.nextCursor } : {}),
    });
    expect(ids(next).map(([thread]) => thread)).toEqual(["conv-b", "conv-a"]);

    const found = await provider.listThreads({
      mailboxId: ALL_VIEW_ID,
      search: "re: a",
      limit: 10,
    });
    expect(ids(found)).toEqual([["conv-a", "a1,a2,a3"]]);
  });

  it("opens a whole conversation with bodies and attachments, oldest first", async () => {
    const { graph, provider } = setup();
    conversations(graph);
    const attached = graph.messages.find((m) => m.id === "a2");
    if (attached)
      attached.attachments = [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "att-1",
          name: "plan.pdf",
          contentType: "application/pdf",
          size: 3,
        },
      ];
    const thread = await provider.getThread(asThreadId("conv-a"));
    expect(thread.messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect(thread.messages[0]?.body).toEqual({ html: "<p>a1</p>" });
    expect(thread.messages[1]?.attachments.map((a) => a.filename)).toEqual([
      "plan.pdf",
    ]);
    expect(provider.capabilities.threads).toBe(true);
  });
});

describe("GraphProvider invitations", () => {
  it("reads which event an Outlook invitation is about", async () => {
    const { graph, provider } = setup();
    graph.add({ id: "invite", subject: "Planning" });
    graph.add({ id: "plain" });
    server.use(
      // Outlook's invitations are event messages, with their event.
      http.get(`${GRAPH_BASE}me/messages/invite`, () =>
        HttpResponse.json({
          id: "invite",
          "@odata.type": "#microsoft.graph.eventMessageRequest",
          subject: "Planning",
          parentFolderId: "inbox-id",
        }),
      ),
      http.get(
        `${GRAPH_BASE}me/messages/invite/microsoft.graph.eventMessage`,
        () =>
          HttpResponse.json({
            id: "invite",
            meetingMessageType: "meetingRequest",
            event: { iCalUId: "planning@contoso.com" },
          }),
      ),
    );
    expect((await provider.getMessage(id("invite"))).invitation).toEqual({
      uid: "planning@contoso.com",
      method: "request",
    });
    expect((await provider.getMessage(id("plain"))).invitation).toBeUndefined();
  });
});
