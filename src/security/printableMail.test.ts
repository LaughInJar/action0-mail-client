import { describe, expect, it } from "vitest";
import { buildPrintableMail } from "./printableMail";
import { sanitizeMailHtml } from "./sanitize";

const MAIL = `<html><head><style>
@import url("https://tracker.example/x.css");
@font-face { font-family: X; src: url(https://fonts.example/x.woff2); }
.banner { background: url(https://cdn.example/bg.png); color: red; }
</style></head><body bgcolor="#eee">
<p class="banner">Hello</p>
<img src="https://cdn.example/logo.png" srcset="https://cdn.example/logo@2x.png 2x" alt="Logo">
<img src="cid:part1@example" alt="Inline">
<div style="background-image: url('https://cdn.example/p.png')">Box</div>
<script>alert(1)</script>
</body></html>`;

const build = (allowRemoteContent: boolean) =>
  buildPrintableMail(sanitizeMailHtml(MAIL).html, {
    allowRemoteContent,
    inlineImages: { "part1@example": "data:image/png;base64,AAAA" },
  });

describe("buildPrintableMail", () => {
  it("leaves out remote images, style sheets and fonts, and resolves inline images", () => {
    const html = build(false);
    expect(html).not.toMatch(/https:\/\//);
    expect(html).not.toMatch(/@import|@font-face/);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain("color: red");
    expect(html).toContain("Hello");
    expect(html).not.toContain("<script");
  });

  it("keeps remote images where the reader would load them, never style sheets or fonts", () => {
    const html = build(true);
    expect(html).toContain('src="https://cdn.example/logo.png"');
    expect(html).toContain("url(https://cdn.example/bg.png)");
    expect(html).not.toMatch(/@import|@font-face/);
  });

  it("puts the mail's styles before its body, for a shadow root", () => {
    const html = build(false);
    expect(html.indexOf(".banner")).toBeLessThan(html.indexOf('part="mail"'));
    expect(html.startsWith("<style>")).toBe(true);
  });
});
