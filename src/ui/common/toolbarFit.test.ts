// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ToolbarItem } from "../actions/mailActionItems";
import { fittingItems } from "./toolbarFit";

const item = (
  id: string,
  group: ToolbarItem["group"],
  keep?: number,
): ToolbarItem => ({
  id,
  label: id,
  icon: "star",
  group,
  run: () => undefined,
  ...(keep === undefined ? {} : { keep }),
});

const items = [
  item("reply", "answer", 6),
  item("forward", "answer", 1),
  item("archive", "mail"),
  item("trash", "mail"),
  item("star", "mail", 7),
  item("read", "mail", 8),
];
const shown = (width: number) => [...fittingItems(items, width, 36)];

describe("which toolbar buttons fit", () => {
  it("shows everything when there's room (gaps and the divider included)", () => {
    // 6 × 36 + 5 × 4 + 13 = 249
    expect(shown(249)).toEqual(items.map((i) => i.id));
  });

  it("moves the lowest `keep` into ⋯ first, leaving room for ⋯", () => {
    // Without forward, 5 + ⋯ still need 249 (the divider); without reply
    // too, 4 + ⋯ need 196.
    expect(shown(248)).toEqual(["archive", "trash", "star", "read"]);
    expect(shown(160)).toEqual(["archive", "trash", "read"]);
  });

  it("never moves items without `keep`", () => {
    expect(shown(10)).toEqual(["archive", "trash"]);
  });
});
