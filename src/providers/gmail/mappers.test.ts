// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  gmailMessage,
  leafPart,
  multipart,
  utf8Base64Url,
} from "../../test/gmailFixtures";
import { decodeHtmlEntities, toMessage, toMessageSummary } from "./mappers";

describe("toMessageSummary", () => {
  it("maps labels to memberships and flags", () => {
    const summary = toMessageSummary(
      gmailMessage("m1", {
        labelIds: ["INBOX", "UNREAD", "STARRED", "Label_7", "CATEGORY_UPDATES"],
      }),
    );
    expect(summary.mailboxIds).toEqual([
      "INBOX",
      "Label_7",
      "CATEGORY_UPDATES",
    ]);
    expect(summary.flags).toEqual({ seen: false, flagged: true });
  });

  it("parses headers and uses internalDate as the receive time", () => {
    const summary = toMessageSummary(
      gmailMessage("m1", {
        internalDate: "1760000000000",
        snippet: "It&#39;s &amp; done",
      }),
    );
    expect(summary).toMatchObject({
      id: "m1",
      threadId: "t-m1",
      from: { name: "Anna Berger", address: "anna@example.org" },
      to: [{ address: "me@example.com" }],
      subject: "Subject m1",
      snippet: "It's & done",
      receivedAt: new Date(1760000000000).toISOString(),
    });
  });

  it("guesses attachments from a top-level multipart/mixed", () => {
    const withAttachment = gmailMessage("m1", {
      headers: [{ name: "Content-Type", value: "multipart/mixed; boundary=x" }],
    });
    expect(toMessageSummary(withAttachment).hasAttachments).toBe(true);
    expect(toMessageSummary(gmailMessage("m2")).hasAttachments).toBe(false);
  });
});

describe("toMessage", () => {
  it("includes body, recipients and real attachments", () => {
    const message = toMessage(
      gmailMessage("m1", {
        headers: [
          { name: "Cc", value: "Bob <bob@example.org>" },
          { name: "Reply-To", value: "list@example.org" },
        ],
        payload: multipart("mixed", [
          multipart("related", [
            leafPart(
              "text/html",
              utf8Base64Url('<p>Hi</p><img src="cid:i1">'),
              { partId: "0.0" },
            ),
            leafPart("image/png", "", {
              partId: "0.1",
              attachmentId: "inline",
              headers: [{ name: "Content-ID", value: "<i1>" }],
            }),
          ]),
          leafPart("application/pdf", "", {
            partId: "1",
            filename: "a.pdf",
            attachmentId: "pdf",
          }),
        ]),
      }),
    );
    expect(message.body.html).toBe('<p>Hi</p><img src="cid:i1">');
    expect(message.cc).toEqual([{ name: "Bob", address: "bob@example.org" }]);
    expect(message.replyTo).toEqual([{ address: "list@example.org" }]);
    expect(message.attachments.map((a) => a.id)).toEqual(["inline", "pdf"]);
    expect(message.hasAttachments).toBe(true);
  });

  it("does not count inline images as attachments", () => {
    const message = toMessage(
      gmailMessage("m1", {
        payload: multipart("related", [
          leafPart("text/html", utf8Base64Url('<img src="cid:i1">')),
          leafPart("image/png", "", {
            attachmentId: "x",
            headers: [{ name: "Content-ID", value: "<i1>" }],
          }),
        ]),
      }),
    );
    expect(message.hasAttachments).toBe(false);
  });

  it("reads how to unsubscribe from mailing lists", () => {
    const message = toMessage(
      gmailMessage("m1", {
        headers: [
          {
            name: "List-Unsubscribe",
            value:
              "<mailto:leave@lists.example?subject=stop>, <https://lists.example/u/1>",
          },
          {
            name: "List-Unsubscribe-Post",
            value: "List-Unsubscribe=One-Click",
          },
        ],
      }),
    );
    expect(message.unsubscribe).toEqual({
      oneClick: "https://lists.example/u/1",
      mail: { to: "leave@lists.example", subject: "stop" },
      page: "https://lists.example/u/1",
    });
    expect(toMessage(gmailMessage("m2")).unsubscribe).toBeUndefined();
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes numeric and common named entities", () => {
    expect(
      decodeHtmlEntities("&lt;b&gt; &quot;x&quot; &#x1F600; &#8364; &nbsp;"),
    ).toBe('<b> "x" 😀 €  ');
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });
});

describe("invitations", () => {
  it("reads the invitation from the mail's calendar part", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:design@example.org",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const message = toMessage(
      gmailMessage("m1", {
        payload: multipart("mixed", [
          multipart("alternative", [
            leafPart("text/plain", utf8Base64Url("You're invited")),
            leafPart("text/calendar", utf8Base64Url(ics), { partId: "0.1" }),
          ]),
          leafPart("application/ics", utf8Base64Url(ics), {
            filename: "invite.ics",
            attachmentId: "att-1",
          }),
        ]),
      }),
    );
    expect(message.invitation).toEqual({
      uid: "design@example.org",
      method: "request",
    });
    expect(message.body.text).toBe("You're invited");
  });

  it("leaves other mail alone", () => {
    expect(
      toMessage(
        gmailMessage("m1", {
          payload: leafPart("text/plain", utf8Base64Url("Hi")),
        }),
      ).invitation,
    ).toBeUndefined();
  });
});
