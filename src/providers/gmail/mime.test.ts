// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  base64Url,
  leafPart,
  multipart,
  utf8Base64Url,
} from "../../test/gmailFixtures";
import { charsetOf, decodeMimeWords, parsePayload } from "./mime";

describe("parsePayload", () => {
  it("reads a single text/plain body", () => {
    const { body, attachments } = parsePayload(
      leafPart("text/plain", utf8Base64Url("Hello 👋")),
    );
    expect(body).toEqual({ text: "Hello 👋" });
    expect(attachments).toEqual([]);
  });

  it("prefers HTML in multipart/alternative but keeps the text variant", () => {
    const payload = multipart("alternative", [
      leafPart("text/plain", utf8Base64Url("plain"), { partId: "0" }),
      leafPart("text/html", utf8Base64Url("<p>rich</p>"), { partId: "1" }),
    ]);
    expect(parsePayload(payload).body).toEqual({
      html: "<p>rich</p>",
      text: "plain",
    });
  });

  it("collects inline images of multipart/related with their Content-ID", () => {
    const payload = multipart("related", [
      leafPart("text/html", utf8Base64Url('<img src="cid:logo@x">'), {
        partId: "0",
      }),
      leafPart("image/png", "", {
        partId: "1",
        attachmentId: "att-1",
        size: 1234,
        headers: [{ name: "Content-ID", value: "<logo@x>" }],
      }),
    ]);
    const { body, attachments } = parsePayload(payload);
    expect(body.html).toContain("cid:logo@x");
    expect(attachments).toEqual([
      {
        id: "att-1",
        filename: "logo@x",
        mimeType: "image/png",
        size: 1234,
        contentId: "logo@x",
      },
    ]);
  });

  it("treats parts with a filename as attachments, even text ones", () => {
    const payload = multipart("mixed", [
      leafPart("text/plain", utf8Base64Url("body"), { partId: "0" }),
      leafPart("text/plain", "", {
        partId: "1",
        filename: "notes.txt",
        attachmentId: "a1",
        size: 5,
      }),
      leafPart("application/pdf", "", {
        partId: "2",
        filename: "invoice.pdf",
        attachmentId: "a2",
        size: 99,
      }),
    ]);
    const { body, attachments } = parsePayload(payload);
    expect(body).toEqual({ text: "body" });
    expect(attachments.map((a) => a.filename)).toEqual([
      "notes.txt",
      "invoice.pdf",
    ]);
  });

  it("uses a synthetic id for small parts Gmail inlined", () => {
    const payload = multipart("mixed", [
      leafPart("text/plain", utf8Base64Url("body"), { partId: "0" }),
      leafPart("image/gif", "R0lGOD", { partId: "1", filename: "dot.gif" }),
    ]);
    expect(parsePayload(payload).attachments[0]?.id).toBe("part:1");
  });

  it("decodes text with the charset declared on the part", () => {
    // "Grüße" in ISO-8859-1
    const latin1 = base64Url(new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]));
    const part = leafPart("text/plain", latin1);
    part.headers = [
      { name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' },
    ];
    expect(parsePayload(part).body.text).toBe("Grüße");
  });

  it("falls back to UTF-8 for unknown charsets", () => {
    const part = leafPart("text/plain", utf8Base64Url("ok"));
    part.headers = [
      { name: "Content-Type", value: "text/plain; charset=x-unknown" },
    ];
    expect(parsePayload(part).body.text).toBe("ok");
  });

  it("returns an empty body for a missing payload", () => {
    expect(parsePayload(undefined)).toEqual({ body: {}, attachments: [] });
  });
});

describe("charsetOf", () => {
  it.each([
    ["text/plain; charset=utf-8", "utf-8"],
    ['text/html; charset="windows-1252"', "windows-1252"],
    ["text/plain", undefined],
  ])("%s → %s", (header, expected) => {
    expect(charsetOf(header)).toBe(expected);
  });
});

describe("decodeMimeWords", () => {
  it("decodes B and Q encoded words and joins adjacent ones", () => {
    expect(decodeMimeWords("=?UTF-8?B?R3LDvMOfZQ==?=")).toBe("Grüße");
    expect(decodeMimeWords("=?ISO-8859-1?Q?Gr=FC=DFe_aus_Wien?=")).toBe(
      "Grüße aus Wien",
    );
    expect(decodeMimeWords("=?UTF-8?Q?a?= =?UTF-8?Q?b?=")).toBe("ab");
  });

  it("leaves plain text alone", () => {
    expect(decodeMimeWords("Hello =? world")).toBe("Hello =? world");
  });
});
