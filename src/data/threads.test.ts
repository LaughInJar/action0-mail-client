// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asMailboxId, asMessageId, asThreadId } from "../core/ids";
import type { Mailbox, MessageSummary, ThreadSummary } from "../core/model";
import { rowsLeaving, threadRows } from "./listRows";
import {
  applyServerChangesToThreads,
  isolatingMailboxes,
  patchThreadList,
  threadBelongsTo,
  type MessageChange,
  type ThreadListData,
} from "./optimistic";

const box = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id: asMailboxId(id),
  name: id,
  kind: "label",
  selectable: true,
  hidden: false,
  assignable: true,
  ...extra,
});
const inbox = box("inbox", { role: "inbox" });
const sent = box("sent", { role: "sent" });
const trash = box("trash", { role: "trash" });
const isolating = isolatingMailboxes([inbox, sent, trash]);

function message(
  id: string,
  thread: string,
  minutesAgo: number,
  mailboxIds: string[],
): MessageSummary {
  return {
    id: asMessageId(id),
    threadId: asThreadId(thread),
    mailboxIds: mailboxIds.map(asMailboxId),
    to: [],
    subject: id,
    snippet: id,
    receivedAt: new Date(
      Date.parse("2026-10-18T12:00:00Z") - minutesAgo * 60_000,
    ).toISOString(),
    flags: { seen: true, flagged: false },
    hasAttachments: false,
  };
}

// t1: Anna asks (Inbox), I answer (Sent); t2: one Inbox message.
const a1 = message("a1", "t1", 30, ["inbox"]);
const a2 = message("a2", "t1", 20, ["sent"]);
const b1 = message("b1", "t2", 10, ["inbox"]);
const t1: ThreadSummary = { id: asThreadId("t1"), messages: [a1, a2] };
const t2: ThreadSummary = { id: asThreadId("t2"), messages: [b1] };

const list = (...threads: ThreadSummary[]): ThreadListData => ({
  pages: [{ items: threads }],
  pageParams: [undefined],
});
const order = (data: ThreadListData) =>
  data.pages.flatMap((page) => page.items.map((thread) => thread.id));
const change = (
  before: MessageSummary,
  after: Partial<MessageSummary>,
): MessageChange => ({ id: before.id, before, after: { ...before, ...after } });

describe("conversation rows", () => {
  it("show where any message is, keyed by the oldest message", () => {
    expect(threadBelongsTo(inbox, t1, isolating)).toBe(true);
    expect(threadBelongsTo(sent, t1, isolating)).toBe(true);
    const [row] = threadRows([t1], inbox, isolating);
    // The newest message shown in the Inbox's conversation is my reply.
    expect(row).toMatchObject({ id: "a1", summary: { id: "a2" } });
  });

  it("leave a list when no message is in it any more, and come back on undo", () => {
    const archived = change(a1, { mailboxIds: [] });
    const patched = patchThreadList(list(t2, t1), inbox, [archived], isolating);
    expect(order(patched)).toEqual(["t2"]);
    const rows = threadRows([t2, t1], inbox, isolating);
    expect([...rowsLeaving(rows, inbox, [archived], isolating)]).toEqual([
      "a1",
    ]);

    const undone = patchThreadList(
      patched,
      inbox,
      [{ id: a1.id, before: archived.after, after: a1 }],
      isolating,
      "newest",
      new Map([[t1.id, t1]]),
    );
    expect(order(undone)).toEqual(["t2", "t1"]);
    // Rebuilt from what was known, my reply included.
    expect(undone.pages[0]?.items[1]?.messages.map((m) => m.id)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("move up when a new message joins, and start rows for new conversations", () => {
    const reply = message("a3", "t1", 1, ["inbox"]);
    const fresh = message("c1", "t3", 5, ["inbox"]);
    const next = applyServerChangesToThreads(list(t2, t1), inbox, [
      { kind: "added", message: reply },
      { kind: "added", message: fresh },
    ]);
    expect(order(next)).toEqual(["t1", "t3", "t2"]);
    expect(next.pages[0]?.items[0]?.messages.map((m) => m.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
  });

  it("drop deleted messages, and the row with the last one", () => {
    const next = applyServerChangesToThreads(list(t2, t1), inbox, [
      { kind: "removed", id: b1.id },
    ]);
    expect(order(next)).toEqual(["t1"]);
  });

  it("keep trashed messages out of other lists' rows", () => {
    const trashed = message("a3", "t1", 1, ["trash"]);
    const thread = { ...t1, messages: [a1, a2, trashed] };
    const [row] = threadRows([thread], inbox, isolating);
    expect(row?.summary.id).toBe("a2");
    const [inTrash] = threadRows([thread], trash, isolating);
    expect(inTrash?.summary.id).toBe("a3");
  });
});
