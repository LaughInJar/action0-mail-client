import { describe, expect, it } from "vitest";
import {
  matchScore,
  paletteGroups,
  withRecent,
  type PaletteItem,
} from "./paletteItems";

const item = (
  id: string,
  label: string,
  section: PaletteItem["section"],
  detail?: string,
): PaletteItem => ({
  id,
  label,
  section,
  icon: "inbox",
  run: () => undefined,
  ...(detail ? { detail } : {}),
});

const ITEMS = [
  item("inbox", "Inbox", "places", "anna@example.com"),
  item("archive-2019", "Archive 2019", "places", "anna@example.com"),
  item("drafts", "Entwürfe", "places", "anna@example.com"),
  item("archive", "Archive", "actions"),
  item("dark", "Theme: Dark", "actions"),
  item("search", "Search mail for “arch”", "search"),
];
const ids = (groups: ReturnType<typeof paletteGroups>) =>
  groups.map((group) => [group.section, group.items.map((each) => each.id)]);

describe("matchScore", () => {
  it("matches word starts, ignoring case and accents", () => {
    expect(matchScore("entw", ITEMS[2]!)).not.toBeNull();
    expect(matchScore("ENTWURFE", ITEMS[2]!)).not.toBeNull();
    expect(matchScore("wurfe", ITEMS[2]!)).toBeNull();
    expect(matchScore("dark", ITEMS[4]!)).not.toBeNull();
  });

  it("needs every word, in the label or the detail", () => {
    expect(matchScore("inbox anna", ITEMS[0]!)).not.toBeNull();
    expect(matchScore("inbox bob", ITEMS[0]!)).toBeNull();
    expect(matchScore("inbox", ITEMS[0]!)!).toBeGreaterThan(
      matchScore("anna", ITEMS[0]!)!,
    );
  });

  it("prefers the whole label typed", () => {
    expect(matchScore("archive", ITEMS[3]!)!).toBeGreaterThan(
      matchScore("archive", ITEMS[1]!)!,
    );
  });
});

describe("paletteGroups", () => {
  it("lists the recent choices first while nothing is typed", () => {
    expect(ids(paletteGroups(ITEMS.slice(0, 5), "", ["dark", "gone"]))).toEqual(
      [
        ["recent", ["dark"]],
        ["places", ["inbox", "archive-2019", "drafts"]],
        ["actions", ["archive"]],
      ],
    );
  });

  it("puts the section with the best match first, the search last", () => {
    expect(ids(paletteGroups(ITEMS, "archive", []))).toEqual([
      ["actions", ["archive"]],
      ["places", ["archive-2019"]],
      ["search", ["search"]],
    ]);
    expect(ids(paletteGroups(ITEMS, "arch", []))).toEqual([
      ["actions", ["archive"]],
      ["places", ["archive-2019"]],
      ["search", ["search"]],
    ]);
    expect(ids(paletteGroups(ITEMS, "zzz", []))).toEqual([
      ["search", ["search"]],
    ]);
  });

  it("ranks recent choices higher", () => {
    expect(ids(paletteGroups(ITEMS, "arch", ["archive-2019"]))).toEqual([
      ["places", ["archive-2019"]],
      ["actions", ["archive"]],
      ["search", ["search"]],
    ]);
  });
});

it("keeps the latest choice first, once, and at most a few", () => {
  expect(withRecent(["a", "b", "c"], "b", 3)).toEqual(["b", "a", "c"]);
  expect(withRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
});
