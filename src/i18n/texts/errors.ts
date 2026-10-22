import type { MailErrorReason } from "../../core/errors";

type Params = Readonly<Record<string, string>>;
type Reasons = Readonly<Record<MailErrorReason, (p: Params) => string>>;

/** The provider a sign-in error is about. */
const provider = (p: Params): string => p.provider ?? "Google";

const enReasons: Reasons = {
  notConnected: () => "This account is no longer connected.",
  signInAgain: (p) => `Please sign in to ${provider(p)} again.`,
  signInUnavailable: (p) => `Could not load ${provider(p)} sign-in.`,
  signInFailed: (p) => `${provider(p)} sign-in failed: ${p.detail ?? ""}`,
  signInClosed: (p) => `The ${provider(p)} sign-in window was closed.`,
  signInBlocked: (p) =>
    `The ${provider(p)} sign-in window was blocked. Please allow popups for this site.`,
  accessNotGranted: (p) =>
    `The requested access was not granted. Please allow it in the ${provider(p)} dialog.`,
  unreachable: (p) => `Could not reach ${p.service ?? ""}.`,
  tokenRejected: (p) => `${p.service ?? ""} rejected the access token.`,
  draftGone: () => "This draft no longer exists.",
  noContent: (p) => `No content for “${p.name ?? ""}”.`,
  onlyTrashSpam: () => "Only Trash and Spam can be emptied.",
  notALabel: (p) => `“${p.name ?? ""}” is not a label.`,
  labelNeedsName: () => "A label needs a name.",
  labelNoSlash: () => "Label names can’t contain “/”.",
  labelExists: (p) => `There’s already a label called “${p.name ?? ""}”.`,
  labelNotAllowed: (p) =>
    `Gmail doesn’t allow the label name “${p.name ?? ""}”.`,
  labelInsideItself: () => "A label can’t go inside itself.",
  systemMailbox: () => "System mailboxes can’t be changed.",
  settingsNotAllowed: () =>
    "Changing Gmail settings wasn’t allowed for this account.",
  peopleApiDisabled: () =>
    "The People API isn't enabled in the Google Cloud project.",
  contactsDeclined: () => "Access to your Google contacts wasn't granted.",
  senderUnreachable: () => "The sender’s server couldn’t be reached.",
  senderRefused: (p) => `The sender’s server refused (${p.status ?? ""}).`,
  needsHttps: () => "One-click unsubscribe needs https.",
  demoRefused: () => "The demo server refused the change.",
  demoContactsOff: () => "Demo contacts are switched off.",
  adminApprovalNeeded: () =>
    "Your organisation only allows this app after an administrator approved it. Ask your IT admin to grant consent for action0 in Microsoft Entra.",
  noArchiveFolder: () =>
    "This mailbox has no Archive folder. Archive a message once in Outlook to create it.",
  notAFolder: (p) => `“${p.name ?? ""}” is not a folder.`,
  folderNeedsName: () => "A folder needs a name.",
  folderExists: (p) =>
    `There’s already a folder called “${p.name ?? ""}” here.`,
  folderInsideItself: () => "A folder can’t go inside itself.",
  attachmentUploadBlocked: (p) =>
    `“${p.name ?? ""}” is too big to upload from the browser (at most 3 MB per file for this account).`,
  wrongAccount: (p) =>
    `You signed in as ${p.actual ?? ""}, but this account is ${p.expected ?? ""}. Please choose ${p.expected ?? ""}.`,
  peopleUnavailable: () =>
    "Microsoft’s list of people isn’t available for this account.",
  calendarAccessNeeded: () =>
    "This account hasn’t allowed calendar access yet.",
  icsBlocked: (p) =>
    `${p.host ?? "The server"} doesn’t let browser apps read this calendar. Only calendars whose server allows it can be added for now.`,
  icsNotFound: (p) =>
    `There’s no calendar at this address (${p.status ?? ""}). Check the link.`,
  icsUnreadable: () => "This address doesn’t contain a calendar (iCal).",
  icsBadUrl: () => "That isn’t a web address (https:// or webcal://).",
};

