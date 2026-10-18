import { describe, expect, it } from "vitest";
import { asMessageId, asThreadId } from "../core/ids";
import type { Message } from "../core/model";
import { editorHtmlToMail, htmlToText, textToHtml } from "./html";
import { messages } from "../i18n/messages";
import { forwardQuote, replyQuote, splitQuote, type QuoteTexts } from "./quote";
import { draftInputOf, mailBody, mailHtmlToEditor, sentBytes } from "./session";
import { splitSignature } from "./signature";

const english: QuoteTexts = {
  ...messages.en.composer.quote,
  locale: "en-US",
  unknownSender: "(unknown sender)",
};

const original: Message = {
  id: asMessageId("m1"),
  threadId: asThreadId("t1"),
  mailboxIds: [],
  from: { name: "Anna Berger", address: "anna@example.org" },
  to: [{ address: "me@example.com" }],
  cc: [{ name: "Bob", address: "bob@example.net" }],
  bcc: [],
  replyTo: [],
  internetMessageId: "<m1@x>",
  references: [],
  subject: "Plans",
  snippet: "",
  receivedAt: "2026-10-18T10:00:00Z",
  flags: { seen: true, flagged: false },
  hasAttachments: false,
  body: {
    html: `<html><head><style>.big{font-size:20px}</style></head><body><p class="big">Hello <b>there</b></p><img src="cid:logo@x" alt="Logo"><script>alert(1)</script></body></html>`,
  },
  attachments: [],
};

describe("htmlToText", () => {
  it("writes blocks, lists, links and quotes as plain text", () => {
    expect(
      htmlToText(
        `<div>Hello <b>Anna</b>,</div><div><br></div><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>` +
          `<p>See <a href="https://example.org">the site</a> or <a href="mailto:x@y.z">x@y.z</a>.</p>` +
          `<blockquote><p>quoted</p><p>lines</p></blockquote><style>p{}</style>`,
      ),
    ).toBe(
      "Hello Anna,\n\n- one\n- two\n1. first\nSee the site (https://example.org) or x@y.z.\n> quoted\n> lines",
    );
  });
});

describe("editor and mail HTML", () => {
  it("turns paragraphs into Gmail-style lines and back", () => {
    const mail = editorHtmlToMail(
      "<p>Hi</p><p></p><p>Bye <strong>now</strong></p>",
    );
    expect(mail).toBe(
      "<div>Hi</div><div><br></div><div>Bye <strong>now</strong></div>",
    );
    expect(mailHtmlToEditor(mail)).toBe(
      "<p>Hi</p><p></p><p>Bye <strong>now</strong></p>",
    );
    expect(textToHtml("a < b\n\nc")).toBe("<p>a &lt; b</p><p></p><p>c</p>");
  });
});

describe("quotes", () => {
  it("quotes a reply: sanitized, styles kept, inline images dropped", () => {
    const quote = replyQuote(original, english);
    expect(quote.html).toMatch(/^<div class="gmail_quote">/);
    expect(quote.html).toContain("Anna Berger &lt;anna@example.org&gt; wrote:");
    expect(quote.html).toContain(".big{font-size:20px}");
    expect(quote.html).toContain("<b>there</b>");
    expect(quote.html).not.toContain("<script");
    expect(quote.html).not.toContain("cid:");
    expect(quote.text).toMatch(/wrote:\n> Hello there/);
  });

  it("forwards with a header block and keeps inline images", () => {
    const quote = forwardQuote(original, english);
    expect(quote.html).toContain("---------- Forwarded message ---------");
    expect(quote.html).toContain("Subject: Plans<br>");
    expect(quote.html).toContain("Cc: Bob &lt;bob@example.net&gt;");
    expect(quote.html).toContain('src="cid:logo@x"');
    expect(quote.text).toContain("From: Anna Berger <anna@example.org>");
  });

  it("quotes in German", () => {
    const german: QuoteTexts = {
      ...messages.de.composer.quote,
      locale: "de-AT",
      unknownSender: "Unbekannter Absender",
    };
    expect(replyQuote(original, german).text).toMatch(
      /^Am 18\.10\.2026 um \d\d:\d\d schrieb Anna Berger <anna@example\.org>:\n> Hello/,
    );
    const forward = forwardQuote(original, german).text;
    expect(forward).toMatch(/^---------- Weitergeleitete Nachricht -/);
    expect(forward).toContain("Von: Anna Berger <anna@example.org>");
    expect(forward).toContain("Betreff: Plans");
    expect(forward).toMatch(/Datum: 18\.10\.2026, \d\d:\d\d/);
  });

  it("splits a saved draft into the user's text and the quote", () => {
    const quote = replyQuote(original, english);
    const { html } = mailBody("<p>Thanks!</p>", quote);
    const split = splitQuote(html);
    expect(split.body).toBe("<div>Thanks!</div>");
    expect(split.quote?.html).toContain("wrote:");
    expect(splitQuote("<div>No quote</div>")).toEqual({
      body: "<div>No quote</div>",
    });
  });
});

