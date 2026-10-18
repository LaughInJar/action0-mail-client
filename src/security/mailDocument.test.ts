import { describe, expect, it } from "vitest";
import { buildMailDocument, mailContentSecurityPolicy } from "./mailDocument";
import { sanitizeMailHtml } from "./sanitize";

const parse = (html: string) =>
  new DOMParser().parseFromString(html, "text/html");

describe("buildMailDocument", () => {
  it("puts the CSP first in <head>, before any mail styles", () => {
    const { html } = sanitizeMailHtml(
      "<html><head><style>p{}</style></head><body><p>x</p></body></html>",
    );
    const doc = parse(buildMailDocument(html, { allowRemoteContent: false }));
    const first = doc.head.firstElementChild;
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toBe(
      mailContentSecurityPolicy(false),
    );
    expect(
      doc.head.querySelector('meta[name="referrer"]')?.getAttribute("content"),
    ).toBe("no-referrer");
  });

  it("blocks everything remote by default and only relaxes images when allowed", () => {
    expect(mailContentSecurityPolicy(false)).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:",
    );
    expect(mailContentSecurityPolicy(true)).toContain(
      "img-src data: https: http:",
    );
    expect(mailContentSecurityPolicy(true)).toContain("default-src 'none'");
  });

  it("resolves cid: images and drops unresolved ones", () => {
    const html =
      '<img id="a" src="cid:logo@x"><img id="b" src="cid:missing@x">';
    const doc = parse(
      buildMailDocument(html, {
        allowRemoteContent: false,
        inlineImages: { "logo@x": "data:image/png;base64,AAAA" },
      }),
    );
    expect(doc.getElementById("a")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(doc.getElementById("b")?.hasAttribute("src")).toBe(false);
  });
});