const deReasons: Reasons = {
  notConnected: () => "Dieses Konto ist nicht mehr verbunden.",
  signInAgain: (p) => `Bitte melde dich erneut bei ${provider(p)} an.`,
  signInUnavailable: (p) =>
    `Die ${provider(p)}-Anmeldung konnte nicht geladen werden.`,
  signInFailed: (p) =>
    `Die ${provider(p)}-Anmeldung ist fehlgeschlagen: ${p.detail ?? ""}`,
  signInClosed: (p) =>
    `Das Fenster der ${provider(p)}-Anmeldung wurde geschlossen.`,
  signInBlocked: (p) =>
    `Das Fenster der ${provider(p)}-Anmeldung wurde blockiert. Bitte erlaube Pop-ups für diese Seite.`,
  accessNotGranted: (p) =>
    `Der angefragte Zugriff wurde nicht erteilt. Bitte erlaube ihn im ${provider(p)}-Fenster.`,
  unreachable: (p) => `${p.service ?? ""} ist nicht erreichbar.`,
  tokenRejected: (p) =>
    `${p.service ?? ""} hat den Zugriffsschlüssel abgelehnt.`,
  draftGone: () => "Dieser Entwurf existiert nicht mehr.",
  noContent: (p) => `Kein Inhalt für „${p.name ?? ""}“.`,
  onlyTrashSpam: () => "Nur Papierkorb und Spam können geleert werden.",
  notALabel: (p) => `„${p.name ?? ""}“ ist kein Label.`,
  labelNeedsName: () => "Ein Label braucht einen Namen.",
  labelNoSlash: () => "Labelnamen dürfen kein „/“ enthalten.",
  labelExists: (p) => `Es gibt schon ein Label „${p.name ?? ""}“.`,
  labelNotAllowed: (p) =>
    `Gmail erlaubt den Labelnamen „${p.name ?? ""}“ nicht.`,
  labelInsideItself: () => "Ein Label kann nicht in sich selbst liegen.",
  systemMailbox: () => "Systemordner können nicht geändert werden.",
  settingsNotAllowed: () =>
    "Für dieses Konto wurde das Ändern der Gmail-Einstellungen nicht erlaubt.",
  peopleApiDisabled: () =>
    "Die People API ist im Google-Cloud-Projekt nicht aktiviert.",
  contactsDeclined: () =>
    "Der Zugriff auf deine Google-Kontakte wurde nicht erteilt.",
  senderUnreachable: () => "Der Server des Absenders ist nicht erreichbar.",
  senderRefused: (p) =>
    `Der Server des Absenders hat abgelehnt (${p.status ?? ""}).`,
  needsHttps: () => "Abbestellen mit einem Klick braucht https.",
  demoRefused: () => "Der Demo-Server hat die Änderung abgelehnt.",
  demoContactsOff: () => "Die Demo-Kontakte sind ausgeschaltet.",
  adminApprovalNeeded: () =>
    "Deine Organisation erlaubt diese App erst, wenn ein Administrator zugestimmt hat. Bitte deine IT, action0 in Microsoft Entra freizugeben.",
  noArchiveFolder: () =>
    "Dieses Postfach hat keinen Archivordner. Archiviere einmal eine Nachricht in Outlook, dann gibt es ihn.",
  notAFolder: (p) => `„${p.name ?? ""}“ ist kein Ordner.`,
  folderNeedsName: () => "Ein Ordner braucht einen Namen.",
  folderExists: (p) => `Hier gibt es schon einen Ordner „${p.name ?? ""}“.`,
  folderInsideItself: () => "Ein Ordner kann nicht in sich selbst liegen.",
  attachmentUploadBlocked: (p) =>
    `„${p.name ?? ""}“ ist zu groß, um es aus dem Browser hochzuladen (bei diesem Konto höchstens 3 MB pro Datei).`,
  wrongAccount: (p) =>
    `Du hast dich als ${p.actual ?? ""} angemeldet, dieses Konto ist aber ${p.expected ?? ""}. Bitte wähle ${p.expected ?? ""}.`,
  peopleUnavailable: () =>
    "Die Personenliste von Microsoft ist für dieses Konto nicht verfügbar.",
  calendarAccessNeeded: () =>
    "Dieses Konto hat den Kalenderzugriff noch nicht erlaubt.",
  icsBlocked: (p) =>
    `${p.host ?? "Der Server"} lässt Browser-Apps diesen Kalender nicht lesen. Vorerst gehen nur Kalender, deren Server das erlaubt.`,
  icsNotFound: (p) =>
    `Unter dieser Adresse gibt es keinen Kalender (${p.status ?? ""}). Prüf den Link.`,
  icsUnreadable: () => "Diese Adresse enthält keinen Kalender (iCal).",
  icsBadUrl: () => "Das ist keine Webadresse (https:// oder webcal://).",
};

const en = {
  reasons: enReasons,
  notFound: "This item no longer exists.",
  rateLimited: "The mail provider is busy. Please try again in a moment.",
  offline: "You seem to be offline, or the mail provider can't be reached.",
  unknown: "Something went wrong.",
};

const de: typeof en = {
  reasons: deReasons,
  notFound: "Das gibt es nicht mehr.",
  rateLimited:
    "Der Mail-Anbieter ist gerade ausgelastet. Bitte versuch es gleich noch einmal.",
  offline:
    "Du scheinst offline zu sein, oder der Mail-Anbieter ist nicht erreichbar.",
  unknown: "Etwas ist schiefgelaufen.",
};

export const errors = { en, de };
