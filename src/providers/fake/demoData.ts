import {
  asAttachmentId,
  asMailboxId,
  asMessageId,
  asThreadId,
  type MailboxId,
} from "../../core/ids";
import type {
  AttachmentInfo,
  EmailAddress,
  Mailbox,
  Message,
  MessageBody,
} from "../../core/model";
import type { FakeMailData } from "./FakeMailProvider";

/** The demo account's own address. */
export const DEMO_EMAIL = "demo@example.com";

const id = asMailboxId;
const ME: EmailAddress = { name: "Demo User", address: DEMO_EMAIL };

/** Mailbox ids of the demo account, for tests. */
export const DEMO_MAILBOX = {
  inbox: id("inbox"),
  starred: id("starred"),
  sent: id("sent"),
  drafts: id("drafts"),
  all: id("all"),
  spam: id("spam"),
  trash: id("trash"),
  categories: id("categories"),
  social: id("social"),
  promotions: id("promotions"),
  work: id("work"),
  clients: id("work-clients"),
  internal: id("work-internal"),
  personal: id("personal"),
  receipts: id("receipts"),
  archive2019: id("archive-2019"),
} as const;

const M = DEMO_MAILBOX;

const MAILBOX_DEFINITIONS: readonly Omit<Mailbox, "assignable">[] = [
  {
    id: M.inbox,
    name: "Inbox",
    kind: "label",
    role: "inbox",
    selectable: true,
    hidden: false,
  },
  {
    id: M.starred,
    name: "Starred",
    kind: "view",
    role: "flagged",
    selectable: true,
    hidden: false,
  },
  {
    id: M.sent,
    name: "Sent",
    kind: "label",
    role: "sent",
    selectable: true,
    hidden: false,
  },
  {
    id: M.drafts,
    name: "Drafts",
    kind: "label",
    role: "drafts",
    selectable: true,
    hidden: false,
  },
  {
    id: M.all,
    name: "All Mail",
    kind: "view",
    role: "all",
    selectable: true,
    hidden: false,
  },
  {
    id: M.spam,
    name: "Spam",
    kind: "label",
    role: "junk",
    selectable: true,
    hidden: false,
  },
  {
    id: M.trash,
    name: "Trash",
    kind: "label",
    role: "trash",
    selectable: true,
    hidden: false,
  },
  {
    id: M.categories,
    name: "Categories",
    kind: "view",
    selectable: false,
    hidden: false,
  },
  {
    id: M.social,
    name: "Social",
    kind: "label",
    parentId: M.categories,
    selectable: true,
    hidden: false,
  },
  {
    id: M.promotions,
    name: "Promotions",
    kind: "label",
    parentId: M.categories,
    selectable: true,
    hidden: false,
  },
  {
    id: M.archive2019,
    name: "Archive 2019",
    kind: "label",
    selectable: true,
    hidden: true,
  },
  {
    id: M.personal,
    name: "Personal",
    kind: "label",
    selectable: true,
    hidden: false,
    color: { background: "#16a766", text: "#ffffff" },
  },
  {
    id: M.receipts,
    name: "Receipts",
    kind: "label",
    selectable: true,
    hidden: false,
    color: { background: "#ffad47", text: "#000000" },
  },
  {
    id: M.work,
    name: "Work",
    kind: "label",
    selectable: true,
    hidden: false,
    color: { background: "#4a86e8", text: "#ffffff" },
  },
  {
    id: M.clients,
    name: "Clients",
    kind: "label",
    parentId: M.work,
    selectable: true,
    hidden: false,
  },
  {
    id: M.internal,
    name: "Internal",
    kind: "label",
    parentId: M.work,
    selectable: true,
    hidden: false,
  },
];

/** Mailboxes users can move messages into or label with. */
const ASSIGNABLE: ReadonlySet<MailboxId> = new Set([
  M.inbox,
  M.spam,
  M.trash,
  M.archive2019,
  M.personal,
  M.receipts,
  M.work,
  M.clients,
  M.internal,
]);

const MAILBOXES: readonly Mailbox[] = MAILBOX_DEFINITIONS.map((mailbox) => ({
  ...mailbox,
  assignable: ASSIGNABLE.has(mailbox.id),
}));

