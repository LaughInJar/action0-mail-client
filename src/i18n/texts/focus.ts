/** Outlook's Focused Inbox, in Outlook's words (German: "Posteingang mit Relevanz"). */
const en = {
  /** The tabs above a split Inbox. */
  tabs: "Focused and Other",
  /** A tab's unread count, for screen readers. */
  unread: (count: number) => `${String(count)} unread`,
  /** After "Always move…": the senders, and the mail already moved. */
  always: (senders: string, side: string) =>
    `Mail from ${senders} now goes to ${side}`,
  couldntMove: "Couldn’t move the mail",
  couldntRule: "Couldn’t change the sender rule",
  // Settings → Reading.
  title: "Focused Inbox",
  description:
    "Outlook sorts the Inbox of Microsoft accounts into Focused and Other. Only Focused mail counts as new: notifications, unread counts and All inboxes leave Other out.",
  /** The switch of an account that hasn't been split yet (automatic). */
  automatic: "Turns on by itself once Outlook puts mail into Other.",
  rules: "Senders always sorted",
  rulesFor: (account: string) => `Senders always sorted for ${account}`,
  noRules:
    "None yet. “Always move to Other” or “Always move to Focused” on a mail adds its sender.",
  loadingRules: "Loading…",
  removeRule: (address: string) => `Remove the rule for ${address}`,
  sideFor: (address: string) => `Where mail from ${address} goes`,
  ruleRemoved: (address: string) =>
    `Mail from ${address} is sorted by Outlook again`,
  ruleChanged: (address: string, side: string) =>
    `Mail from ${address} now goes to ${side}`,
};

const de: typeof en = {
  tabs: "Relevant und Sonstige",
  unread: (count: number) => `${String(count)} ungelesen`,
  always: (senders: string, side: string) =>
    `Mails von ${senders} landen jetzt in „${side}“`,
  couldntMove: "Die Mail konnte nicht verschoben werden",
  couldntRule: "Die Absenderregel konnte nicht geändert werden",
  title: "Posteingang mit Relevanz",
  description:
    "Outlook teilt den Posteingang von Microsoft-Konten in „Relevant“ und „Sonstige“. Nur „Relevant“ zählt als neu: Benachrichtigungen, Ungelesen-Zahlen und „Alle Posteingänge“ lassen „Sonstige“ weg.",
  automatic:
    "Schaltet sich selbst ein, sobald Outlook Mails in „Sonstige“ legt.",
  rules: "Immer sortierte Absender",
  rulesFor: (account: string) => `Immer sortierte Absender von ${account}`,
  noRules:
    "Noch keine. „Immer in „Sonstige“ verschieben“ oder „Immer in „Relevant“ verschieben“ bei einer Mail fügt ihren Absender hinzu.",
  loadingRules: "Wird geladen …",
  removeRule: (address: string) => `Regel für ${address} entfernen`,
  sideFor: (address: string) => `Wohin Mails von ${address} kommen`,
  ruleRemoved: (address: string) =>
    `Mails von ${address} sortiert wieder Outlook`,
  ruleChanged: (address: string, side: string) =>
    `Mails von ${address} landen jetzt in „${side}“`,
};

export const focus = { en, de };
