// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isMailError } from "../../core/errors";
import {
  asAttachmentId,
  asMessageId,
  asThreadId,
  type Cursor,
  type MailboxId,
} from "../../core/ids";
import { createFolderData, FOLDER } from "../../test/folderData";
import { createDemoArrival, createDemoData, DEMO_MAILBOX } from "./demoData";
import { FakeMailProvider } from "./FakeMailProvider";

const provider = () =>
  new FakeMailProvider(createDemoData(Date.parse("2026-10-18T12:00:00Z")));

describe("FakeMailProvider", () => {
  it("pages through a mailbox newest first", async () => {
    const fake = provider();
    const first = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.inbox,
      limit: 50,
    });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.id).toBe("welcome");
    const dates = first.items.map((m) => m.receivedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    const second = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.inbox,
      limit: 50,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("searches plain words in subject, snippet and addresses", async () => {
    const fake = provider();
    const search = async (text: string) =>
      (
        await fake.listMessages({
          mailboxId: DEMO_MAILBOX.all,
          search: text,
          limit: 500,
        })
      ).items.map((m) => m.subject);

    expect(await search("WEEKEND packing")).toEqual([
      "Packing list for the weekend",
    ]);
    expect(await search("billing@shop")).toContain("Your invoice 2026-1043");
    expect(await search("Cafe")).toEqual(await search("café"));
    // No operators: this is just text that doesn't occur.
    expect(await search("from:billing")).toEqual([]);
  });

  it("lists oldest first on request, across pages", async () => {
    const fake = provider();
    const all = async (order: "newest" | "oldest") => {
      const ids: string[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await fake.listMessages({
          mailboxId: DEMO_MAILBOX.all,
          order,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.items.map((m) => m.id));
        cursor = page.nextCursor;
      } while (cursor);
      return ids;
    };
    const newest = await all("newest");
    expect(newest.length).toBeGreaterThan(100);
    expect(await all("oldest")).toEqual([...newest].reverse());
  });

  it("returns summaries without bodies from list calls", async () => {
    const { items } = await provider().listMessages({
      mailboxId: DEMO_MAILBOX.inbox,
      limit: 1,
    });
    expect(items[0]).not.toHaveProperty("body");
  });

  it("computes views and counts like a real provider", async () => {
    const fake = provider();
    const all = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.all,
      limit: 500,
    });
    expect(
      all.items.some((m) => m.mailboxIds.includes(DEMO_MAILBOX.spam)),
    ).toBe(false);
    const starred = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.starred,
      limit: 500,
    });
    expect(starred.items.every((m) => m.flags.flagged)).toBe(true);
    const mailboxes = await fake.listMailboxes();
    expect(mailboxes.find((m) => m.id === DEMO_MAILBOX.spam)?.counts).toEqual({
      total: 1,
      unread: 1,
    });
  });

  it("reports missing messages and attachments as not-found", async () => {
    const fake = provider();
    expect(
      isMailError(
        await fake.getMessage(asMessageId("nope")).catch((e: unknown) => e),
        "not-found",
      ),
    ).toBe(true);
    const logo = await fake.getAttachment(
      asMessageId("inline-image"),
      asAttachmentId("logo"),
    );
    expect(logo.type).toBe("image/svg+xml");
  });

  it("applies writes to later reads", async () => {
    const fake = provider();
    const welcome = asMessageId("welcome");
    await fake.archive([welcome]);
    const inbox = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.inbox,
      limit: 500,
    });
    expect(inbox.items.some((m) => m.id === welcome)).toBe(false);
    await fake.unarchive([welcome]);
    await fake.setFlags([welcome], { seen: true });
    const message = await fake.getMessage(welcome);
    expect(message.mailboxIds).toContain(DEMO_MAILBOX.inbox);
    expect(message.flags.seen).toBe(true);
  });

  it("can be told to fail writes", async () => {
    const fake = new FakeMailProvider(createDemoData(0), { failWrites: true });
    const error: unknown = await fake
      .archive([asMessageId("welcome")])
      .catch((e: unknown) => e);
    expect(isMailError(error, "provider")).toBe(true);
    const inbox = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.inbox,
      limit: 1,
    });
    expect(inbox.items[0]?.id).toBe("welcome");
  });

  it("moves and relabels like a label-based provider", async () => {
    const fake = provider();
    const welcome = asMessageId("welcome");
    await fake.move([welcome], {
      from: DEMO_MAILBOX.inbox,
      to: DEMO_MAILBOX.work,
    });
    expect((await fake.getMessage(welcome)).mailboxIds).toEqual([
      DEMO_MAILBOX.work,
    ]);
    await fake.move([welcome], {
      from: DEMO_MAILBOX.all,
      to: DEMO_MAILBOX.personal,
    });
    expect((await fake.getMessage(welcome)).mailboxIds).toEqual([
      DEMO_MAILBOX.work,
      DEMO_MAILBOX.personal,
    ]);
    await fake.setLabels([welcome], {
      add: [DEMO_MAILBOX.inbox],
      remove: [DEMO_MAILBOX.work],
    });
    expect((await fake.getMessage(welcome)).mailboxIds).toEqual([
      DEMO_MAILBOX.personal,
      DEMO_MAILBOX.inbox,
    ]);
  });

  it("hides trashed and spam messages from other lists, and empties Trash", async () => {
    const fake = provider();
    const plain = asMessageId("plain-text");
    await fake.trash([plain]);
    const personal = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.personal,
      limit: 500,
    });
    expect(personal.items.some((m) => m.id === plain)).toBe(false);
    const trash = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.trash,
      limit: 500,
    });
    expect(trash.items.map((m) => m.id)).toContain(plain);

    await expect(fake.emptyMailbox(DEMO_MAILBOX.trash)).resolves.toEqual({
      deleted: 2,
    });
    expect(
      isMailError(
        await fake.getMessage(plain).catch((e: unknown) => e),
        "not-found",
      ),
    ).toBe(true);
    await expect(fake.emptyMailbox(DEMO_MAILBOX.inbox)).rejects.toMatchObject({
      code: "provider",
    });
  });
});

