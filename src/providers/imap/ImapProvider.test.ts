// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MailServerError } from "../../accounts/mailServer";
import { isMailError } from "../../core/errors";
import { asDraftId, asMailboxId, asMessageId } from "../../core/ids";
import { MemoryStorage } from "../../test/memoryStorage";
import { fakeImapBridge, imapMessage } from "../../test/imapBridge";
import { ImapProvider } from "./ImapProvider";

const me = "me@example.com";

function provider(
  options: Parameters<typeof fakeImapBridge>[0] = {},
  extra: Partial<ConstructorParameters<typeof ImapProvider>[0]> = {},
) {
  const fake = fakeImapBridge(options);
  const settings = new MemoryStorage();
  const onAuthFailed = vi.fn();
  const imap = new ImapProvider({
    bridge: fake.bridge,
    key: `imap:${me}`,
    address: me,
    name: "Me",
    service: "imap.example.com",
    settings,
    signatureKey: "a0.settings.signatures.imap:me@example.com",
    onAuthFailed,
    ...extra,
  });
  return { ...fake, imap, settings, onAuthFailed };
}

const draft = {
  to: [{ name: "Anna", address: "anna@example.org" }],
  cc: [],
  bcc: [{ address: "secret@example.net" }],
  subject: "Plans",
  html: "<p>Hi</p>",
  text: "Hi",
  attachments: [],
};