const PEOPLE: readonly EmailAddress[] = [
  { name: "Anna Berger", address: "anna.berger@example.org" },
  { name: "Lukas Hofer", address: "lukas@example.net" },
  { name: "Mia Steiner", address: "mia.steiner@example.com" },
  { name: "Jonas Gruber", address: "jonas.gruber@example.org" },
  { name: "Sophie Wagner", address: "sophie@example.net" },
  { name: "GitHub", address: "notifications@github.example" },
  { name: "Calendar", address: "calendar-noreply@example.com" },
  { address: "billing@shop.example" },
];

const TOPICS: readonly (readonly [string, string])[] = [
  [
    "Q3 numbers",
    "Here are the final figures for the third quarter. Revenue is up 12%",
  ],
  [
    "Lunch on Thursday?",
    "Are you free for lunch on Thursday? There's a new place around the corner",
  ],
  [
    "[action0] PR #42: Keyboard navigation",
    "lukas requested your review on this pull request",
  ],
  [
    "Invoice 2026-1043",
    "Thank you for your purchase. Your invoice is attached to this email",
  ],
  [
    "Project kickoff notes",
    "Thanks everyone for joining. Action items: 1) finalize scope 2) staffing",
  ],
  [
    "Weekend hiking trip",
    "The weather looks great for Saturday. Meet at the station at 8:00?",
  ],
  [
    "Contract draft v3",
    "I've incorporated the feedback from legal. Main changes are in section 4",
  ],
  [
    "Your weekly summary",
    "You had 14 meetings this week, 3 fewer than last week",
  ],
  [
    "Re: Server migration",
    "Migration is scheduled for Sunday 02:00 CET. Expected downtime: 15 minutes",
  ],
  [
    "Photos from the party",
    "Finally got around to uploading them, the album link is below",
  ],
];

