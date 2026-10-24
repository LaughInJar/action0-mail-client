// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  authResults,
  decodeWords,
  deliveryPath,
  headerValue,
  parameter,
  parseHeaders,
  rawText,
  sourceSegments,
  splitMessage,
} from "./rawMessage";

const CRLF = "\r\n";

describe("rawText", () => {
  it("reads UTF-8, and Windows-1252 when the bytes aren't UTF-8", () => {
    expect(rawText(new TextEncoder().encode("Grüße"))).toBe("Grüße");
    expect(rawText(Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65]))).toBe(
      "Grüße",
    );
  });
});

describe("parseHeaders", () => {
  it("unfolds headers, keeps their order and skips what isn't one", () => {
    const head = [
      "From nobody Mon Jan  1 00:00:00 2026",
      "Received: from a.example",
      "\tby b.example; Tue, 20 Oct 2026 10:00:00 +0000",
      "Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=",
      "X-Empty:",
    ].join(CRLF);
    expect(parseHeaders(head)).toEqual([
      {
        name: "Received",
        raw: "from a.example by b.example; Tue, 20 Oct 2026 10:00:00 +0000",
        value: "from a.example by b.example; Tue, 20 Oct 2026 10:00:00 +0000",
      },
      {
        name: "Subject",
        raw: "=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=",
        value: "Grüße",
      },
      { name: "X-Empty", raw: "", value: "" },
    ]);
  });

  it("finds a header in any case", () => {
    const headers = parseHeaders("message-id: <a@b>");
    expect(headerValue(headers, "Message-ID")).toBe("<a@b>");
    expect(headerValue(headers, "Date")).toBeUndefined();
  });
});

describe("decodeWords", () => {
  it("decodes B and Q words in any charset", () => {
    expect(decodeWords("=?utf-8?b?R3LDvMOfZQ==?=")).toBe("Grüße");
    expect(decodeWords("=?ISO-8859-1?Q?Gr=FC=DFe_aus_Wien?=")).toBe(
      "Grüße aus Wien",
    );
  });

  it("joins adjacent words, even with a character split between them", () => {
    // "é" (C3 A9) split across two words, with folding space between them.
    expect(decodeWords("=?UTF-8?Q?Caf=C3?= =?UTF-8?Q?=A9?= ouvert")).toBe(
      "Café ouvert",
    );
    expect(decodeWords("Anna =?UTF-8?Q?Gr=C3=BCn?= <a@b>")).toBe(
      "Anna Grün <a@b>",
    );
  });

  it("leaves broken words and unknown charsets readable", () => {
    expect(decodeWords("=?UTF-8?B?***?=")).toBe("=?UTF-8?B?***?=");
    expect(decodeWords("=?x-unknown?Q?abc?=")).toBe("abc");
  });
});

describe("authResults", () => {
  it("reads SPF, DKIM and DMARC with their domains from the topmost header", () => {
    const headers = parseHeaders(
      [
        "Authentication-Results: mx.google.com;",
        "       dkim=pass header.i=@github.com header.s=pf2023 header.b=abc;",
        "       spf=pass (google.com: domain of noreply@github.com designates 192.30.252.1 as permitted sender) smtp.mailfrom=noreply@github.com;",
        "       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=github.com",
        // Lower down: anything could have written it.
        "Authentication-Results: forged.example; spf=pass smtp.mailfrom=evil.example",
      ].join(CRLF),
    );
    expect(authResults(headers)).toEqual([
      { method: "dkim", result: "pass", domain: "github.com" },
      { method: "spf", result: "pass", domain: "github.com" },
      { method: "dmarc", result: "pass", domain: "github.com" },
    ]);
  });

  it("reads Exchange Online's header and failures", () => {
    const headers = parseHeaders(
      "Authentication-Results: spf=softfail (sender IP is 203.0.113.9) smtp.mailfrom=spam.example; dkim=none (message not signed) header.d=none;dmarc=fail action=quarantine header.from=bank.example;compauth=fail reason=000",
    );
    expect(authResults(headers)).toEqual([
      { method: "spf", result: "softfail", domain: "spam.example" },
      { method: "dkim", result: "none", domain: "none" },
      { method: "dmarc", result: "fail", domain: "bank.example" },
    ]);
  });

  it("is empty without the header", () => {
    expect(authResults(parseHeaders("Subject: x"))).toEqual([]);
  });
});

