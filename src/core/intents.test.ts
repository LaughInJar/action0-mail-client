// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { asMailboxId, asMessageId } from "./ids";
import { inverseOf, runIntent } from "./intents";
import type { MessageSummary } from "./model";
import type { MailProvider } from "./provider";

const summary = (
  id: string,
  seen: boolean,
  flagged = false,
): MessageSummary => ({
  id: asMessageId(id),
  mailboxIds: [asMailboxId("inbox")],
  to: [],
  subject: id,
  snippet: "",
  receivedAt: "2026-10-18T10:00:00.000Z",
  flags: { seen, flagged },
  hasAttachments: false,
});

const [a, b, c] = ["a", "b", "c"].map(asMessageId) as [
  ReturnType<typeof asMessageId>,
  ReturnType<typeof asMessageId>,
  ReturnType<typeof asMessageId>,
];

describe("inverseOf", () => {
  it("swaps archive and unarchive", () => {
    expect(inverseOf({ kind: "archive", ids: [a, b] }, [])).toEqual([
      { kind: "unarchive", ids: [a, b] },
    ]);
    expect(inverseOf({ kind: "unarchive", ids: [a] }, [])).toEqual([
      { kind: "archive", ids: [a] },
    ]);
  });

  it("restores only the flags that actually changed", () => {
    const before = [
      summary("a", false),
      summary("b", true),
      summary("c", false),
    ];
    expect(
      inverseOf(
        { kind: "set-flags", ids: [a, b, c], flags: { seen: true } },
        before,
      ),
    ).toEqual([{ kind: "set-flags", ids: [a, c], flags: { seen: false } }]);
  });

  it("handles several flags at once and nothing-to-undo", () => {
    const before = [summary("a", false, true)];
    expect(
      inverseOf(
        { kind: "set-flags", ids: [a], flags: { seen: true, flagged: false } },
        before,
      ),
    ).toEqual([
      { kind: "set-flags", ids: [a], flags: { seen: false } },
      { kind: "set-flags", ids: [a], flags: { flagged: true } },
    ]);
    expect(
      inverseOf(
        { kind: "set-flags", ids: [a], flags: { flagged: true } },
        before,
      ),
    ).toEqual([]);
  });
});

describe("runIntent", () => {
  it("dispatches to the provider method", async () => {
    const archive = vi.fn(() => Promise.resolve({}));
    const unarchive = vi.fn(() => Promise.resolve({}));
    const setFlags = vi.fn(() => Promise.resolve({}));
    const provider = {
      archive,
      unarchive,
      setFlags,
    } as unknown as MailProvider;
    await runIntent(provider, { kind: "archive", ids: [a] });
    await runIntent(provider, { kind: "unarchive", ids: [b] });
    await runIntent(provider, {
      kind: "set-flags",
      ids: [c],
      flags: { seen: false },
    });
    expect(archive).toHaveBeenCalledWith([a], undefined);
    expect(unarchive).toHaveBeenCalledWith([b], undefined);
    expect(setFlags).toHaveBeenCalledWith([c], { seen: false }, undefined);
  });
});