describe("ImapProvider", () => {
  it("is a folder account whose size limit leaves room for encoding", () => {
    const { imap } = provider({}, { maxBytes: 10 * 1024 * 1024 });
    expect(imap.capabilities).toMatchObject({
      mailboxKinds: ["folder", "view"],
      labels: false,
      threads: true,
      rawSource: true,
      signatureStore: "browser",
    });
    expect(imap.capabilities.maxAttachmentBytes).toBe(
      Math.floor((10 * 1024 * 1024) / 1.37),
    );
  });

  it("archives into Archive, creating it first if the account has none", async () => {
    const { imap, store, folders } = provider({
      messages: [imapMessage("m1", "f:INBOX")],
    });
    await imap.archive([asMessageId("m1")]);
    const archive = folders.find((folder) => folder.role === "archive");
    expect(archive?.name).toBe("Archive");
    expect(store.get("m1")?.message.mailboxIds).toEqual([archive?.id]);
    await imap.unarchive([asMessageId("m1")]);
    expect(store.get("m1")?.message.mailboxIds).toEqual(["f:INBOX"]);
  });

  it("puts mail into Trash and Junk, and back into the Inbox", async () => {
    const { imap, store } = provider({
      messages: [imapMessage("m1", "f:INBOX")],
    });
    await imap.trash([asMessageId("m1")]);
    expect(store.get("m1")?.message.mailboxIds).toEqual(["f:Trash"]);
    await imap.untrash([asMessageId("m1")]);
    await imap.reportSpam([asMessageId("m1")]);
    expect(store.get("m1")?.message.mailboxIds).toEqual(["f:Junk"]);
    await imap.notSpam([asMessageId("m1")]);
    expect(store.get("m1")?.message.mailboxIds).toEqual(["f:INBOX"]);
  });

  it("empties only Trash and Junk", async () => {
    const { imap } = provider({
      messages: [imapMessage("m1", "f:Trash"), imapMessage("m2", "f:INBOX")],
    });
    expect(await imap.emptyMailbox(asMailboxId("f:Trash"))).toEqual({
      deleted: 1,
    });
    await expect(imap.emptyMailbox(asMailboxId("f:INBOX"))).rejects.toThrow(
      /Only Trash and Junk/,
    );
  });

  it("saves drafts in Drafts, replacing the version before", async () => {
    const { imap, store, appended } = provider();
    const first = await imap.saveDraft(draft);
    expect(appended[0]).toMatchObject({
      mailboxId: "f:Drafts",
      flags: ["\\Draft", "\\Seen"],
    });
    expect(appended[0]?.raw).toContain("Subject: Plans");
    expect(appended[0]?.raw).toContain("From: Me <me@example.com>");
    expect(appended[0]?.raw).toMatch(/Message-ID: <[0-9a-f]+@example\.com>/);
    const second = await imap.saveDraft({ ...draft, id: first.id });
    expect(store.has(first.messageId)).toBe(false);
    expect(store.has(second.messageId)).toBe(true);
    expect(await imap.draftIdOf(second.messageId)).toBe(second.id);
  });

  it("sends over SMTP without Bcc, keeps a copy with it in Sent, and deletes the draft", async () => {
    const { imap, sent, appended, store } = provider();
    const { id } = await imap.saveDraft(draft);
    const result = await imap.sendDraft({ ...draft, id });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.envelope).toEqual({
      from: me,
      to: ["anna@example.org", "secret@example.net"],
    });
    expect(sent[0]?.raw).not.toContain("secret@example.net");
    const copy = appended.find((entry) => entry.mailboxId === "f:Sent");
    expect(copy?.flags).toEqual(["\\Seen"]);
    expect(copy?.raw).toContain("Bcc: secret@example.net");
    // The same Message-ID went out and was kept.
    const messageId = /Message-ID: (.*)/.exec(sent[0]?.raw ?? "")?.[1];
    expect(copy?.raw).toContain(`Message-ID: ${messageId ?? "?"}`);
    expect(store.has(id)).toBe(false);
    expect(store.get(result.messageId)?.message.mailboxIds).toEqual(["f:Sent"]);
  });

  it("doesn't add a Sent copy when the server keeps one itself", async () => {
    const { imap, appended } = provider({}, { savesSent: true });
    const { id } = await imap.saveDraft(draft);
    await imap.sendDraft({ ...draft, id });
    expect(appended.filter((entry) => entry.mailboxId === "f:Sent")).toEqual(
      [],
    );
  });

  it("reads a draft back for editing", async () => {
    const { imap } = provider({
      messages: [
        imapMessage("d1", "f:Drafts", {
          draft: true,
          body: { text: "Line one\nLine two" },
          inReplyTo: "<a@x>",
          references: ["<z@x>", "<a@x>"],
          attachments: [
            {
              id: "2",
              filename: "plan.pdf",
              mimeType: "application/pdf",
              size: 10,
            },
          ],
        }),
      ],
    });
    const saved = await imap.getDraft(asDraftId("d1"));
    expect(saved.html).toBe("<div>Line one<br>Line two</div>");
    expect(saved.threading).toMatchObject({
      inReplyTo: "<a@x>",
      references: ["<z@x>", "<a@x>"],
    });
    expect(saved.attachments[0]).toMatchObject({
      filename: "plan.pdf",
      source: { messageId: "d1", attachmentId: "2" },
    });
  });

  it("keeps signatures in the app and sends from the account's address", async () => {
    const { imap } = provider();
    await imap.updateSignature(me, "<p>Me</p>");
    expect(await imap.listSenders()).toEqual([
      { address: me, name: "Me", isDefault: true, signature: "<p>Me</p>" },
    ]);
  });

  it("turns a refused login into auth-required and says so", async () => {
    const { imap, bridge, onAuthFailed } = provider();
    vi.spyOn(bridge, "call").mockRejectedValue(
      new MailServerError("auth", "AUTHENTICATIONFAILED"),
    );
    const error: unknown = await imap.listMailboxes().catch((e: unknown) => e);
    expect(isMailError(error, "auth-required")).toBe(true);
    expect(onAuthFailed).toHaveBeenCalled();
  });

  it("names an existing folder when creating one fails", async () => {
    const { imap } = provider();
    const error: unknown = await imap
      .createMailbox({ name: "Trash" })
      .catch((e: unknown) => e);
    expect(isMailError(error)).toBe(true);
    expect(isMailError(error) && error.params).toEqual({ name: "Trash" });
  });
});
