import { plural } from "../plural";

const en = {
  titles: {
    new: "New message",
    reply: "Reply",
    "reply-all": "Reply all",
    forward: "Forward",
    draft: "Draft",
  },
  addRecipient: "Add at least one recipient.",
  invalidAddress: (address: string) => `“${address}” isn’t a valid address.`,
  suggestions: "Suggestions",
  notAnAddress: "Not a valid address",
  fromRecentMail: (why: string) =>
    `${why} Suggestions come from your recent mail.`,
  tooBigToSend: (size: string, limit: string) =>
    `The attachments add up to ${size}; the limit is ${limit}. Remove some to send.`,
  tooBigToAdd: (count: number, size: string, limit: string) =>
    `With ${plural(count, "this file", "these files")} the mail would carry ${size} of attachments; the limit is ${limit}.`,
  tooBigToAttach: (size: string, limit: string) =>
    `Too big to attach: the mail would carry ${size}; the limit is ${limit}.`,
  retry: "Retry",
  closeKeepsDraft: "Close (keeps the draft)",
  closeEscKeepsDraft: "Close (Esc, keeps the draft)",
  send: "Send",
  sendKey: "Ctrl+Enter",
  restore: "Restore",
  minimize: "Minimize",
  smaller: "Smaller",
  larger: "Larger",
  ccBcc: "Cc/Bcc",
  subject: "Subject",
  noSubjectAsk: "Send without a subject?",
  sendAnyway: "Send anyway",
  attachFiles: "Attach files",
  discardDraft: "Discard draft",
  dropHint:
    "Drop files to attach them. Pictures dropped into the text appear inline.",
  signature: "Signature",
  removeSignature: "Remove the signature",
  quoted: (forward: boolean): string =>
    forward ? "Forwarded message" : "Quoted text",
  showQuoted: (forward: boolean): string =>
    `Show the ${forward ? "forwarded message" : "quoted text"}`,
  hideQuoted: (forward: boolean): string =>
    `Hide the ${forward ? "forwarded message" : "quoted text"}`,
  quotedFrame: (forward: boolean): string =>
    `The ${forward ? "forwarded message" : "quoted text"}`,
  removeItem: (name: string) => `Remove ${name}`,
  editor: {
    message: "Message",
    placeholder: "Write your message…",
    formatting: "Formatting",
    bold: "Bold (Ctrl+B)",
    italic: "Italic (Ctrl+I)",
    underline: "Underline (Ctrl+U)",
    link: "Link (Ctrl+K)",
    bulleted: "Bulleted list",
    numbered: "Numbered list",
    quote: "Quote",
    clear: "Clear formatting",
    linkField: "Link",
    linkPlaceholder: "https://… or an email address",
    apply: "Apply",
    removeLink: "Remove link",
  },
  sending: (subject: string) => `Sending “${subject}”…`,
  sendingIn: (subject: string, seconds: number) =>
    `Sending “${subject}” in ${seconds} s`,
  sendNow: "Send now",
  sent: "Message sent",
  couldntSave: (why: string) => `Couldn’t save the draft: ${why}`,
  couldntSend: (why: string) => `Couldn’t send: ${why} It’s in Drafts.`,
  couldntReply: "Couldn’t reply",
  couldntForward: "Couldn’t forward",
  couldntOpenDraft: "Couldn’t open the draft",
  couldntDeleteDraft: "Couldn’t delete the draft",
  draftDiscarded: "Draft discarded",
  quote: {
    /** The line above a reply's quote. */
    wrote: (when: Date, locale: string, sender: string) =>
      `On ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(when)}, ${sender} wrote:`,
    forwarded: "---------- Forwarded message ---------",
    from: "From",
    date: "Date",
    subject: "Subject",
    to: "To",
    cc: "Cc",
  },
};

