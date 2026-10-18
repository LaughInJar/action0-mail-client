import type { MailboxRole, StandardMailbox } from "../../core/model";

const en: {
  readonly roles: Readonly<Record<MailboxRole, string>>;
  readonly standard: Readonly<Record<StandardMailbox, string>>;
} = {
  roles: {
    inbox: "Inbox",
    flagged: "Starred",
    important: "Important",
    sent: "Sent",
    drafts: "Drafts",
    all: "All Mail",
    archive: "Archive",
    junk: "Spam",
    trash: "Trash",
  },
  standard: {
    categories: "Categories",
    primary: "Primary",
    social: "Social",
    promotions: "Promotions",
    updates: "Updates",
    forums: "Forums",
  },
};

const de: typeof en = {
  roles: {
    inbox: "Posteingang",
    flagged: "Markiert",
    important: "Wichtig",
    sent: "Gesendet",
    drafts: "Entwürfe",
    all: "Alle Nachrichten",
    archive: "Archiv",
    junk: "Spam",
    trash: "Papierkorb",
  },
  standard: {
    categories: "Kategorien",
    primary: "Allgemein",
    social: "Soziale Netzwerke",
    promotions: "Werbung",
    updates: "Benachrichtigungen",
    forums: "Foren",
  },
};

export const mailboxes = { en, de };
