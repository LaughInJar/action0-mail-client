// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  forwardSubject,
  replyRecipients,
  replySubject,
  threadingFor,
} from "./compose";
import { asMessageId, asThreadId } from "./ids";
import type { EmailAddress, Message } from "./model";

const ME = "me@example.com";
const anna: EmailAddress = { name: "Anna", address: "anna@example.org" };
const bob: EmailAddress = { address: "bob@example.net" };
const carol: EmailAddress = { name: "Carol", address: "carol@example.com" };
const me: EmailAddress = { name: "Me", address: "ME@example.com" };

function original(extra: Partial<Message> = {}): Message {
  return {
    id: asMessageId("m1"),
    threadId: asThreadId("t1"),
    mailboxIds: [],
    from: anna,
    to: [me, bob],
    cc: [carol],
    bcc: [],
    replyTo: [],
    internetMessageId: "<m1@example.org>",
    references: ["<m0@example.org>"],
    subject: "Plans",
    snippet: "",
    receivedAt: "2026-10-18T10:00:00Z",
    flags: { seen: true, flagged: false },
    hasAttachments: false,
    body: { text: "Hi" },
    attachments: [],
    ...extra,
  };
}

describe("replyRecipients", () => {
  it("replies to the sender, or to Reply-To when set", () => {
    expect(replyRecipients(original(), "reply", [ME])).toEqual({
      to: [anna],
      cc: [],
    });
    const list: EmailAddress = { address: "list@example.org" };
    expect(
      replyRecipients(original({ replyTo: [list] }), "reply", [ME]).to,
    ).toEqual([list]);
  });

  it("reply all adds To and Cc without me and without duplicates", () => {
    expect(
      replyRecipients(original({ cc: [carol, anna, me] }), "reply-all", [ME]),
    ).toEqual({ to: [anna, bob], cc: [carol] });
  });

  it("goes back to the original recipients when replying to my own mail", () => {
    const sent = original({ from: me, to: [bob], cc: [carol] });
    expect(replyRecipients(sent, "reply", [ME])).toEqual({
      to: [bob],
      cc: [],
    });
    expect(replyRecipients(sent, "reply-all", [ME])).toEqual({
      to: [bob],
      cc: [carol],
    });
    // A note to self stays a note to self.
    expect(
      replyRecipients(original({ from: me, to: [me], cc: [] }), "reply", [ME])
        .to,
    ).toEqual([me]);
  });
});

describe("subjects", () => {
  it("adds Re: and Fwd: once", () => {
    expect(replySubject("Plans")).toBe("Re: Plans");
    expect(replySubject("RE: Plans")).toBe("RE: Plans");
    expect(replySubject("AW: Pläne")).toBe("AW: Pläne");
    expect(replySubject("")).toBe("Re:");
    expect(forwardSubject("Plans")).toBe("Fwd: Plans");
    expect(forwardSubject("Fw: Plans")).toBe("Fw: Plans");
    expect(forwardSubject("WG: Pläne")).toBe("WG: Pläne");
    expect(forwardSubject("Re: Plans")).toBe("Fwd: Re: Plans");
  });
});

describe("threadingFor", () => {
  it("references the conversation and replies to the message", () => {
    expect(threadingFor(original())).toEqual({
      threadId: "t1",
      inReplyTo: "<m1@example.org>",
      references: ["<m0@example.org>", "<m1@example.org>"],
    });
    const { internetMessageId, ...withoutId } = original();
    expect(threadingFor(withoutId)).toEqual({
      threadId: "t1",
      references: ["<m0@example.org>"],
    });
  });
});