const de: typeof en = {
  titles: {
    new: "Neue Nachricht",
    reply: "Antworten",
    "reply-all": "Allen antworten",
    forward: "Weiterleiten",
    draft: "Entwurf",
  },
  addRecipient: "Füge mindestens einen Empfänger hinzu.",
  invalidAddress: (address) => `„${address}“ ist keine gültige Adresse.`,
  suggestions: "Vorschläge",
  notAnAddress: "Keine gültige Adresse",
  fromRecentMail: (why) =>
    `${why} Die Vorschläge kommen aus deinen letzten Mails.`,
  tooBigToSend: (size, limit) =>
    `Die Anhänge sind zusammen ${size} groß, erlaubt sind ${limit}. Entferne welche, um zu senden.`,
  tooBigToAdd: (count, size, limit) =>
    `Mit ${plural(count, "dieser Datei", "diesen Dateien")} hätte die Mail ${size} an Anhängen, erlaubt sind ${limit}.`,
  tooBigToAttach: (size, limit) =>
    `Zu groß zum Anhängen: Die Mail hätte ${size}, erlaubt sind ${limit}.`,
  retry: "Wiederholen",
  closeKeepsDraft: "Schließen (Entwurf bleibt erhalten)",
  closeEscKeepsDraft: "Schließen (Esc, Entwurf bleibt erhalten)",
  send: "Senden",
  sendKey: "Strg+Eingabe",
  restore: "Wiederherstellen",
  minimize: "Minimieren",
  smaller: "Verkleinern",
  larger: "Vergrößern",
  ccBcc: "Cc/Bcc",
  subject: "Betreff",
  noSubjectAsk: "Ohne Betreff senden?",
  sendAnyway: "Trotzdem senden",
  attachFiles: "Dateien anhängen",
  discardDraft: "Entwurf verwerfen",
  dropHint:
    "Leg Dateien hier ab, um sie anzuhängen. Bilder, die du in den Text ziehst, erscheinen im Text.",
  signature: "Signatur",
  removeSignature: "Signatur entfernen",
  quoted: (forward) =>
    forward ? "Weitergeleitete Nachricht" : "Zitierter Text",
  showQuoted: (forward) =>
    `${forward ? "Weitergeleitete Nachricht" : "Zitierten Text"} einblenden`,
  hideQuoted: (forward) =>
    `${forward ? "Weitergeleitete Nachricht" : "Zitierten Text"} ausblenden`,
  quotedFrame: (forward) =>
    forward ? "Die weitergeleitete Nachricht" : "Der zitierte Text",
  removeItem: (name) => `„${name}“ entfernen`,
  editor: {
    message: "Nachricht",
    placeholder: "Schreib deine Nachricht …",
    formatting: "Formatierung",
    bold: "Fett (Strg+B)",
    italic: "Kursiv (Strg+I)",
    underline: "Unterstrichen (Strg+U)",
    link: "Link (Strg+K)",
    bulleted: "Aufzählung",
    numbered: "Nummerierte Liste",
    quote: "Zitat",
    clear: "Formatierung entfernen",
    linkField: "Link",
    linkPlaceholder: "https://… oder eine E-Mail-Adresse",
    apply: "Übernehmen",
    removeLink: "Link entfernen",
  },
  sending: (subject) => `„${subject}“ wird gesendet …`,
  sendingIn: (subject, seconds) => `„${subject}“ wird in ${seconds} s gesendet`,
  sendNow: "Jetzt senden",
  sent: "Nachricht gesendet",
  couldntSave: (why) => `Der Entwurf konnte nicht gespeichert werden: ${why}`,
  couldntSend: (why) =>
    `Senden fehlgeschlagen: ${why} Die Mail liegt in den Entwürfen.`,
  couldntReply: "Antworten fehlgeschlagen",
  couldntForward: "Weiterleiten fehlgeschlagen",
  couldntOpenDraft: "Der Entwurf konnte nicht geöffnet werden",
  couldntDeleteDraft: "Der Entwurf konnte nicht gelöscht werden",
  draftDiscarded: "Entwurf verworfen",
  quote: {
    wrote: (when, locale, sender) => {
      const date = new Intl.DateTimeFormat(locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(when);
      const time = new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(when);
      return `Am ${date} um ${time} schrieb ${sender}:`;
    },
    forwarded: "---------- Weitergeleitete Nachricht ---------",
    from: "Von",
    date: "Datum",
    subject: "Betreff",
    to: "An",
    cc: "Cc",
  },
};

/** The composer: window, fields, editor, sending and quoting. */
export const composer = { en, de };
