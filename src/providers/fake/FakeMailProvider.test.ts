// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isMailError } from "../../core/errors";
import { asAttachmentId, asMessageId } from "../../core/ids";
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
