// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { asMailboxId, asMessageId, type MessageId } from "./ids";
import { inverseOf, runIntent, type MessageChange } from "./intents";
import type { MessageSummary } from "./model";
import type { MailProvider } from "./provider";

const summary = (
  id: string,
  mailboxIds: string[],
  flags: { seen?: boolean; flagged?: boolean } = {},
): MessageSummary => ({
  id: asMessageId(id),
  mailboxIds: mailboxIds.map(asMailboxId),
  to: [],
  subject: id,
  snippet: "",
  receivedAt: "2026-10-18T10:00:00.000Z",
  flags: { seen: flags.seen ?? true, flagged: flags.flagged ?? false },
  hasAttachments: false,
});

const change = (
  before: MessageSummary,
  after: Partial<MessageSummary>,
): MessageChange => ({
  id: before.id,
  before,
  after: { ...before, ...after },
});

const ids = (...names: string[]): MessageId[] => names.map(asMessageId);
const box = asMailboxId;
const labels = { labels: true };

describe("inverseOf", () => {
  it("swaps archive and unarchive for the messages that changed", () => {
    const a = summary("a", ["inbox"]);
    const changes = [change(a, { mailboxIds: [] })];
    expect(
      inverseOf({ kind: "archive", ids: ids("a", "b") }, changes, labels),
    ).toEqual([{ kind: "unarchive", ids: ["a"] }]);
    expect(
      inverseOf({ kind: "unarchive", ids: ids("a") }, changes, labels),
    ).toEqual([{ kind: "archive", ids: ["a"] }]);
    expect(inverseOf({ kind: "archive", ids: ids("a") }, [], labels)).toEqual(
      [],
    );
  });

  it("restores flags per flag that actually changed", () => {
    const a = summary("a", ["inbox"], { seen: false, flagged: true });
    const c = summary("c", ["inbox"], { seen: false });
    const intent = {
      kind: "set-flags",
      ids: ids("a", "c"),
      flags: { seen: true, flagged: false },
    } as const;
    const after = { flags: { seen: true, flagged: false } };
    expect(
      inverseOf(intent, [change(a, after), change(c, after)], labels),
    ).toEqual([
      { kind: "set-flags", ids: ["a", "c"], flags: { seen: false } },
      { kind: "set-flags", ids: ["a"], flags: { flagged: true } },
    ]);
  });

  it("reverses label moves per exact diff, never removing labels the message already had", () => {
    // a: Inbox → Work. b already had Work: the move only removed Inbox.
    const a = summary("a", ["inbox"]);
    const b = summary("b", ["inbox", "work"]);
    const intent = {
      kind: "move",
      ids: ids("a", "b"),
      from: box("inbox"),
      to: box("work"),
    } as const;
    const moved = { mailboxIds: [box("work")] };
    expect(
      inverseOf(intent, [change(a, moved), change(b, moved)], labels),
    ).toEqual([
      { kind: "set-labels", ids: ["a"], add: ["inbox"], remove: ["work"] },
      { kind: "set-labels", ids: ["b"], add: ["inbox"], remove: [] },
    ]);
  });

  it("reverses label changes and groups identical diffs", () => {
    const a = summary("a", ["inbox"]);
    const b = summary("b", ["inbox"]);
    const intent = {
      kind: "set-labels",
      ids: ids("a", "b"),
      add: [box("work")],
      remove: [],
    } as const;
    const labelled = { mailboxIds: [box("inbox"), box("work")] };
    expect(
      inverseOf(intent, [change(a, labelled), change(b, labelled)], labels),
    ).toEqual([
      { kind: "set-labels", ids: ["a", "b"], add: [], remove: ["work"] },
    ]);
  });

  it("moves back to the original folder for folder providers", () => {
    const a = summary("a", ["inbox"]);
    const b = summary("b", ["projects"]);
    const intent = {
      kind: "move",
      ids: ids("a", "b"),
      from: box("inbox"),
      to: box("archive"),
    } as const;
    const moved = { mailboxIds: [box("archive")] };
    expect(
      inverseOf(intent, [change(a, moved), change(b, moved)], {
        labels: false,
      }),
    ).toEqual([
      { kind: "move", ids: ["a"], from: "archive", to: "inbox" },
      { kind: "move", ids: ["b"], from: "archive", to: "projects" },
    ]);
  });
});

