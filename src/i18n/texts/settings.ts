const en = {
  title: "Settings",
  close: "Close settings (Esc)",
  sections: "Settings sections",
  general: "General",
  reading: "Reading",
  writing: "Writing",
  notifications: "Notifications",

  language: "Language",
  automatic: "Automatic",
  /** The hint of "Automatic": the language it picks now. */
  followsBrowser: (language: string) => `Follows your browser: ${language}`,
  themeHint: "Follows your device",
  messageList: "Message list",
  comfortable: "Comfortable",
  comfortableHint: "Two lines per message",
  compact: "Compact",
  compactHint: "One line per message, to see more at once",
  afterRemove: "After archiving or deleting the open message",
  openBelow: "Open the next message below",
  openAbove: "Open the next message above",
  backToList: "Go back to the list",
  backToListHint: "j and k continue from where the message was",

  conversationView: "Conversation view",
  off: "Off",
  offHint: "One row per message",
  on: "On",
  onHint: "Replies are grouped with the mail they answer, in one row",
  markRead: "Mark as read",
  immediately: "As soon as it opens",
  afterDelay: "After 1.5 seconds on screen",
  afterDelayHint: "Skimming with j and k doesn't mark everything",
  manually: "Only by hand",
  manuallyHint: "Shift+I, or the button above the message",
  remoteImages: "Remote images in mail",
  askAlways: "Ask every time",
  askAlwaysHint: "Senders can't see when you read their mail",
  askTrusted: "Ask, but remember senders I trust",
  askTrustedHint: "“Always from …” above a mail's blocked images",
  loadAlways: "Always load them",
  loadAlwaysHint: "Senders can tell when and where you open their mail",
  noTrustedSenders: "No trusted senders yet.",
  trustedSenders: "Trusted senders",
  removeSender: (address: string) => `Remove ${address}`,

  undoSend: "Undo send",
  sendRightAway: "Off: send right away",
  seconds: (seconds: number) => `${seconds} seconds`,
  signatures: "Signatures",
  signaturesHint:
    "Added under what you write, above quoted mail. Saved to your account, so they also show up in Gmail.",
  loadingSignatures: "Loading signatures…",
  couldntLoadSignatures: (why: string) =>
    `Couldn’t load the signatures: ${why}`,
  defaultSender: "default",
  lossySignature:
    "This signature has formatting the editor can’t keep (colours, fonts, sizes, tables or pictures). Editing it here removes that formatting; to keep it, edit it in Gmail.",
  signatureFor: (address: string) => `Signature for ${address}`,
  noSignature: "No signature",
  notSaved: (why: string) => `Not saved: ${why}`,
  allowEditing: "Allow editing",

  phonesOnly: "Phones only allow notifications for installed apps.",
  notificationsBlocked:
    "Your browser blocks notifications for this site. Allow them in the site settings (the icon left of the address), then reload.",
  notAskedYet:
    "Your browser hasn't been asked yet: switch them on to allow them.",
  desktopNotifications: "Desktop notifications for new mail",
  desktopNotificationsHint:
    "Only new unread Inbox mail, and only while action0 isn't in front.",
};

const de: typeof en = {
  title: "Einstellungen",
  close: "Einstellungen schließen (Esc)",
  sections: "Bereiche der Einstellungen",
  general: "Allgemein",
  reading: "Lesen",
  writing: "Schreiben",
  notifications: "Benachrichtigungen",

  language: "Sprache",
  automatic: "Automatisch",
  followsBrowser: (language) => `Wie dein Browser: ${language}`,
  themeHint: "Wie dein Gerät",
  messageList: "Nachrichtenliste",
  comfortable: "Übersichtlich",
  comfortableHint: "Zwei Zeilen pro Nachricht",
  compact: "Kompakt",
  compactHint: "Eine Zeile pro Nachricht, damit mehr auf einmal zu sehen ist",
  afterRemove: "Nach dem Archivieren oder Löschen der geöffneten Nachricht",
  openBelow: "Die nächste Nachricht darunter öffnen",
  openAbove: "Die nächste Nachricht darüber öffnen",
  backToList: "Zurück zur Liste",
  backToListHint: "j und k machen dort weiter, wo die Nachricht war",

  conversationView: "Konversationsansicht",
  off: "Aus",
  offHint: "Eine Zeile pro Nachricht",
  on: "Ein",
  onHint:
    "Antworten stehen mit der Mail, auf die sie antworten, in einer Zeile",
  markRead: "Als gelesen markieren",
  immediately: "Sobald sie geöffnet wird",
  afterDelay: "Nach 1,5 Sekunden auf dem Bildschirm",
  afterDelayHint: "Wer mit j und k durchblättert, markiert nicht alles",
  manually: "Nur von Hand",
  manuallyHint: "Umschalt+I oder die Schaltfläche über der Nachricht",
  remoteImages: "Externe Bilder in Mails",
  askAlways: "Jedes Mal fragen",
  askAlwaysHint: "Absender sehen nicht, wann du ihre Mail liest",
  askTrusted: "Fragen, aber vertrauenswürdige Absender merken",
  askTrustedHint: "„Immer von …“ über den blockierten Bildern einer Mail",
  loadAlways: "Immer laden",
  loadAlwaysHint: "Absender sehen, wann und wo du ihre Mail öffnest",
  noTrustedSenders: "Noch keine vertrauenswürdigen Absender.",
  trustedSenders: "Vertrauenswürdige Absender",
  removeSender: (address) => `${address} entfernen`,

  undoSend: "Senden rückgängig machen",
  sendRightAway: "Aus: sofort senden",
  seconds: (seconds) => `${seconds} Sekunden`,
  signatures: "Signaturen",
  signaturesHint:
    "Steht unter dem, was du schreibst, über zitierten Mails. Wird in deinem Konto gespeichert und erscheint so auch in Gmail.",
  loadingSignatures: "Signaturen werden geladen …",
  couldntLoadSignatures: (why) =>
    `Die Signaturen konnten nicht geladen werden: ${why}`,
  defaultSender: "Standard",
  lossySignature:
    "Diese Signatur hat Formatierungen, die der Editor nicht behalten kann (Farben, Schriften, Größen, Tabellen oder Bilder). Wenn du sie hier bearbeitest, gehen sie verloren; um sie zu behalten, bearbeite sie in Gmail.",
  signatureFor: (address) => `Signatur für ${address}`,
  noSignature: "Keine Signatur",
  notSaved: (why) => `Nicht gespeichert: ${why}`,
  allowEditing: "Bearbeiten erlauben",

  phonesOnly:
    "Auf Smartphones gibt es Benachrichtigungen nur für installierte Apps.",
  notificationsBlocked:
    "Dein Browser blockiert Benachrichtigungen für diese Seite. Erlaube sie in den Website-Einstellungen (das Symbol links neben der Adresse) und lade dann neu.",
  notAskedYet:
    "Dein Browser wurde noch nicht gefragt: Schalte sie ein, um sie zu erlauben.",
  desktopNotifications: "Desktop-Benachrichtigungen bei neuen Mails",
  desktopNotificationsHint:
    "Nur neue ungelesene Mails im Posteingang, und nur, solange action0 nicht im Vordergrund ist.",
};

/** The Settings dialog. */
export const settings = { en, de };
