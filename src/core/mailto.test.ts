import { describe, expect, it } from "vitest";
import { parseMailto } from "./mailto";

describe("mailto: URLs", () => {
  it("reads recipients, subject and text (RFC 6068)", () => {
    expect(
      parseMailto(
        "mailto:anna@example.org,Jonas%20%3Cjonas@example.org%3E?cc=mia@example.com&bcc=me@example.com&subject=Hi%20there&body=Line%201%0D%0ALine+2",
      ),
    ).toEqual({
      to: [
        { address: "anna@example.org" },
        { name: "Jonas", address: "jonas@example.org" },
      ],
      cc: [{ address: "mia@example.com" }],
      bcc: [{ address: "me@example.com" }],
      subject: "Hi there",
      // "+" is a plus in mailto: URLs.
      body: "Line 1\nLine+2",
    });
  });

  it("takes recipients from the query too, and ignores other headers", () => {
    expect(
      parseMailto("MAILTO:?to=a@b.c&in-reply-to=%3Cx%3E&subject=S&subject=T"),
    ).toEqual({
      to: [{ address: "a@b.c" }],
      cc: [],
      bcc: [],
      subject: "S",
      body: "",
    });
  });

  it("isn't fooled by other URLs or broken encoding", () => {
    expect(parseMailto("https://example.org")).toBeUndefined();
    expect(parseMailto("mailto:%E0%A4%A")?.to).toEqual([]);
  });
});
