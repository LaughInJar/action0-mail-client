// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asAccountId, asMessageId, type AccountId } from "../core/ids";
import type { MessageSummary } from "../core/model";
import { messageRows } from "./listRows";
import { mergeByDate, type MergeSource } from "./unified";

const A = asAccountId("gmail:a@example.com");
const B = asAccountId("microsoft:b@example.com");

const summary = (id: string, day: number): MessageSummary => ({
  id: asMessageId(id),
  mailboxIds: [],
  from: { address: "x@example.com" },
  to: [],
  subject: id,
  snippet: "",
  receivedAt: new Date(Date.UTC(2026, 9, day)).toISOString(),
  flags: { seen: true, flagged: false },
  hasAttachments: false,
});

/** An account's loaded rows: ids with their day of October. */
const source = (
  accountId: AccountId,
  days: readonly (readonly [string, number])[],
  hasMore = false,
): MergeSource => ({
  accountId,
  rows: messageRows(
    accountId,
    days.map(([id, day]) => summary(id, day)),
  ),
  hasMore,
});

const ids = (result: ReturnType<typeof mergeByDate>) =>
  result.rows.map((row) => row.id);

describe("merging accounts' lists by date", () => {
  it("interleaves newest first, keeping each account's order", () => {
    const merged = mergeByDate(
      [
        source(A, [
          ["a1", 20],
          ["a2", 15],
          ["a3", 3],
        ]),
        source(B, [
          ["b1", 18],
          ["b2", 15],
          ["b3", 1],
        ]),
      ],
      "newest",
    );
    // On the same date the first account comes first.
    expect(ids(merged)).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"]);
    expect(merged.behind).toEqual([]);
    expect(merged.rows.map((row) => row.accountId)).toEqual([A, B, A, B, A, B]);
  });

  it("stops where an account with more pages hasn't loaded yet, and says whose page is next", () => {
    const merged = mergeByDate(
      [
        source(
          A,
          [
            ["a1", 20],
            ["a2", 10],
          ],
          true,
        ),
        source(B, [
          ["b1", 18],
          ["b2", 12],
          ["b3", 5],
          ["b4", 2],
        ]),
      ],
      "newest",
    );
    // b3 and b4 are older than A's last loaded row: A may have mail in between.
    expect(ids(merged)).toEqual(["a1", "b1", "b2", "a2"]);
    expect(merged.behind).toEqual([A]);
  });

  it("takes the most recent frontier when several accounts have more", () => {
    const merged = mergeByDate(
      [
        source(A, [["a1", 20]], true),
        source(
          B,
          [
            ["b1", 25],
            ["b2", 8],
          ],
          true,
        ),
      ],
      "newest",
    );
    expect(ids(merged)).toEqual(["b1", "a1"]);
    expect(merged.behind).toEqual([A]);
  });

  it("works the same way oldest first", () => {
    const merged = mergeByDate(
      [
        source(
          A,
          [
            ["a1", 2],
            ["a2", 9],
          ],
          true,
        ),
        source(B, [
          ["b1", 4],
          ["b2", 20],
        ]),
      ],
      "oldest",
    );
    expect(ids(merged)).toEqual(["a1", "b1", "a2"]);
    expect(merged.behind).toEqual([A]);
  });

  it("shows nothing while an account with more pages has none loaded", () => {
    const merged = mergeByDate(
      [source(A, [], true), source(B, [["b1", 4]])],
      "newest",
    );
    expect(ids(merged)).toEqual([]);
    expect(merged.behind).toEqual([A]);
  });

  it("keys rows by account, so equal message ids stay apart", () => {
    const merged = mergeByDate(
      [source(A, [["same", 3]]), source(B, [["same", 2]])],
      "newest",
    );
    const [first, second] = merged.rows;
    expect(first?.id).toBe(second?.id);
    expect(first?.key).not.toBe(second?.key);
  });
});
