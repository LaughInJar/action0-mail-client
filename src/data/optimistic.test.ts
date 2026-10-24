// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  asCursor,
  asMailboxId,
  asMessageId,
  type MessageId,
} from "../core/ids";
import type { Mailbox, MessageSummary } from "../core/model";
import type { ProviderCapabilities } from "../core/provider";
import {
  isolatingMailboxes,
  applyServerChanges,
  belongsTo,
  patchCounts,
  patchList,
  planChanges,
  type MessageListData,
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

const inbox = box("inbox", { role: "inbox", counts: { unread: 2, total: 3 } });
const work = box("work", { counts: { unread: 1, total: 2 } });
const spam = box("spam", { role: "junk" });
const all = box("all", { kind: "view", role: "all" });
const starred = box("starred", {
  kind: "view",
  role: "flagged",
  counts: { unread: 0, total: 1 },
});
const archiveFolder = box("archive", {
  kind: "folder",
  role: "archive",
  counts: { unread: 0, total: 0 },
});
const mailboxes = [inbox, work, spam, all, starred, archiveFolder];

const labels: ProviderCapabilities = {
  mailboxKinds: ["label", "view"],
  archive: true,
  settableFlags: ["seen", "flagged"],
  move: true,
  labels: true,
  trash: true,
  spam: true,
  deleteForever: true,
  compose: true,
  contacts: false,
  maxAttachmentBytes: 25 * 1024 * 1024,
  manageMailboxes: true,
  mailboxEditing: {
    label: { rename: true, colors: [], nest: true, hide: true },
  },
  threads: true,
  senders: true,
  editSignatures: true,
  signatureStore: "provider",
};
const folders: ProviderCapabilities = { ...labels, mailboxKinds: ["folder"] };

function message(
  id: string,
  minutesAgo: number,
  mailboxIds: string[],
  seen = true,
  flagged = false,
): MessageSummary {
  return {
    id: asMessageId(id),
    mailboxIds: mailboxIds.map(asMailboxId),
    to: [],
    subject: id,
    snippet: "",
    receivedAt: new Date(
      Date.parse("2026-10-18T12:00:00Z") - minutesAgo * 60_000,
    ).toISOString(),
    flags: { seen, flagged },
    hasAttachments: false,
  };
}

const m1 = message("m1", 1, ["inbox", "work"], false);
const m2 = message("m2", 2, ["inbox"], true, true);
const m3 = message("m3", 3, ["inbox"], false);
const m4 = message("m4", 4, ["spam"], false);
const ids = (...names: string[]) => names.map(asMessageId);

function list(items: MessageSummary[], nextCursor?: string): MessageListData {
  return {
    pages: [
      { items, ...(nextCursor ? { nextCursor: asCursor(nextCursor) } : {}) },
    ],
    pageParams: [undefined],
  };
}
const rowIds = (data: MessageListData): MessageId[] =>
  data.pages.flatMap((p) => p.items.map((i) => i.id));

describe("planChanges", () => {
  it("archive drops the inbox membership and skips messages outside the inbox", () => {
    const changes = planChanges(
      { kind: "archive", ids: ids("m1", "m4", "missing") },
      [m1, m4],
      mailboxes,
      labels,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.after.mailboxIds).toEqual(["work"]);
  });

  it("archive moves to the archive folder for folder-based providers", () => {
    const [change] = planChanges(
      { kind: "archive", ids: ids("m3") },
      [m3],
      mailboxes,
      folders,
    );
    expect(change?.after.mailboxIds).toEqual(["archive"]);
    const [back] = planChanges(
      { kind: "unarchive", ids: ids("m3") },
      [change!.after],
      mailboxes,
      folders,
    );
    expect(back?.after.mailboxIds).toEqual(["inbox"]);
  });

  it("set-flags only reports messages whose flags change", () => {
    const changes = planChanges(
      { kind: "set-flags", ids: ids("m1", "m2"), flags: { seen: true } },
      [m1, m2],
      mailboxes,
      labels,
    );
    expect(changes.map((c) => c.id)).toEqual(["m1"]);
    expect(changes[0]?.after.flags).toEqual({ seen: true, flagged: false });
  });
});

describe("belongsTo", () => {
  it("uses membership for labels and the flag for the starred view", () => {
    expect(belongsTo(inbox, m1)).toBe(true);
    expect(belongsTo(spam, m1)).toBe(false);
    expect(belongsTo(all, m4)).toBe(true);
    expect(belongsTo(starred, m2)).toBe(true);
    expect(belongsTo(starred, m1)).toBe(false);
  });
});

describe("patchList", () => {
  const archiveM1 = planChanges(
    { kind: "archive", ids: ids("m1") },
    [m1],
    mailboxes,
    labels,
  );

  it("removes archived rows from the inbox but keeps them in labels and All Mail", () => {
    expect(rowIds(patchList(list([m1, m2, m3]), inbox, archiveM1))).toEqual([
      "m2",
      "m3",
    ]);
    const inWork = patchList(list([m1]), work, archiveM1);
    expect(rowIds(inWork)).toEqual(["m1"]);
    expect(inWork.pages[0]?.items[0]?.mailboxIds).toEqual(["work"]);
    expect(rowIds(patchList(list([m1, m2]), all, archiveM1))).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("re-inserts restored rows at their date position", () => {
    const archived = patchList(list([m1, m2, m3]), inbox, archiveM1);
    const [restore] = planChanges(
      { kind: "unarchive", ids: ids("m2") },
      [m2],
      mailboxes,
      labels,
    );
    expect(restore).toBeUndefined(); // m2 is still in the inbox: nothing to do
    const back = planChanges(
      { kind: "unarchive", ids: ids("m1") },
      [archiveM1[0]!.after],
      mailboxes,
      labels,
    );
    expect(rowIds(patchList(archived, inbox, back))).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("re-inserts restored rows at their place in an oldest-first list", () => {
    const archiveM2 = planChanges(
      { kind: "archive", ids: ids("m2") },
      [m2],
      mailboxes,
      labels,
    );
    const oldestFirst = list([m3, m2, m1]);
    const archived = patchList(
      oldestFirst,
      inbox,
      archiveM2,
      new Set(),
      "oldest",
    );
    expect(rowIds(archived)).toEqual(["m3", "m1"]);
    const back = planChanges(
      { kind: "unarchive", ids: ids("m2") },
      [archiveM2[0]!.after],
      mailboxes,
      labels,
    );
    expect(
      rowIds(patchList(archived, inbox, back, new Set(), "oldest")),
    ).toEqual(["m3", "m2", "m1"]);
  });

  it("doesn't append restored rows beyond the loaded pages", () => {
    const old = message("old", 999, ["work"]);
    const back = planChanges(
      { kind: "unarchive", ids: ids("old") },
      [old],
      mailboxes,
      labels,
    );
    expect(rowIds(patchList(list([m1], "more"), inbox, back))).toEqual(["m1"]);
    expect(rowIds(patchList(list([m1]), inbox, back))).toEqual(["m1", "old"]);
  });

  it("updates flags in place", () => {
    const read = planChanges(
      { kind: "set-flags", ids: ids("m3"), flags: { seen: true } },
      [m3],
      mailboxes,
      labels,
    );
    expect(
      patchList(list([m3]), inbox, read).pages[0]?.items[0]?.flags.seen,
    ).toBe(true);
  });
});

describe("patchCounts", () => {
  it("adjusts unread and total counts for membership and read changes", () => {
    const changes = [
      ...planChanges(
        { kind: "archive", ids: ids("m1") },
        [m1],
        mailboxes,
        labels,
      ),
      ...planChanges(
        { kind: "set-flags", ids: ids("m3"), flags: { seen: true } },
        [m3],
        mailboxes,
        labels,
      ),
    ];
    const patched = patchCounts(mailboxes, changes);
    expect(patched.find((m) => m.id === inbox.id)?.counts).toEqual({
      unread: 0,
      total: 2,
    });
    // m1 stays in Work and stays unread.
    expect(patched.find((m) => m.id === work.id)).toBe(work);
  });

  it("never goes below zero", () => {
    const unstar = planChanges(
      { kind: "set-flags", ids: ids("m2"), flags: { flagged: false } },
      [m2],
      mailboxes,
      labels,
    );
    const patched = patchCounts(
      [
        box("starred", {
          kind: "view",
          role: "flagged",
          counts: { unread: 0, total: 0 },
        }),
      ],
      unstar,
    );
    expect(patched[0]?.counts).toEqual({ unread: 0, total: 0 });
  });
});

describe("move and set-labels", () => {
  it("moves from a label: leaves the source, joins the target", () => {
    const [change] = planChanges(
      { kind: "move", ids: ids("m3"), from: inbox.id, to: work.id },
      [m3],
      mailboxes,
      labels,
    );
    expect(change?.after.mailboxIds).toEqual(["work"]);
    expect(rowIds(patchList(list([m2, m3]), inbox, [change!]))).toEqual(["m2"]);
    // Inserted into a cached Work list at its date position.
    expect(rowIds(patchList(list([m1]), work, [change!]))).toEqual([
      "m1",
      "m3",
    ]);
    const counts = patchCounts(mailboxes, [change!]);
    expect(counts.find((m) => m.id === inbox.id)?.counts).toEqual({
      unread: 1,
      total: 2,
    });
    expect(counts.find((m) => m.id === work.id)?.counts).toEqual({
      unread: 2,
      total: 3,
    });
  });

  it("moving out of a view only adds the target", () => {
    const [change] = planChanges(
      { kind: "move", ids: ids("m2"), from: starred.id, to: work.id },
      [m2],
      mailboxes,
      labels,
    );
    expect(change?.after.mailboxIds).toEqual(["inbox", "work"]);
    expect(change?.after.flags.flagged).toBe(true);
  });

  it("moving into a folder leaves every other folder", () => {
    const inFolder = message("f", 5, ["archive"]);
    const projects = box("projects", { kind: "folder" });
    const [change] = planChanges(
      { kind: "move", ids: ids("f"), from: archiveFolder.id, to: projects.id },
      [inFolder],
      [...mailboxes, projects],
      folders,
    );
    expect(change?.after.mailboxIds).toEqual(["projects"]);
  });

  it("set-labels adds and removes, and skips messages that wouldn't change", () => {
    const changes = planChanges(
      { kind: "set-labels", ids: ids("m1", "m2"), add: [work.id], remove: [] },
      [m1, m2],
      mailboxes,
      labels,
    );
    expect(changes.map((c) => [c.id, c.after.mailboxIds])).toEqual([
      ["m2", ["inbox", "work"]],
    ]);
    const [removed] = planChanges(
      { kind: "set-labels", ids: ids("m1"), add: [], remove: [work.id] },
      [m1],
      mailboxes,
      labels,
    );
    expect(removed?.after.mailboxIds).toEqual(["inbox"]);
  });
});

describe("trash, spam and deletion", () => {
  const trash = box("trash", {
    role: "trash",
    counts: { unread: 0, total: 0 },
  });
  const boxes = [inbox, work, spam, all, trash];
  const isolating = new Set([spam.id, trash.id]);
  const plan = (
    intent: Parameters<typeof planChanges>[0],
    messages: MessageSummary[],
  ) => planChanges(intent, messages, boxes, labels);

  it("trash hides the message from every list but Trash", () => {
    const changes = plan({ kind: "trash", ids: ids("m1") }, [m1]);
    expect(changes[0]?.after.mailboxIds).toEqual(["inbox", "work", "trash"]);
    expect(
      rowIds(patchList(list([m1, m2]), inbox, changes, isolating)),
    ).toEqual(["m2"]);
    expect(rowIds(patchList(list([m1]), work, changes, isolating))).toEqual([]);
    expect(rowIds(patchList(list([m1, m2]), all, changes, isolating))).toEqual([
      "m2",
    ]);
    expect(rowIds(patchList(list([]), trash, changes, isolating))).toEqual([
      "m1",
    ]);
    const counts = patchCounts(boxes, changes);
    expect(counts.find((m) => m.id === work.id)?.counts).toEqual({
      unread: 0,
      total: 1,
    });
    expect(counts.find((m) => m.id === trash.id)?.counts).toEqual({
      unread: 1,
      total: 1,
    });
  });

  it("untrash brings it back", () => {
    const [trashed] = plan({ kind: "trash", ids: ids("m1") }, [m1]);
    const back = plan({ kind: "untrash", ids: ids("m1") }, [trashed!.after]);
    expect(back[0]?.after.mailboxIds).toEqual(["inbox", "work"]);
    expect(rowIds(patchList(list([m2]), inbox, back, isolating))).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("reports spam out of the inbox and back with not-spam", () => {
    const [reported] = plan({ kind: "report-spam", ids: ids("m2") }, [m2]);
    expect(reported?.after.mailboxIds).toEqual(["spam"]);
    const [restored] = plan({ kind: "not-spam", ids: ids("m2") }, [
      reported!.after,
    ]);
    expect(restored?.after.mailboxIds).toEqual(["inbox"]);
  });

  it("delete-forever removes the row everywhere and from every count", () => {
    const [trashed] = plan({ kind: "trash", ids: ids("m3") }, [m3]);
    const deleted = plan({ kind: "delete-forever", ids: ids("m3") }, [
      trashed!.after,
    ]);
    expect(deleted[0]?.deleted).toBe(true);
    expect(
      rowIds(patchList(list([trashed!.after]), trash, deleted, isolating)),
    ).toEqual([]);
    expect(rowIds(patchList(list([m3]), all, deleted, isolating))).toEqual([]);
    const counted = patchCounts(
      [{ ...trash, counts: { unread: 1, total: 1 } }],
      deleted,
    );
    expect(counted[0]?.counts).toEqual({ unread: 0, total: 0 });
  });
});

describe("applyServerChanges", () => {
  const isolating = isolatingMailboxes(mailboxes);
  const fresh = message("m0", 0, ["inbox"], false);

  it("puts new mail at its date position and updates rows in place", () => {
    const read = { ...m3, flags: { seen: true, flagged: false } };
    const next = applyServerChanges(
      list([m1, m2, m3]),
      inbox,
      [
        { kind: "added", message: fresh },
        { kind: "updated", message: read },
      ],
      isolating,
    );
    expect(rowIds(next)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(next.pages[0]?.items[3]?.flags.seen).toBe(true);
  });

  it("drops rows that left the mailbox or are gone, and keeps Spam apart", () => {
    const archived = { ...m1, mailboxIds: [asMailboxId("work")] };
    const spammed = { ...m2, mailboxIds: [asMailboxId("spam")] };
    const next = applyServerChanges(
      list([m1, m2, m3]),
      inbox,
      [
        { kind: "updated", message: archived },
        { kind: "updated", message: spammed },
        { kind: "removed", id: asMessageId("m3") },
      ],
      isolating,
    );
    expect(rowIds(next)).toEqual([]);
    expect(
      rowIds(
        applyServerChanges(
          list([m1]),
          all,
          [{ kind: "updated", message: spammed }],
          isolating,
        ),
      ),
    ).toEqual(["m1"]);
  });

  it("keeps the order of oldest-first lists and stays within loaded pages", () => {
    expect(
      rowIds(
        applyServerChanges(
          list([m3, m2, m1]),
          inbox,
          [{ kind: "added", message: fresh }],
          isolating,
          "oldest",
        ),
      ),
    ).toEqual(["m3", "m2", "m1", "m0"]);
    // Newer mail beyond what's loaded of an oldest-first list waits for paging.
    expect(
      rowIds(
        applyServerChanges(
          list([m3, m2], "more"),
          inbox,
          [{ kind: "added", message: fresh }],
          isolating,
          "oldest",
        ),
      ),
    ).toEqual(["m3", "m2"]);
  });
});