/** Small deterministic PRNG (mulberry32), so the demo looks the same every time. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MessageSeed {
  readonly key: string;
  readonly from: EmailAddress;
  readonly to?: readonly EmailAddress[];
  readonly cc?: readonly EmailAddress[];
  readonly subject: string;
  readonly snippet: string;
  readonly minutesAgo: number;
  readonly mailboxIds: readonly MailboxId[];
  readonly seen?: boolean;
  readonly flagged?: boolean;
  readonly body: MessageBody;
  readonly attachments?: readonly AttachmentInfo[];
}

function buildMessage(seed: MessageSeed, now: number): Message {
  const attachments = seed.attachments ?? [];
  return {
    id: asMessageId(seed.key),
    threadId: asThreadId(`t-${seed.key}`),
    mailboxIds: seed.mailboxIds,
    from: seed.from,
    to: seed.to ?? [ME],
    cc: seed.cc ?? [],
    bcc: [],
    replyTo: [],
    internetMessageId: `<${seed.key}@demo.example>`,
    references: [],
    subject: seed.subject,
    snippet: seed.snippet,
    receivedAt: new Date(now - seed.minutesAgo * 60_000).toISOString(),
    flags: { seen: seed.seen ?? true, flagged: seed.flagged ?? false },
    hasAttachments: attachments.some((a) => a.contentId === undefined),
    body: seed.body,
    attachments,
  };
}

const WELCOME_HTML = `<!doctype html><html><head><style>
  body { font-family: system-ui, sans-serif; color: #1f2937; }
  h1 { font-size: 20px; color: #1d4ed8; }
  kbd { border: 1px solid #cbd5e1; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; font-size: 12px; }
  td { padding: 2px 12px 2px 0; }
</style></head><body>
<h1>Welcome to the action0 demo</h1>
<p>This account lives entirely in your browser. Nothing is sent anywhere.</p>
<p>Try the keyboard:</p>
<table>
  <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>next / previous message</td></tr>
  <tr><td><kbd>Shift</kbd>+<kbd>j</kbd> / <kbd>k</kbd></td><td>extend the selection</td></tr>
  <tr><td><kbd>x</kbd></td><td>select or unselect the current message</td></tr>
  <tr><td><kbd>g</kbd> then <kbd>i</kbd> / <kbd>s</kbd> / <kbd>d</kbd> / <kbd>a</kbd></td><td>go to Inbox / Sent / Drafts / All Mail</td></tr>
  <tr><td><kbd>a</kbd></td><td>archive (<kbd>z</kbd> undoes it)</td></tr>
  <tr><td><kbd>c</kbd>, <kbd>r</kbd>, <kbd>f</kbd></td><td>write, reply, forward</td></tr>
  <tr><td><kbd>Space</kbd></td><td>scroll this message</td></tr>
  <tr><td><kbd>?</kbd></td><td>show all shortcuts</td></tr>
</table>
<p>Mail you send from the demo only goes to the demo's Sent folder; send one to demo@example.com to get it in the Inbox.</p>
<p>The newsletter below shows how remote images are blocked until you allow them.</p>
</body></html>`;

const NEWSLETTER_HTML = `<!doctype html><html><head><style>
  .card { max-width: 560px; margin: 0 auto; font-family: Georgia, serif; }
  .hero { background: url(https://images.example.com/hero.jpg) center / cover; height: 160px; }
</style></head><body>
<div class="card">
  <img src="https://images.example.com/logo.png" alt="Weekly Digest logo" width="120">
  <div class="hero"></div>
  <h2>This week in web development</h2>
  <p>Container queries, view transitions and a closer look at CSS anchor positioning.</p>
  <p><a href="https://example.com/read-more">Read more</a></p>
  <img src="https://tracker.example.com/open.gif?u=demo" width="1" height="1" alt="">
</div>
</body></html>`;

const INLINE_IMAGE_HTML = `<!doctype html><html><body>
<p>Hi,</p>
<p>here's the new logo draft, embedded in the mail itself (no remote request needed):</p>
<p><img src="cid:logo-draft@example.org" alt="Logo draft" width="160"></p>
<p>Cheers,<br>Anna</p>
</body></html>`;

const WIDE_HTML = `<!doctype html><html><body>
<table width="900" cellpadding="8" style="border-collapse: collapse; font-family: Arial, sans-serif;">
  <tr style="background:#1e3a8a;color:#fff"><th>Client</th><th>Project</th><th>Status</th><th>Budget</th><th>Spent</th><th>Due</th><th>Owner</th></tr>
  <tr><td>Acme</td><td>Website relaunch</td><td>On track</td><td>€ 48,000</td><td>€ 21,300</td><td>2026-12-01</td><td>Mia</td></tr>
  <tr style="background:#f1f5f9"><td>Globex</td><td>Mobile app</td><td>At risk</td><td>€ 120,000</td><td>€ 97,450</td><td>2026-11-15</td><td>Jonas</td></tr>
  <tr><td>Initech</td><td>Data migration</td><td>Done</td><td>€ 15,000</td><td>€ 14,200</td><td>2026-09-30</td><td>Anna</td></tr>
</table>
<p style="font-family: Arial, sans-serif">This table is 900px wide, so on a narrow screen it is scaled down or scrolls inside the message.</p>
</body></html>`;

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" rx="12" fill="#2563eb"/><text x="80" y="50" font-family="sans-serif" font-size="28" fill="#fff" text-anchor="middle">action0</text></svg>`;

/** A one-page PDF for the demo invoice. */
const INVOICE_PDF = `%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>
endobj
4 0 obj
<</Length 94>>
stream
BT /F1 20 Tf 30 80 Td (Invoice 2026-1043) Tj 0 -30 Td /F1 12 Tf (Demo shop - thank you!) Tj ET
endstream
endobj
5 0 obj
<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000054 00000 n 
0000000105 00000 n 
0000000217 00000 n 
0000000359 00000 n 
trailer
<</Size 6/Root 1 0 R>>
startxref
422
%%EOF
`;

