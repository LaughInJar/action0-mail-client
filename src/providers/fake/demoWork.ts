import {
  asMailboxId,
  asMessageId,
  asThreadId,
  type MailboxId,
} from "../../core/ids";
import type {
  EmailAddress,
  Mailbox,
  MailboxRole,
  Message,
} from "../../core/model";
import { OUTLOOK_CATEGORY_COLORS } from "../microsoft/folders";
import type { FakeMailData } from "./FakeMailProvider";

/** The second demo account's address: a work account that works like Outlook. */
export const WORK_EMAIL = "demo@work.example";

const ME: EmailAddress = { name: "Demo User", address: WORK_EMAIL };

/** Mailbox ids of the work demo account. */
export const WORK_MAILBOX = {
  inbox: asMailboxId("w-inbox"),
  drafts: asMailboxId("w-drafts"),
  sent: asMailboxId("w-sent"),
  archive: asMailboxId("w-archive"),
  junk: asMailboxId("w-junk"),
  trash: asMailboxId("w-trash"),
  flagged: asMailboxId("w-flagged"),
  projects: asMailboxId("w-projects"),
  website: asMailboxId("w-website"),
  clients: asMailboxId("w-clients"),
  categories: asMailboxId("w-categories"),
  followUp: asMailboxId("w-cat-follow-up"),
  important: asMailboxId("w-cat-important"),
  team: asMailboxId("w-cat-team"),
} as const;

/** Outlook's colour for a category preset (`preset<n>`). */
const preset = (n: number) => {
  const color = OUTLOOK_CATEGORY_COLORS[n];
  if (!color) throw new Error(`No category preset ${String(n)}`);
  return color;
};

/** A category: a label in the categories' group, like Outlook's in action0. */
function category(id: MailboxId, name: string, color: number): Mailbox {
  return {
    id,
    name,
    kind: "label",
    parentId: asMailboxId("w-categories"),
    selectable: true,
    hidden: false,
    assignable: true,
    color: preset(color),
  };
}

const W = WORK_MAILBOX;

function folder(
  id: MailboxId,
  name: string,
  role?: MailboxRole,
  parentId?: MailboxId,
): Mailbox {
  return {
    id,
    name,
    kind: "folder",
    ...(role ? { role } : {}),
    ...(parentId ? { parentId } : {}),
    selectable: true,
    hidden: false,
    assignable: role !== "drafts" && role !== "sent",
  };
}

const MAILBOXES: readonly Mailbox[] = [
  folder(W.inbox, "Inbox", "inbox"),
  folder(W.drafts, "Drafts", "drafts"),
  folder(W.sent, "Sent Items", "sent"),
  folder(W.archive, "Archive", "archive"),
  folder(W.junk, "Junk Email", "junk"),
  folder(W.trash, "Deleted Items", "trash"),
  {
    id: W.flagged,
    name: "Flagged",
    kind: "view",
    role: "flagged",
    selectable: true,
    hidden: false,
    assignable: false,
  },
  folder(W.projects, "Projects"),
  folder(W.website, "Website relaunch", undefined, W.projects),
  folder(W.clients, "Clients"),
  {
    id: W.categories,
    standard: "categories",
    name: "Categories",
    kind: "view",
    selectable: false,
    hidden: false,
    assignable: false,
  },
  category(W.followUp, "Follow up", 1),
  category(W.important, "Important client", 0),
  category(W.team, "Team", 7),
];

const COLLEAGUES: readonly EmailAddress[] = [
  { name: "Mira Hofer", address: "mira.hofer@work.example" },
  { name: "Jonas Weber", address: "jonas.weber@work.example" },
  { name: "Priya Nair", address: "priya.nair@work.example" },
  { name: "Tom Brandt", address: "tom.brandt@work.example" },
  { name: "IT Service Desk", address: "it@work.example" },
];

const TOPICS: readonly (readonly [string, string])[] = [
  ["Sprint review notes", "Here are the notes from today's review"],
  ["Budget for Q4", "Could you check the numbers before Thursday"],
  [
    "Website relaunch: new mockups",
    "The latest mockups are in the shared folder",
  ],
  ["Customer call follow-up", "Thanks for joining the call, next steps below"],
  ["Laptop replacement", "Your new laptop is ready for pickup"],
  ["Team offsite", "Please vote for a date in the poll"],
  ["Contract renewal", "The renewal is due at the end of the month"],
  ["Release checklist", "Two items are still open before we ship"],
  ["Hiring: interview slots", "Can you take one of the slots next week"],
  ["Weekly metrics", "Signups are up 4% compared to last week"],
];

