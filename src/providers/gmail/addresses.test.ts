// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseAddressList } from "./addresses";

describe("parseAddressList", () => {
  it("parses names, bare addresses and quoted names with commas", () => {
    expect(
      parseAddressList(
        '"Doe, Jane" <jane@example.com>, bob@example.org, Max Muster <max@example.net>',
      ),
    ).toEqual([
      { name: "Doe, Jane", address: "jane@example.com" },
      { address: "bob@example.org" },
      { name: "Max Muster", address: "max@example.net" },
    ]);
  });

  it("handles escaped quotes and comments", () => {
    expect(parseAddressList('"Jane \\"JJ\\" Doe" <jane@example.com>')).toEqual([
      { name: 'Jane "JJ" Doe', address: "jane@example.com" },
    ]);
    expect(parseAddressList("bob@example.org (Bob Builder)")).toEqual([
      { name: "Bob Builder", address: "bob@example.org" },
    ]);
  });

  it("flattens groups and drops entries without an address", () => {
    expect(
      parseAddressList("Team: a@x.org, b@x.org;, undisclosed-recipients:;"),
    ).toEqual([{ address: "a@x.org" }, { address: "b@x.org" }]);
  });

  it("decodes encoded-word names", () => {
    expect(parseAddressList("=?UTF-8?Q?J=C3=BCrgen?= <j@example.com>")).toEqual(
      [{ name: "Jürgen", address: "j@example.com" }],
    );
  });

  it("returns an empty list for missing headers", () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });
});
