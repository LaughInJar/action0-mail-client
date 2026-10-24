// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asAccountId } from "../../core/ids";
import { ACCOUNT_COLORS, assignColors } from "./accountColors";

const [a, b, c] = ["a", "b", "c"].map(asAccountId) as [
  ReturnType<typeof asAccountId>,
  ReturnType<typeof asAccountId>,
  ReturnType<typeof asAccountId>,
];

describe("account colours", () => {
  it("gives accounts the palette in order and keeps remembered ones", () => {
    expect(assignColors([a, b], {})).toEqual({ a: 0, b: 1 });
    expect(assignColors([a, b, c], { a: 0, b: 1 })).toEqual({
      a: 0,
      b: 1,
      c: 2,
    });
  });

  it("keeps a removed account's colour free for when it comes back", () => {
    // b was removed; a new account gets a fresh colour, not b's.
    expect(assignColors([a, c], { a: 0, b: 1 })).toEqual({ a: 0, c: 2 });
    expect(assignColors([a, b, c], { a: 0, b: 1, c: 2 })).toEqual({
      a: 0,
      b: 1,
      c: 2,
    });
  });

  it("repeats colours once every one is taken", () => {
    const ids = Array.from({ length: ACCOUNT_COLORS.length + 1 }, (_, i) =>
      asAccountId(`x${String(i)}`),
    );
    const colors = assignColors(ids, {});
    expect(new Set(Object.values(colors)).size).toBe(ACCOUNT_COLORS.length);
  });
});
