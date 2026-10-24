import type { Rsvp } from "../../core/calendar";

const en = {
  // Entries shared by several context menus.
  select: "Select",
  open: "Open",
  openInNewTab: "Open in a new tab",
  mailFrom: (sender: string) => `Mail from ${sender}`,
  copySender: "Copy sender address",
  copied: (text: string) => `Copied ${text}`,
  couldntCopy: "Couldn’t copy to the clipboard",

  // The folder tree.
  markAllRead: "Mark all as read",
  markedAllRead: (where: string, what: string) =>
    `Marked ${what} in ${where} as read`,
  nothingUnread: (where: string) => `Nothing unread in ${where}.`,
  couldntMarkAllRead: (where: string) =>
    `Couldn’t mark everything in ${where} as read`,

  // Calendar events.
  edit: "Edit",
  delete: "Delete",
  joinMeeting: "Join meeting",
  copyMeetingLink: "Copy meeting link",
  answers: {
    accepted: "Accept",
    tentative: "Maybe",
    declined: "Decline",
  } satisfies Record<Rsvp, string>,
};

const de: typeof en = {
  select: "Auswählen",
  open: "Öffnen",
  openInNewTab: "In neuem Tab öffnen",
  mailFrom: (sender) => `E-Mails von ${sender}`,
  copySender: "Absenderadresse kopieren",
  copied: (text) => `${text} kopiert`,
  couldntCopy: "Kopieren in die Zwischenablage fehlgeschlagen",

  markAllRead: "Alle als gelesen markieren",
  markedAllRead: (where, what) => `${what} in ${where} als gelesen markiert`,
  nothingUnread: (where) => `Nichts Ungelesenes in ${where}.`,
  couldntMarkAllRead: (where) =>
    `Konnte nicht alles in ${where} als gelesen markieren`,

  edit: "Bearbeiten",
  delete: "Löschen",
  joinMeeting: "An Besprechung teilnehmen",
  copyMeetingLink: "Besprechungslink kopieren",
  answers: {
    accepted: "Zusagen",
    tentative: "Vielleicht",
    declined: "Absagen",
  },
};

/** Context menus (right-click, long press). */
export const menus = { en, de };