describe("FakeMailProvider drafts and sending", () => {
  const draft = {
    to: [{ address: "anna.berger@example.org" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    html: "<p>Hello there</p>",
    text: "Hello there",
    attachments: [],
  };

  it("keeps drafts in Drafts, with a new message on every save", async () => {
    const fake = provider();
    const first = await fake.saveDraft(draft);
    const second = await fake.saveDraft({
      ...draft,
      id: first.id,
      subject: "Hello again",
    });
    expect(second.id).toBe(first.id);
    expect(second.messageId).not.toBe(first.messageId);
    const { items } = await fake.listMessages({
      mailboxId: DEMO_MAILBOX.drafts,
      limit: 50,
    });
    expect(items.map((m) => m.subject)).toContain("Hello again");
    expect(items.map((m) => m.id)).not.toContain(first.messageId);
    expect(await fake.draftIdOf(second.messageId)).toBe(first.id);
    expect(await fake.getDraft(first.id)).toMatchObject({
      subject: "Hello again",
      html: "<p>Hello there</p>",
    });

    await fake.deleteDraft(first.id);
    await expect(fake.getDraft(first.id)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("sends into Sent, and mail to yourself also into the Inbox", async () => {
    const fake = provider();
    const { id } = await fake.saveDraft(draft);
    await fake.sendDraft({ ...draft, id });
    const self = await fake.saveDraft({
      ...draft,
      to: [{ address: "demo@example.com" }],
      subject: "Note to self",
    });
    await fake.sendDraft({
      ...draft,
      id: self.id,
      to: [{ address: "demo@example.com" }],
      subject: "Note to self",
    });
    const subjects = async (mailboxId: typeof DEMO_MAILBOX.sent) =>
      (await fake.listMessages({ mailboxId, limit: 50 })).items.map(
        (m) => m.subject,
      );
    expect(await subjects(DEMO_MAILBOX.sent)).toEqual(
      expect.arrayContaining(["Hello", "Note to self"]),
    );
    expect(await subjects(DEMO_MAILBOX.inbox)).toContain("Note to self");
    expect(await subjects(DEMO_MAILBOX.inbox)).not.toContain("Hello");
    expect(await subjects(DEMO_MAILBOX.drafts)).not.toContain("Hello");
  });

  it("carries forwarded parts along", async () => {
    const fake = provider();
    const { id, messageId } = await fake.saveDraft({
      ...draft,
      attachments: [
        {
          id: "logo",
          filename: "logo-draft.svg",
          mimeType: "image/svg+xml",
          size: 10,
          source: {
            messageId: asMessageId("inline-image"),
            attachmentId: asAttachmentId("logo"),
          },
        },
        {
          id: "mine",
          filename: "notes.txt",
          mimeType: "text/plain",
          size: 2,
          content: new Blob(["hi"]),
        },
      ],
    });
    const saved = await fake.getDraft(id);
    const [part, mine] = saved.attachments;
    expect(part).toMatchObject({
      filename: "logo-draft.svg",
      source: { messageId },
    });
    const blob = await fake.getAttachment(
      messageId,
      part?.source?.attachmentId ?? asAttachmentId(""),
    );
    expect(mine?.filename).toBe("notes.txt");
    expect(await blob.text()).toContain("<svg");
  });

  it("suggests contacts, or reports them unavailable", async () => {
    const fake = provider();
    expect(fake.capabilities.contacts).toBe(true);
    expect(await fake.searchContacts("ann")).toEqual([
      { name: "Anna Berger", address: "anna.berger@example.org" },
    ]);
    fake.contactsUnavailable = true;
    await expect(fake.searchContacts("ann")).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("FakeMailProvider.changesSince", () => {
  it("reports writes since the token", async () => {
    const fake = provider();
    const start = await fake.changesSince(undefined);
    await fake.archive([asMessageId("welcome")]);
    await fake.deleteForever([asMessageId("trash-1")]);
    const set = await fake.changesSince(start.token);
    expect(
      set.changes.map((c) =>
        c.kind === "removed" ? `removed:${c.id}` : `${c.kind}:${c.message.id}`,
      ),
    ).toEqual(["updated:welcome", "removed:trash-1"]);
    expect((await fake.changesSince(set.token)).changes).toEqual([]);
  });

  it("lets demo mail arrive when it's due", async () => {
    let now = 0;
    const fake = new FakeMailProvider(createDemoData(0), {
      now: () => now,
      arrivals: { everyMs: 60_000, create: createDemoArrival },
    });
    const start = await fake.changesSince(undefined);
    now = 30_000;
    expect((await fake.changesSince(start.token)).changes).toEqual([]);
    now = 61_000;
    const set = await fake.changesSince(start.token);
    expect(set.changes).toEqual([
      expect.objectContaining({
        kind: "added",
        message: expect.objectContaining({
          mailboxIds: [DEMO_MAILBOX.inbox],
          flags: { seen: false, flagged: false },
        }) as unknown,
      }),
    ]);
  });
});

describe("FakeMailProvider label management", () => {
  const names = async (fake: FakeMailProvider) =>
    (await fake.listMailboxes())
      .filter((m) => m.assignable && m.role === undefined)
      .map((m) => m.name);

  it("creates labels in order, nested and coloured", async () => {
    const fake = provider();
    const [color] = fake.capabilities.mailboxEditing.label?.colors ?? [];
    const created = await fake.createMailbox({
      name: " Hobbies ",
      ...(color ? { color } : {}),
    });
    expect(created).toMatchObject({ name: "Hobbies", hidden: false, color });
    const nested = await fake.createMailbox({
      name: "2026",
      parentId: DEMO_MAILBOX.work,
    });
    expect(nested.parentId).toBe(DEMO_MAILBOX.work);
    expect(await names(fake)).toEqual([
      "Archive 2019",
      "Hobbies",
      "Personal",
      "Receipts",
      "Work",
      "2026",
      "Clients",
      "Internal",
    ]);
    await expect(fake.createMailbox({ name: "work" })).rejects.toThrow(
      "There’s already a label called “work”.",
    );
    await expect(
      fake.createMailbox({ name: "x", parentId: DEMO_MAILBOX.inbox }),
    ).rejects.toThrow("System mailboxes can’t be changed.");
  });

  it("renames, moves, recolours and hides", async () => {
    const fake = provider();
    await fake.updateMailbox(DEMO_MAILBOX.clients, {
      name: "Customers",
      parentId: null,
      color: null,
      hidden: true,
    });
    const customers = (await fake.listMailboxes()).find(
      (m) => m.id === DEMO_MAILBOX.clients,
    );
    expect(customers).toMatchObject({ name: "Customers", hidden: true });
    expect(customers?.parentId).toBeUndefined();
    await expect(
      fake.updateMailbox(DEMO_MAILBOX.work, {
        parentId: DEMO_MAILBOX.internal,
      }),
    ).rejects.toThrow("A label can’t go inside itself.");
  });

  it("deletes a label: messages lose it, nested labels move up", async () => {
    const fake = provider();
    const { token } = await fake.changesSince(undefined);
    await fake.deleteMailbox(DEMO_MAILBOX.work);
    const mailboxes = await fake.listMailboxes();
    expect(mailboxes.some((m) => m.id === DEMO_MAILBOX.work)).toBe(false);
    expect(
      mailboxes.find((m) => m.id === DEMO_MAILBOX.clients)?.parentId,
    ).toBeUndefined();
    const logo = await fake.getMessage(asMessageId("inline-image"));
    expect(logo.mailboxIds).toEqual([DEMO_MAILBOX.inbox]);
    const { changes } = await fake.changesSince(token);
    expect(changes.map((change) => change.kind)).toContain("updated");
    await expect(fake.deleteMailbox(DEMO_MAILBOX.sent)).rejects.toThrow(
      "System mailboxes can’t be changed.",
    );
  });

  it("records one-click unsubscribes instead of going online", async () => {
    const fake = provider();
    const newsletter = await fake.getMessage(asMessageId("newsletter"));
    const url = newsletter.unsubscribe?.oneClick ?? "";
    await fake.oneClickUnsubscribe(url);
    expect(fake.oneClickRequests).toEqual([url]);
  });
});

describe("FakeMailProvider senders", () => {
  it("lists the demo's addresses and saves signatures", async () => {
    const fake = provider();
    const senders = await fake.listSenders();
    expect(senders.map((sender) => sender.address)).toEqual([
      "demo@example.com",
      "team@example.com",
    ]);
    await fake.updateSignature("team@example.com", "<div>New</div>");
    expect((await fake.listSenders())[1]?.signature).toBe("<div>New</div>");
    fake.signaturesReadOnly = true;
    await expect(
      fake.updateSignature("team@example.com", "x"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("FakeMailProvider threads", () => {
  it("groups the Inbox into conversations, with your replies inside", async () => {
    const fake = provider();
    const page = await fake.listThreads({
      mailboxId: DEMO_MAILBOX.inbox,
      limit: 10,
    });
    const trip = page.items.find((thread) => thread.id === "t-trip");
    expect(trip?.messages.map((m) => m.id)).toEqual([
      "trip-1",
      "trip-2",
      "trip-3",
    ]);
    const full = await fake.getThread(asThreadId("t-trip"));
    expect(full.messages[2]?.attachments[0]?.filename).toBe("tickets.pdf");
  });

  it("moves a conversation up when you answer it", async () => {
    const fake = provider();
    const ids = async () =>
      (
        await fake.listThreads({ mailboxId: DEMO_MAILBOX.inbox, limit: 10 })
      ).items.map((thread) => thread.id);
    expect((await ids()).indexOf(asThreadId("t-trip"))).toBeGreaterThan(0);
    const { id } = await fake.saveDraft({
      to: [{ address: "anna.berger@example.org" }],
      cc: [],
      bcc: [],
      subject: "Re: Trip to Lake Como",
      html: "<p>Great!</p>",
      text: "Great!",
      attachments: [],
      threading: { threadId: asThreadId("t-trip"), references: [] },
    });
    await fake.sendDraft({
      id,
      to: [{ address: "anna.berger@example.org" }],
      cc: [],
      bcc: [],
      subject: "Re: Trip to Lake Como",
      html: "<p>Great!</p>",
      text: "Great!",
      attachments: [],
      threading: { threadId: asThreadId("t-trip"), references: [] },
    });
    expect((await ids())[0]).toBe("t-trip");
  });
});

describe("FakeMailProvider.markAllRead", () => {
  /** Ids of the unread messages a mailbox lists, newest first. */
  async function unreadIn(fake: FakeMailProvider, mailboxId: MailboxId) {
    const { items } = await fake.listMessages({ mailboxId, limit: 1000 });
    return items.filter((m) => !m.flags.seen).map((m) => m.id);
  }

  it("marks the unread messages of a label read and returns their ids", async () => {
    const fake = provider();
    const work = await unreadIn(fake, DEMO_MAILBOX.work);
    const elsewhere = (await unreadIn(fake, DEMO_MAILBOX.inbox)).filter(
      (id) => !work.includes(id),
    );
    expect(work.length).toBeGreaterThan(0);
    expect(elsewhere.length).toBeGreaterThan(0);
    const start = await fake.changesSince(undefined);

    expect(await fake.markAllRead(DEMO_MAILBOX.work)).toEqual(work);
    expect(await unreadIn(fake, DEMO_MAILBOX.work)).toEqual([]);
    expect(await unreadIn(fake, DEMO_MAILBOX.inbox)).toEqual(elsewhere);
    const { changes } = await fake.changesSince(start.token);
    expect(
      changes.map((c) => (c.kind === "removed" ? c.id : c.message.id)),
    ).toEqual(expect.arrayContaining(work));
    expect(changes).toHaveLength(work.length);
  });

  it("leaves Spam and Trash alone when marking All Mail", async () => {
    const fake = provider();
    const all = await unreadIn(fake, DEMO_MAILBOX.all);
    const spam = await unreadIn(fake, DEMO_MAILBOX.spam);
    const trash = await unreadIn(fake, DEMO_MAILBOX.trash);
    expect(spam.length).toBeGreaterThan(0);
    expect(await fake.markAllRead(DEMO_MAILBOX.all)).toEqual(all);
    expect(await unreadIn(fake, DEMO_MAILBOX.all)).toEqual([]);
    expect(await unreadIn(fake, DEMO_MAILBOX.spam)).toEqual(spam);
    expect(await unreadIn(fake, DEMO_MAILBOX.trash)).toEqual(trash);
  });

  it("marks a folder or the Flagged view in folder mode", async () => {
    const fake = new FakeMailProvider(
      createFolderData(Date.parse("2026-10-18T12:00:00Z")),
    );
    const quarterly = asMessageId("quarterly");
    const kickoff = asMessageId("kickoff");
    const lunch = asMessageId("lunch");
    await fake.setFlags([quarterly, kickoff], { seen: false });
    expect(await fake.markAllRead(FOLDER.inbox)).toEqual([
      quarterly,
      asMessageId("plan-3"),
    ]);
    expect(await unreadIn(fake, FOLDER.projects)).toEqual([kickoff]);

    await fake.setFlags([kickoff, lunch], { seen: false, flagged: true });
    await fake.trash([lunch]);
    expect(await fake.markAllRead(FOLDER.flagged)).toEqual([kickoff]);
    expect(await unreadIn(fake, FOLDER.trash)).toEqual([lunch]);
  });

  it("changes nothing when writes fail", async () => {
    const fake = provider();
    const before = await unreadIn(fake, DEMO_MAILBOX.inbox);
    fake.failWrites = true;
    await expect(fake.markAllRead(DEMO_MAILBOX.inbox)).rejects.toMatchObject({
      code: "provider",
    });
    expect(await unreadIn(fake, DEMO_MAILBOX.inbox)).toEqual(before);
  });
});