describe("draftInputOf", () => {
  it("leaves invalid addresses and orphaned inline images out", () => {
    const input = draftInputOf({
      to: [{ address: "anna@example.org" }, { address: "nobody" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      body: "<p>Hello</p>",
      attachments: [
        {
          id: "logo",
          filename: "logo.png",
          mimeType: "image/png",
          size: 3,
          contentId: "logo@x",
          content: new Blob(["png"]),
        },
        {
          id: "file",
          filename: "notes.txt",
          mimeType: "text/plain",
          size: 2,
          content: new Blob(["hi"]),
        },
      ],
    });
    expect(input.to).toEqual([{ address: "anna@example.org" }]);
    // The text doesn't show the picture, so it's left out.
    expect(input.attachments.map((a) => a.id)).toEqual(["file"]);
    expect(input).toMatchObject({ html: "<div>Hello</div>", text: "Hello" });
  });
});

describe("inline images", () => {
  const picture = {
    id: "pic",
    filename: "shot.png",
    mimeType: "image/png",
    size: 10,
    contentId: "pic@action0",
    content: new Blob(["png"]),
  };

  it("go along while the text shows them, shrinking to the window", () => {
    const content = {
      to: [{ address: "anna@example.org" }],
      cc: [],
      bcc: [],
      subject: "Pic",
      body: '<p>Look <img src="cid:pic@action0" alt="shot.png"></p>',
      attachments: [picture],
    };
    const input = draftInputOf(content);
    expect(input.attachments.map((a) => a.id)).toEqual(["pic"]);
    expect(input.html).toContain(
      '<img src="cid:pic@action0" alt="shot.png" style="max-width:100%">',
    );
    expect(sentBytes(content)).toBe(10);
    expect(sentBytes({ ...content, body: "<p>Look</p>" })).toBe(0);
  });
});

describe("signatures", () => {
  const signature = '<b style="color:red">Anna</b>';

  it("go between the text and the quote, as they are", () => {
    const quote = replyQuote(original, english);
    const { html, text } = mailBody("<p>Thanks!</p>", quote, signature);
    expect(html).toBe(
      `<div>Thanks!</div><br><div class="gmail_signature" data-smartmail="gmail_signature">${signature}</div><br>${quote.html}`,
    );
    expect(text.startsWith("Thanks!\n\nAnna\n\n")).toBe(true);
  });

  it("come out of a reopened draft again", () => {
    const { html } = mailBody("<p>Thanks!</p>", undefined, signature);
    expect(splitSignature(html)).toEqual({
      body: "<div>Thanks!</div>",
      signature,
    });
    expect(splitSignature("<div>Hi</div>")).toEqual({ body: "<div>Hi</div>" });
  });

  it("send from the chosen address", () => {
    const input = draftInputOf({
      to: [{ address: "anna@example.org" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      body: "<p>Hello</p>",
      attachments: [],
      from: { name: "Team", address: "team@example.com" },
      signature: { address: "team@example.com", html: "Team" },
    });
    expect(input.from).toEqual({ name: "Team", address: "team@example.com" });
    expect(input.html).toContain('class="gmail_signature"');
  });

  it("are left out when removed", () => {
    const input = draftInputOf({
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "<p>Hello</p>",
      attachments: [],
      signature: null,
    });
    expect(input.html).toBe("<div>Hello</div>");
  });
});
