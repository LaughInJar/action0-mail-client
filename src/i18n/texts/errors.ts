import type { MailErrorReason } from "../../core/errors";

type Params = Readonly<Record<string, string>>;
type Reasons = Readonly<Record<MailErrorReason, (p: Params) => string>>;

const enReasons: Reasons = {
  notConnected: () => "This account is no longer connected.",
  signInAgain: () => "Please sign in to Google again.",
  signInUnavailable: () => "Could not load Google sign-in.",
  signInFailed: (p) => `Google sign-in failed: ${p.detail ?? ""}`,
  signInClosed: () => "The Google sign-in window was closed.",
  signInBlocked: () =>
    "The Google sign-in window was blocked. Please allow popups for this site.",
  accessNotGranted: () =>
    "The requested access was not granted. Please allow it in the Google dialog.",
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
};

const deReasons: Reasons = {
  notConnected: () => "Dieses Konto ist nicht mehr verbunden.",
  signInAgain: () => "Bitte melde dich erneut bei Google an.",
  signInUnavailable: () => "Die Google-Anmeldung konnte nicht geladen werden.",
  signInFailed: (p) =>
    `Die Google-Anmeldung ist fehlgeschlagen: ${p.detail ?? ""}`,
  signInClosed: () => "Das Fenster der Google-Anmeldung wurde geschlossen.",
  signInBlocked: () =>
    "Das Fenster der Google-Anmeldung wurde blockiert. Bitte erlaube Pop-ups für diese Seite.",
  accessNotGranted: () =>
    "Der angefragte Zugriff wurde nicht erteilt. Bitte erlaube ihn im Google-Fenster.",
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