interface Seed {
  readonly key: string;
  readonly from: EmailAddress;
  readonly to?: readonly EmailAddress[];
  readonly subject: string;
  readonly snippet: string;
  readonly minutesAgo: number;
  readonly mailboxId: MailboxId;
  readonly seen?: boolean;
  readonly flagged?: boolean;
  readonly thread?: string;
  readonly categories?: readonly MailboxId[];
}

function buildMessage(seed: Seed, now: number): Message {
  return {
    id: asMessageId(seed.key),
    threadId: asThreadId(`wt-${seed.thread ?? seed.key}`),
    mailboxIds: [seed.mailboxId, ...(seed.categories ?? [])],
    from: seed.from,
    to: seed.to ?? [ME],
    cc: [],
    bcc: [],
    replyTo: [],
    internetMessageId: `<${seed.key}@work.example>`,
    references: [],
    subject: seed.subject,
    snippet: seed.snippet,
    receivedAt: new Date(now - seed.minutesAgo * 60_000).toISOString(),
    flags: { seen: seed.seen ?? true, flagged: seed.flagged ?? false },
    hasAttachments: false,
    body: {
      text: `${seed.snippet}.\n\nThis is a message of the second demo account.\n\n${seed.from.name ?? seed.from.address}`,
    },
    attachments: [],
  };
}

/**
 * The second demo account: about 40 messages in Outlook-style folders,
 * their times between the first demo account's, so All inboxes mixes them.
 */
export function createWorkDemoData(now = Date.now()): FakeMailData {
  const generated: Seed[] = Array.from({ length: 36 }, (_, index) => {
    const [subject, snippet] = TOPICS[index % TOPICS.length] ?? ["Hi", "Hello"];
    const from = COLLEAGUES[index % COLLEAGUES.length] ?? ME;
    const mailboxId =
      index % 9 === 4 ? W.website : index % 11 === 7 ? W.clients : W.inbox;
    return {
      key: `w${String(index).padStart(3, "0")}`,
      from,
      subject,
      snippet,
      minutesAgo: 45 + index * 173,
      mailboxId,
      seen: index > 2,
      flagged: index === 5,
      ...(index % 7 === 1
        ? { categories: [W.followUp] }
        : index % 9 === 6
          ? { categories: [W.team] }
          : {}),
    };
  });
  const specials: Seed[] = [
    // A conversation with your reply in Sent Items.
    {
      key: "w-plan-1",
      thread: "plan",
      from: COLLEAGUES[0] ?? ME,
      subject: "Planning for next quarter",
      snippet: "Let's collect the topics for the planning session",
      minutesAgo: 600,
      mailboxId: W.inbox,
      categories: [W.team],
    },
    {
      key: "w-plan-2",
      thread: "plan",
      from: ME,
      to: [COLLEAGUES[0] ?? ME],
      subject: "Re: Planning for next quarter",
      snippet: "I'll add the website relaunch",
      minutesAgo: 560,
      mailboxId: W.sent,
    },
    {
      key: "w-plan-3",
      thread: "plan",
      from: COLLEAGUES[0] ?? ME,
      subject: "Re: Planning for next quarter",
      snippet: "Great, then we're complete",
      minutesAgo: 30,
      mailboxId: W.inbox,
      seen: false,
      categories: [W.team, W.important],
    },
    {
      key: "w-old",
      from: COLLEAGUES[3] ?? ME,
      subject: "Last year's report",
      snippet: "For reference, the report from last year",
      minutesAgo: 60 * 24 * 90,
      mailboxId: W.archive,
    },
  ];
  return {
    folders: true,
    me: ME,
    mailboxes: MAILBOXES,
    messages: [...specials, ...generated].map((seed) =>
      buildMessage(seed, now),
    ),
    contacts: COLLEAGUES,
    mailboxColors: OUTLOOK_CATEGORY_COLORS,
  };
}

/** The `count`th message that arrives in the work demo account. */
export function createWorkArrival(now: number, count: number): Message {
  const [subject, snippet] = TOPICS[(count + 3) % TOPICS.length] ?? [
    "Hello",
    "Hi",
  ];
  const from = COLLEAGUES[count % COLLEAGUES.length] ?? ME;
  return buildMessage(
    {
      key: `w-arrival-${String(count)}-${String(now)}`,
      from,
      subject,
      snippet,
      minutesAgo: 0,
      mailboxId: W.inbox,
      seen: false,
    },
    now,
  );
}