/** A simple picture for the demo's photo attachments. */
const photo = (sky: string, sun: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="${sky}"/><circle cx="470" cy="120" r="60" fill="${sun}"/><path d="M0 330 L170 200 L300 300 L420 220 L640 360 L640 420 L0 420 Z" fill="#14532d"/></svg>`;

const SPECIAL_MESSAGES: readonly MessageSeed[] = [
  {
    key: "welcome",
    from: { name: "action0", address: "hello@example.com" },
    subject: "Welcome to the demo",
    snippet:
      "This account lives entirely in your browser. Try the keyboard: j / k …",
    minutesAgo: 3,
    mailboxIds: [M.inbox],
    seen: false,
    flagged: true,
    body: { html: WELCOME_HTML, text: "Welcome to the action0 demo." },
  },
  {
    key: "newsletter",
    from: { name: "Weekly Digest", address: "digest@news.example" },
    subject: "This week in web development",
    snippet:
      "Container queries, view transitions and a closer look at CSS anchor positioning.",
    minutesAgo: 47,
    mailboxIds: [M.inbox, M.promotions],
    seen: false,
    body: { html: NEWSLETTER_HTML },
  },
  {
    key: "inline-image",
    from: PEOPLE[0] ?? ME,
    subject: "New logo draft",
    snippet: "here's the new logo draft, embedded in the mail itself",
    minutesAgo: 95,
    mailboxIds: [M.inbox, M.work],
    body: { html: INLINE_IMAGE_HTML },
    attachments: [
      {
        id: asAttachmentId("logo"),
        filename: "logo-draft.svg",
        mimeType: "image/svg+xml",
        size: LOGO_SVG.length,
        contentId: "logo-draft@example.org",
      },
    ],
  },
  {
    key: "plain-text",
    from: PEOPLE[4] ?? ME,
    subject: "Packing list for the weekend",
    snippet: "Plain text mail, rendered without an iframe.",
    minutesAgo: 60 * 5,
    mailboxIds: [M.inbox, M.personal],
    seen: false,
    body: {
      text: "Hi!\n\nPlain text mail, rendered without an iframe.\n\nPacking list:\n- boots\n- rain jacket\n- snacks (lots)\n- a really long line that goes on and on to show that plain text wraps nicely inside the reader pane instead of making it scroll sideways\n\nSee you Saturday,\nSophie",
    },
  },
  {
    key: "photos",
    from: PEOPLE[4] ?? ME,
    subject: "Photos from the hike",
    snippet: "Two pictures from Saturday, and the route as a web page",
    minutesAgo: 60 * 20,
    mailboxIds: [M.inbox, M.personal],
    body: {
      text: "Two pictures from Saturday, and the route as a web page.\n\nSophie",
    },
    attachments: [
      {
        id: asAttachmentId("photo-1"),
        filename: "summit.svg",
        mimeType: "image/svg+xml",
        size: 412,
      },
      {
        id: asAttachmentId("photo-2"),
        filename: "sunset.svg",
        mimeType: "image/svg+xml",
        size: 412,
      },
      {
        id: asAttachmentId("route"),
        filename: "route.html",
        mimeType: "text/html",
        size: 120,
      },
    ],
  },
  {
    key: "invoice",
    from: { name: "Shop", address: "billing@shop.example" },
    subject: "Your invoice 2026-1043",
    snippet: "Thank you for your purchase. Your invoice is attached.",
    minutesAgo: 60 * 26,
    mailboxIds: [M.inbox, M.receipts],
    body: { text: "Thank you for your purchase. Your invoice is attached." },
    attachments: [
      {
        id: asAttachmentId("invoice-pdf"),
        filename: "invoice-2026-1043.pdf",
        mimeType: "application/pdf",
        size: 602,
      },
    ],
  },
  {
    key: "wide",
    from: PEOPLE[2] ?? ME,
    cc: [PEOPLE[3] ?? ME, PEOPLE[0] ?? ME],
    subject: "Client project overview",
    snippet:
      "This table is 900px wide, so on a narrow screen it is scaled down",
    minutesAgo: 60 * 30,
    mailboxIds: [M.inbox, M.clients],
    body: { html: WIDE_HTML },
  },
  {
    key: "sent-1",
    from: ME,
    to: [PEOPLE[1] ?? ME],
    subject: "Re: Server migration",
    snippet: "Sounds good, I'll be on call during the window.",
    minutesAgo: 60 * 3,
    mailboxIds: [M.sent],
    body: { text: "Sounds good, I'll be on call during the window." },
  },
  {
    key: "draft-1",
    from: ME,
    to: [PEOPLE[2] ?? ME],
    subject: "Feedback on the proposal",
    snippet: "First impressions: the structure works, but",
    minutesAgo: 60 * 8,
    mailboxIds: [M.drafts],
    body: { text: "First impressions: the structure works, but" },
  },
  {
    key: "spam-1",
    from: { name: "Prize Department", address: "winner@spam.example" },
    subject: "You have won!!!",
    snippet: "Click here to claim your prize",
    minutesAgo: 60 * 12,
    mailboxIds: [M.spam],
    seen: false,
    body: {
      html: '<p>Click <a href="https://spam.example/claim">here</a> to claim your prize.</p>',
    },
  },
  {
    key: "trash-1",
    from: PEOPLE[6] ?? ME,
    subject: "Cancelled: Standup",
    snippet: "This event has been cancelled.",
    minutesAgo: 60 * 50,
    mailboxIds: [M.trash],
    body: { text: "This event has been cancelled." },
  },
  {
    key: "archived-2019",
    from: PEOPLE[3] ?? ME,
    subject: "Old times",
    snippet: "Found this in a hidden label.",
    minutesAgo: 60 * 24 * 400,
    mailboxIds: [M.archive2019],
    body: { text: "Found this in a hidden label." },
  },
];

/**
 * Builds the demo account's mailboxes and ~200 messages, with timestamps
 * relative to `now`.
 */
export function createDemoData(now = Date.now()): FakeMailData {
  const random = prng(42);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) throw new Error("pick() from an empty list");
    return item;
  };
  const labelPool: readonly MailboxId[] = [
    M.work,
    M.clients,
    M.internal,
    M.personal,
    M.receipts,
    M.social,
  ];

  const generated: MessageSeed[] = Array.from({ length: 190 }, (_, index) => {
    const [subject, snippet] = pick(TOPICS);
    const from = pick(PEOPLE);
    const mailboxIds: MailboxId[] = [];
    if (index < 120 || random() < 0.2) mailboxIds.push(M.inbox);
    if (random() < 0.45) mailboxIds.push(pick(labelPool));
    if (mailboxIds.length === 0) mailboxIds.push(M.work);
    return {
      key: `m${String(index).padStart(3, "0")}`,
      from,
      subject,
      snippet,
      minutesAgo: 60 * 6 + index * 97 + Math.floor(random() * 60),
      mailboxIds,
      seen: index > 8 && random() > 0.08,
      flagged: random() < 0.05,
      body: {
        text: `${snippet}.\n\nThis is generated demo message #${index + 1}.\n\nBest regards,\n${from.name ?? from.address}`,
      },
    };
  });

  const messages = [...SPECIAL_MESSAGES, ...generated].map((seed) =>
    buildMessage(seed, now),
  );
  const attachments = new Map<string, Blob>([
    ["inline-image/logo", new Blob([LOGO_SVG], { type: "image/svg+xml" })],
    [
      "photos/photo-1",
      new Blob([photo("#7dd3fc", "#fde047")], { type: "image/svg+xml" }),
    ],
    [
      "photos/photo-2",
      new Blob([photo("#fb923c", "#dc2626")], { type: "image/svg+xml" }),
    ],
    [
      "photos/route",
      new Blob(
        [
          "<html><body><h1>Route</h1><script>alert('never runs')</script></body></html>",
        ],
        { type: "text/html" },
      ),
    ],
    [
      "invoice/invoice-pdf",
      new Blob([INVOICE_PDF], { type: "application/pdf" }),
    ],
  ]);
  return {
    mailboxes: MAILBOXES,
    messages,
    attachments,
    me: ME,
    contacts: PEOPLE.filter((person) => !person.address.includes("noreply")),
  };
}

/**
 * The `count`th message that "arrives" while the demo is open: unread, in
 * the Inbox, from one of the demo people.
 */
export function createDemoArrival(now: number, count: number): Message {
  const [subject, snippet] = TOPICS[count % TOPICS.length] ?? ["Hello", "Hi"];
  const from = PEOPLE[count % PEOPLE.length] ?? ME;
  return buildMessage(
    {
      key: `arrival-${String(count)}-${String(now)}`,
      from,
      subject,
      snippet,
      minutesAgo: 0,
      mailboxIds: [M.inbox],
      seen: false,
      body: {
        text: `${snippet}.\n\nThis message just arrived in the demo.\n\n${from.name ?? from.address}`,
      },
    },
    now,
  );
}
