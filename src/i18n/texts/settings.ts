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

  spelling: "Check spelling",
  spellingHint: "Underlines misspelled words in mail, signatures and events.",
  spellingLanguages: "Languages",
  lookingForDictionaries: "Looking for dictionaries…",
  spellingLinux:
    "Right-click an underlined word for suggestions. For more languages, install their hunspell dictionary (e.g. hunspell-fr) and open Settings again.",
  noDictionaries:
    "No dictionaries found. Install your distribution’s hunspell dictionaries (e.g. hunspell-de, hunspell-en-us), then open Settings again.",
  dictionariesNotLoaded:
    "The dictionaries couldn’t be loaded, so nothing is checked.",
  spellingWeb:
    "Your browser checks spelling in the languages set in it: in Chrome and Edge under Settings → Languages, in Firefox by right-clicking in the text → Languages.",
  spellingWindows:
    "Windows checks spelling in its display language (Settings → Time & language → Language & region). Right-click an underlined word for suggestions.",
  spellingMac:
    "macOS recognises the language by itself; the languages are under System Settings → Keyboard → Text Input → Edit. Right-click an underlined word for suggestions.",
  spellingAndroid:
    "Android checks spelling with its own spell checker (Settings → System → Keyboard → Spell checker). Tap an underlined word for suggestions.",

  undoSend: "Undo send",
  sendRightAway: "Off: send right away",
  seconds: (seconds: number) => `${seconds} seconds`,
  signatures: "Signatures",
  signature: "Signature",
  signaturesHint: "Added under what you write, above quoted mail.",
  savedWithProvider: "Saved to your account, so they also show up in Gmail.",
  savedInBrowser:
    "Saved in this browser only, because the account can’t store them.",
  savedInApp: "Saved in this app only, because the account can’t store them.",
  addresses: "Addresses and signatures",
  addressesHint:
    "The addresses you send from, each with its own signature. Signatures go under what you write, above quoted mail.",
  addAddress: "Add address",
  newAddress: "New address",
  editAddressOf: (address: string) => `Edit ${address}`,
  removeAddressOf: (address: string) => `Remove ${address}`,
  removeAddressQuestion: (address: string) =>
    `Remove ${address} and its signature?`,
  defaultFor: (address: string) => `Send from ${address} by default`,
  makeDefault: "Default",
  accountAddress: "The account’s own address can’t be removed.",
  name: "Name",
  address: "Address",
  replyToOptional: "Reply to (optional)",
  replyToHint: "Replies to mail from this address go here instead.",
  bccSelf: "Bcc to myself",
  bccSelfHint: "Every mail from this address also goes to it as Bcc.",
  replyToSummary: (address: string) => `Replies go to ${address}`,
  notAnAddress: (address: string) => `“${address}” isn’t an email address.`,
  addressExists: (address: string) => `${address} is already in the list.`,
  catchAll: "Catch-all domains",
  catchAllHint:
    "Mail to any address at a ticked domain reaches you, so replies go out from the address it was sent to. Only tick your own domains.",
  catchAllFor: (domain: string) => `Every address at ${domain} is mine`,
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
  eventReminders: "Event reminders",
  eventRemindersHint:
    "The reminders set on your events, while action0 is open (the desktop app reminds from the tray too).",
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

  spelling: "Rechtschreibung prüfen",
  spellingHint:
    "Unterstreicht falsch geschriebene Wörter in Mails, Signaturen und Terminen.",
  spellingLanguages: "Sprachen",
  lookingForDictionaries: "Wörterbücher werden gesucht …",
  spellingLinux:
    "Rechtsklick auf ein unterstrichenes Wort zeigt Vorschläge. Für weitere Sprachen installiere ihr Hunspell-Wörterbuch (z. B. hunspell-fr) und öffne die Einstellungen erneut.",
  noDictionaries:
    "Keine Wörterbücher gefunden. Installiere die Hunspell-Wörterbücher deiner Distribution (z. B. hunspell-de, hunspell-en-us) und öffne die Einstellungen erneut.",
  dictionariesNotLoaded:
    "Die Wörterbücher konnten nicht geladen werden, daher wird nichts geprüft.",
  spellingWeb:
    "Dein Browser prüft in den Sprachen, die in ihm eingestellt sind: in Chrome und Edge unter Einstellungen → Sprachen, in Firefox per Rechtsklick in den Text → Sprachen.",
  spellingWindows:
    "Windows prüft in seiner Anzeigesprache (Einstellungen → Zeit und Sprache → Sprache und Region). Rechtsklick auf ein unterstrichenes Wort zeigt Vorschläge.",
  spellingMac:
    "macOS erkennt die Sprache selbst; die Sprachen findest du unter Systemeinstellungen → Tastatur → Texteingabe → Bearbeiten. Rechtsklick auf ein unterstrichenes Wort zeigt Vorschläge.",
  spellingAndroid:
    "Android prüft mit seiner eigenen Rechtschreibprüfung (Einstellungen → System → Tastatur → Rechtschreibprüfung). Tippe auf ein unterstrichenes Wort für Vorschläge.",

  undoSend: "Senden rückgängig machen",
  sendRightAway: "Aus: sofort senden",
  seconds: (seconds) => `${seconds} Sekunden`,
  signatures: "Signaturen",
  signature: "Signatur",
  signaturesHint: "Steht unter dem, was du schreibst, über zitierten Mails.",
  savedWithProvider:
    "Wird in deinem Konto gespeichert und erscheint so auch in Gmail.",
  savedInBrowser:
    "Nur in diesem Browser gespeichert, weil das Konto sie nicht speichern kann.",
  savedInApp:
    "Nur in dieser App gespeichert, weil das Konto sie nicht speichern kann.",
  addresses: "Adressen und Signaturen",
  addressesHint:
    "Die Adressen, von denen du sendest, jede mit eigener Signatur. Signaturen stehen unter dem, was du schreibst, über zitierten Mails.",
  addAddress: "Adresse hinzufügen",
  newAddress: "Neue Adresse",
  editAddressOf: (address) => `${address} bearbeiten`,
  removeAddressOf: (address) => `${address} entfernen`,
  removeAddressQuestion: (address) =>
    `${address} und die zugehörige Signatur entfernen?`,
  defaultFor: (address) => `Standardmäßig von ${address} senden`,
  makeDefault: "Standard",
  accountAddress: "Die eigene Adresse des Kontos kann nicht entfernt werden.",
  name: "Name",
  address: "Adresse",
  replyToOptional: "Antwort an (optional)",
  replyToHint:
    "Antworten auf Mails von dieser Adresse gehen stattdessen hierhin.",
  bccSelf: "Bcc an mich",
  bccSelfHint: "Jede Mail von dieser Adresse geht als Bcc auch an sie.",
  replyToSummary: (address) => `Antworten gehen an ${address}`,
  notAnAddress: (address) => `„${address}“ ist keine E-Mail-Adresse.`,
  addressExists: (address) => `${address} ist schon in der Liste.`,
  catchAll: "Catch-all-Domains",
  catchAllHint:
    "Mails an jede Adresse einer angehakten Domain erreichen dich, darum gehen Antworten von der Adresse aus, an die sie geschickt wurden. Hake nur deine eigenen Domains an.",
  catchAllFor: (domain) => `Jede Adresse bei ${domain} gehört mir`,
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
  eventReminders: "Erinnerungen an Termine",
  eventRemindersHint:
    "Die Erinnerungen deiner Termine, solange action0 offen ist (die Desktop-App erinnert auch aus dem Infobereich).",
};

/** The Settings dialog. */
export const settings = { en, de };
