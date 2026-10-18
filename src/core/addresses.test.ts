// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatAddress, isValidAddress, parseAddressInput } from "./addresses";

describe("parseAddressInput", () => {
  it("splits pasted lists and keeps invalid entries", () => {
    expect(
      parseAddressInput(
        'Anna Berger <anna@example.org>; nobody, "Doe, Jane" <jane@x.com>\nbob@y.net',
      ),
    ).toEqual([
      {
        raw: "Anna Berger <anna@example.org>",
        address: { name: "Anna Berger", address: "anna@example.org" },
      },
      { raw: "nobody" },
      {
        raw: '"Doe, Jane" <jane@x.com>',
        address: { name: "Doe, Jane", address: "jane@x.com" },
      },
      { raw: "bob@y.net", address: { address: "bob@y.net" } },
    ]);
  });

  it("checks addresses loosely, like mail clients do", () => {
    expect(isValidAddress("a@b.co")).toBe(true);
    expect(isValidAddress("a.b+tag@sub.example.org")).toBe(true);
    expect(isValidAddress("a@b")).toBe(false);
    expect(isValidAddress("a b@c.de")).toBe(false);
    expect(parseAddressInput("x@y")).toEqual([{ raw: "x@y" }]);
  });
});

describe("formatAddress", () => {
  it("quotes names with special characters", () => {
    expect(formatAddress({ address: "a@b.co" })).toBe("a@b.co");
    expect(formatAddress({ name: "Anna", address: "a@b.co" })).toBe(
      "Anna <a@b.co>",
    );
    expect(formatAddress({ name: 'Doe, "J"', address: "a@b.co" })).toBe(
      '"Doe, \\"J\\"" <a@b.co>',
    );
  });
});
