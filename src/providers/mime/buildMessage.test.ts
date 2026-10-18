// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeMimeWords } from "../gmail/mime";
import {
  buildMessage,
  encodeQuotedPrintable,
  encodeWords,
  type OutgoingMessage,
} from "./buildMessage";

let counter = 0;
const boundary = () => `b${String(++counter)}`;

const base: OutgoingMessage = {
  to: [{ name: "Anna Berger", address: "anna@example.org" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
};

/** Undoes quoted-printable (test helper). */
function decodeQuotedPrintable(encoded: string): string {
  const bytes: number[] = [];
  const text = encoded.replace(/=\r\n/g, "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=") {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const headerBlock = (raw: string) => raw.split("\r\n\r\n")[0] ?? "";
const unfold = (header: string) => header.replace(/\r\n /g, " ");

describe("buildMessage", () => {
  it("writes 7-bit headers with CRLF and a text/HTML alternative", () => {
    counter = 0;
    const raw = buildMessage(
      {
        ...base,
        cc: [{ name: "Doe, Jane", address: "jane@x.com" }],
        bcc: [{ address: "secret@x.com" }],
        inReplyTo: "<a@x>",
        references: ["<z@x>", "<a@x>"],
        date: new Date(Date.UTC(2026, 9, 18, 12, 0, 0)),
      },
      { boundary },
    );
    expect(raw).toMatch(/^[\t\r\n\x20-\x7e]*$/);
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
    const headers = headerBlock(raw);
    expect(headers).toContain("To: Anna Berger <anna@example.org>");
    expect(headers).toContain('Cc: "Doe, Jane" <jane@x.com>');
    expect(headers).toContain("Bcc: secret@x.com");
    expect(headers).toContain("Subject: Hello");
    expect(headers).toContain("Date: Sun, 18 Oct 2026 12:00:00 +0000");
    expect(headers).toContain("In-Reply-To: <a@x>");
    expect(headers).toContain("References: <z@x> <a@x>");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).not.toContain("From:");
    expect(headers).toContain(
      'Content-Type: multipart/alternative; boundary="b1"',
    );
    expect(raw).toContain(
      "--b1\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHi\r\n--b1\r\nContent-Type: text/html",
    );
    expect(raw.endsWith("--b1--")).toBe(true);
  });

  it("encodes non-ASCII names and subjects as encoded words that decode back", () => {
    const subject =
      "Grüße aus Wien 🎉 – ein ziemlich langer Betreff, der umgebrochen werden muss";
    const raw = buildMessage(
      {
        ...base,
        to: [{ name: "Jürgen Müller", address: "j@x.at" }],
        subject,
      },
      { boundary },
    );
    const headers = headerBlock(raw);
    for (const line of headers.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(78);
    const subjectHeader = /^Subject: .*(\r\n .*)*/m.exec(headers)?.[0] ?? "";
    expect(
      decodeMimeWords(unfold(subjectHeader).slice("Subject: ".length)),
    ).toBe(subject);
    expect(headers).toMatch(/To: =\?UTF-8\?B\?[^?]+\?= <j@x\.at>/);
  });

  it("wraps forwarded files and inline images", () => {
    counter = 0;
    const raw = buildMessage(
      {
        ...base,
        attachments: [
          {
            filename: "Rechnung März.pdf",
            mimeType: "application/pdf",
            content: new Uint8Array(100).fill(65),
          },
          {
            filename: "logo.png",
            mimeType: "image/png",
            content: Uint8Array.from([1, 2, 3]),
            contentId: "logo@x",
          },
        ],
      },
      { boundary },
    );
    const headers = headerBlock(raw);
    expect(headers).toContain('Content-Type: multipart/mixed; boundary="b3"');
    expect(raw).toContain('Content-Type: multipart/related; boundary="b2"');
    expect(raw).toContain(
      "Content-Disposition: attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf",
    );
    expect(raw).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(raw).toContain("Content-ID: <logo@x>");
    expect(raw).toContain("AQID"); // base64 of 1, 2, 3
    for (const line of raw.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(998);
  });
});

describe("encodeQuotedPrintable", () => {
  it("round-trips UTF-8 and keeps lines short", () => {
    const text =
      "Grüße = Hallo\ttab \nline with trailing space \n" + "x".repeat(200);
    const encoded = encodeQuotedPrintable(text);
    for (const line of encoded.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).toContain("=3D");
    expect(encoded).toContain("space=20\r\n");
    expect(decodeQuotedPrintable(encoded)).toBe(text.replace(/\n/g, "\r\n"));
  });

  it("protects leading dots and From lines", () => {
    expect(encodeQuotedPrintable(".\nFrom here")).toBe("=2E\r\n=46rom here");
  });
});

describe("encodeWords", () => {
  it("leaves ASCII alone and never splits a character", () => {
    expect(encodeWords("Plain subject")).toBe("Plain subject");
    const long = "ä".repeat(60);
    const words = encodeWords(long).split(" ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeMimeWords(encodeWords(long))).toBe(long);
  });
});
