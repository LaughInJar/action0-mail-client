import {
  asMailboxId,
  asMessageId,
  asThreadId,
  type MailboxId,
} from "../core/ids";
import type { Mailbox, MailboxRole, Message } from "../core/model";
import { DEMO_EMAIL } from "../providers/fake/demoData";
import type { FakeMailData } from "../providers/fake/FakeMailProvider";

/** Mailbox ids of {@link createFolderData}. */
export const FOLDER = {
  inbox: asMailboxId("f-inbox"),
  drafts: asMailboxId("f-drafts"),
  sent: asMailboxId("f-sent"),
  archive: asMailboxId("f-archive"),
  junk: asMailboxId("f-junk"),
  trash: asMailboxId("f-trash"),
  flagged: asMailboxId("v-flagged"),
  projects: asMailboxId("f-projects"),
} as const;

function folder(id: MailboxId, name: string, role?: MailboxRole): Mailbox {
  return {
    id,
    name,
    kind: "folder",
    ...(role ? { role } : {}),
    selectable: true,
    hidden: false,
    assignable: role !== "drafts" && role !== "sent",
  };
}

function message(
  id: string,
  subject: string,
  mailboxId: MailboxId,
  hoursAgo: number,
  now: number,
  extra: Partial<Message> = {},
): Message {
  return {
    id: asMessageId(id),
    threadId: asThreadId(`c-${id}`),
    mailboxIds: [mailboxId],
    from: { name: "Anna Berger", address: "anna@example.com" },
    to: [{ address: DEMO_EMAIL }],
    cc: [],
    bcc: [],
    replyTo: [],
    references: [],
    subject,
    snippet: `About ${subject.toLowerCase()}`,
    receivedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
    flags: { seen: true, flagged: false },
    hasAttachments: false,
    body: { text: `About ${subject.toLowerCase()}.` },
    attachments: [],
    ...extra,
  };
}

/** A small account that works like Outlook: folders, with Outlook's names. */
export function createFolderData(now: number): FakeMailData {
  return {
    folders: true,
    me: { name: "Demo User", address: DEMO_EMAIL },
    mailboxes: [
      folder(FOLDER.inbox, "Inbox", "inbox"),
      folder(FOLDER.drafts, "Drafts", "drafts"),
      folder(FOLDER.sent, "Sent Items", "sent"),
      folder(FOLDER.archive, "Archive", "archive"),
      folder(FOLDER.junk, "Junk Email", "junk"),
      folder(FOLDER.trash, "Deleted Items", "trash"),
      {
        id: FOLDER.flagged,
        name: "Flagged",
        kind: "view",
        role: "flagged",
        selectable: true,
        hidden: false,
        assignable: false,
      },
      folder(FOLDER.projects, "Projects"),
    ],
    messages: [
      message("quarterly", "Quarterly numbers", FOLDER.inbox, 1, now),
      message("lunch", "Lunch on Friday", FOLDER.inbox, 3, now),
      message("kickoff", "Project kickoff", FOLDER.projects, 24, now),
      // A conversation in the Inbox with your reply in Sent Items.
      message("plan-1", "Trip plan", FOLDER.inbox, 50, now, {
        threadId: asThreadId("c-trip"),
        flags: { seen: true, flagged: true },
      }),
      message("plan-2", "Re: Trip plan", FOLDER.sent, 49, now, {
        threadId: asThreadId("c-trip"),
        from: { name: "Demo User", address: DEMO_EMAIL },
        to: [{ name: "Anna Berger", address: "anna@example.com" }],
      }),
      message("plan-3", "Re: Trip plan", FOLDER.inbox, 48, now, {
        threadId: asThreadId("c-trip"),
        flags: { seen: false, flagged: false },
      }),
      message("receipt", "Old receipt", FOLDER.archive, 240, now),
    ],
  };
}