describe("deliveryPath", () => {
  it("lists the hops oldest first with the time each took", () => {
    const headers = parseHeaders(
      [
        "Received: by 2002:a05:6214 with SMTP id x; Tue, 20 Oct 2026 08:12:50 -0700 (PDT)",
        "Received: from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41])",
        "        by mx.google.com with SMTPS id y",
        "        for <me@example.com>; Tue, 20 Oct 2026 08:12:45 -0700 (PDT)",
        "Date: Tue, 20 Oct 2026 15:12:42 +0000",
      ].join(CRLF),
    );
    expect(deliveryPath(headers)).toEqual([
      {
        from: "mail-sor-f41.google.com",
        by: "mx.google.com",
        with: "SMTPS",
        at: Date.parse("2026-10-20T15:12:45Z"),
        delay: 3000,
      },
      {
        by: "2002:a05:6214",
        with: "SMTP",
        at: Date.parse("2026-10-20T15:12:50Z"),
        delay: 5000,
      },
    ]);
  });

  it("copes with unreadable dates and a missing Date header", () => {
    const headers = parseHeaders(
      [
        "Received: from b by c; yesterday",
        "Received: from a by b; Tue, 20 Oct 2026 10:00:00 +0000",
      ].join(CRLF),
    );
    expect(deliveryPath(headers)).toEqual([
      { from: "a", by: "b", at: Date.parse("2026-10-20T10:00:00Z") },
      { from: "b", by: "c" },
    ]);
  });
});

describe("parameter", () => {
  it("reads quoted, plain, RFC 2231 and continued parameters", () => {
    expect(parameter('multipart/mixed; boundary="a b"', "boundary")).toBe(
      "a b",
    );
    expect(parameter("text/plain; charset=utf-8", "CHARSET")).toBe("utf-8");
    expect(
      parameter("attachment; filename*=UTF-8''Gr%C3%BC%C3%9Fe.pdf", "filename"),
    ).toBe("Grüße.pdf");
    expect(
      parameter(
        "attachment; filename*0*=UTF-8''Gr%C3%BC; filename*1=sse.txt",
        "filename",
      ),
    ).toBe("Grüsse.txt");
    expect(
      parameter('image/png; name="=?UTF-8?Q?L=C3=B6we.png?="', "name"),
    ).toBe("Löwe.png");
    expect(parameter("text/plain", "charset")).toBeUndefined();
  });
});

describe("sourceSegments", () => {
  const big = "QUJD".repeat(40_000); // 160 000 characters of base64
  const message = [
    "Subject: Files",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "preamble",
    "--outer",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello",
    "--outer",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    big,
    "--outer",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgo=",
    "--outer--",
    "",
  ].join(CRLF);

  it("leaves out big encoded parts and keeps everything else", () => {
    const segments = sourceSegments(message);
    expect(segments.filter((s) => s.kind === "collapsed")).toEqual([
      {
        kind: "collapsed",
        filename: "report.pdf",
        mimeType: "application/pdf",
        encoding: "base64",
        size: 120_000,
      },
    ]);
    const text = segments
      .map((s) => (s.kind === "text" ? s.text : `[${s.mimeType}]`))
      .join("");
    expect(text).toBe(
      message.replace(`${big}${CRLF}`, `[application/pdf]${CRLF}`),
    );
    // Neighbouring text is one segment.
    expect(segments.map((s) => s.kind)).toEqual(["text", "collapsed", "text"]);
  });

  it("shows everything when nothing is big", () => {
    expect(sourceSegments(message, 1_000_000)).toEqual([
      { kind: "text", text: message },
    ]);
    const plain = `Subject: x${CRLF}${CRLF}${"x".repeat(200_000)}`;
    // Not encoded: it's readable, so it stays.
    expect(sourceSegments(plain)).toEqual([{ kind: "text", text: plain }]);
  });

  it("splits a message at its first empty line", () => {
    expect(splitMessage(`A: 1${CRLF}${CRLF}body${CRLF}${CRLF}more`)).toEqual({
      head: "A: 1",
      separator: `${CRLF}${CRLF}`,
      body: `body${CRLF}${CRLF}more`,
    });
    expect(splitMessage("A: 1")).toEqual({
      head: "A: 1",
      separator: "",
      body: "",
    });
  });
});
