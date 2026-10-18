import { describe, expect, it } from "vitest";
import { sanitizeMailHtml } from "./sanitize";

describe("sanitizeMailHtml", () => {
  it("removes scripts, event handlers, javascript: URLs, forms and embedded documents", () => {
    const { html } = sanitizeMailHtml(`
      <p onclick="alert(1)" onmouseover="x()">Hello</p>
      <script>alert(1)</script>
      <a href="javascript:alert(1)">bad</a>
      <form action="https://evil.example"><input name="password"><button>Go</button></form>
      <iframe src="https://evil.example"></iframe>
      <object data="x.swf"></object><embed src="x.swf">
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <base href="https://evil.example/">
      <img src="x" srcdoc="<script>alert(1)</script>">
    `);
    expect(html).toContain("Hello");
    for (const forbidden of [
      "onclick",
      "onmouseover",
      "<script",
      "javascript:",
      "<form",
      "<input",
      "<button",
      "<iframe",
      "<object",
      "<embed",
      "<meta",
      "<base",
      "srcdoc",
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("keeps styles, so mails look as intended", () => {
    const { html } = sanitizeMailHtml(
      '<html><head><style>.a{color:red}</style></head><body><p class="a" style="font-weight:bold">x</p></body></html>',
    );
    expect(html).toContain("<style>.a{color:red}</style>");
    expect(html).toContain('style="font-weight:bold"');
  });

  it("opens links in a new tab without opener or referrer", () => {
    const { html } = sanitizeMailHtml('<a href="https://example.com">x</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it.each([
    ['<img src="https://t.example/p.gif">', true],
    ['<img src="//t.example/p.gif">', true],
    ['<img srcset="a.png 1x, https://t.example/b.png 2x">', true],
    ['<table background="http://t.example/bg.png"></table>', true],
    ['<div style="background:url(https://t.example/x.png)"></div>', true],
    ["<style>@import url(https://t.example/a.css);</style>", true],
    [
      '<style>.x{background-image:url("https://t.example/x.png")}</style>',
      true,
    ],
    ['<img src="cid:logo@x"><img src="data:image/png;base64,AAAA">', false],
    ['<a href="https://example.com">just a link</a>', false],
  ])("detects remote content in %s → %s", (input, expected) => {
    expect(sanitizeMailHtml(input).hasRemoteContent).toBe(expected);
  });

  it("does not leak the remote flag into the next call", () => {
    sanitizeMailHtml('<img src="https://t.example/p.gif">');
    expect(sanitizeMailHtml("<p>plain</p>").hasRemoteContent).toBe(false);
  });
});