describe("inverseOf for trash, spam and deletion", () => {
  it("restores trash with untrash and has nothing to undo after deleting forever", () => {
    const a = summary("a", ["inbox"]);
    const trashed = [change(a, { mailboxIds: [box("inbox"), box("trash")] })];
    expect(
      inverseOf({ kind: "trash", ids: ids("a") }, trashed, labels),
    ).toEqual([{ kind: "untrash", ids: ["a"] }]);
    expect(
      inverseOf({ kind: "untrash", ids: ids("a") }, trashed, labels),
    ).toEqual([{ kind: "trash", ids: ["a"] }]);
    expect(
      inverseOf(
        { kind: "delete-forever", ids: ids("a") },
        [{ ...trashed[0]!, deleted: true }],
        labels,
      ),
    ).toEqual([]);
  });

  it("undoes a spam report exactly, even for messages that weren't in the Inbox", () => {
    const a = summary("a", ["inbox", "work"]);
    const b = summary("b", ["work"]);
    const changes = [
      change(a, { mailboxIds: [box("work"), box("spam")] }),
      change(b, { mailboxIds: [box("work"), box("spam")] }),
    ];
    expect(
      inverseOf({ kind: "report-spam", ids: ids("a", "b") }, changes, labels),
    ).toEqual([
      { kind: "set-labels", ids: ["a"], add: ["inbox"], remove: ["spam"] },
      { kind: "set-labels", ids: ["b"], add: [], remove: ["spam"] },
    ]);
  });

  it("moves back for folder providers", () => {
    const a = summary("a", ["projects"]);
    const changes = [change(a, { mailboxIds: [box("junk")] })];
    expect(
      inverseOf({ kind: "report-spam", ids: ids("a") }, changes, {
        labels: false,
      }),
    ).toEqual([{ kind: "move", ids: ["a"], from: "junk", to: "projects" }]);
  });
});

describe("runIntent", () => {
  it("dispatches to the provider method", async () => {
    const archive = vi.fn(() => Promise.resolve({}));
    const unarchive = vi.fn(() => Promise.resolve({}));
    const setFlags = vi.fn(() => Promise.resolve({}));
    const move = vi.fn(() => Promise.resolve({}));
    const setLabels = vi.fn(() => Promise.resolve({}));
    const provider = {
      archive,
      unarchive,
      setFlags,
      move,
      setLabels,
    } as unknown as MailProvider;
    const [a, b, c] = ids("a", "b", "c") as [MessageId, MessageId, MessageId];
    await runIntent(provider, { kind: "archive", ids: [a] });
    await runIntent(provider, { kind: "unarchive", ids: [b] });
    await runIntent(provider, {
      kind: "set-flags",
      ids: [c],
      flags: { seen: false },
    });
    await runIntent(provider, {
      kind: "move",
      ids: [a],
      from: box("inbox"),
      to: box("work"),
    });
    await runIntent(provider, {
      kind: "set-labels",
      ids: [b],
      add: [box("x")],
      remove: [box("y")],
    });
    expect(archive).toHaveBeenCalledWith([a], undefined);
    expect(unarchive).toHaveBeenCalledWith([b], undefined);
    expect(setFlags).toHaveBeenCalledWith([c], { seen: false }, undefined);
    expect(move).toHaveBeenCalledWith(
      [a],
      { from: "inbox", to: "work" },
      undefined,
    );
    expect(setLabels).toHaveBeenCalledWith(
      [b],
      { add: ["x"], remove: ["y"] },
      undefined,
    );
  });
});
