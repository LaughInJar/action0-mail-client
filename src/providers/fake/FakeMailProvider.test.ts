// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isMailError } from "../../core/errors";
import { asAttachmentId, asMessageId, type Cursor } from "../../core/ids";
import { createDemoData, DEMO_MAILBOX } from "./demoData";
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
    forwarded: [],
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
      forwarded: [
        {
          messageId: asMessageId("inline-image"),
          attachmentId: asAttachmentId("logo"),
          filename: "logo-draft.svg",
          mimeType: "image/svg+xml",
          size: 10,
        },
      ],
    });
    const saved = await fake.getDraft(id);
    const [part] = saved.forwarded;
    expect(part).toMatchObject({ messageId, filename: "logo-draft.svg" });
    const blob = await fake.getAttachment(
      messageId,
      part?.attachmentId ?? asAttachmentId(""),
    );
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
