import { plural } from "../plural";

const en = {
  // Menus and the shortcut.
  show: "Show original",
  showButton: "Show original (Ctrl+U)",

  // The view.
  title: "Original message",
  tabsLabel: "Parts of the original",
  tabs: { summary: "Summary", headers: "Headers", source: "Source" },
  download: "Download",
  copy: "Copy",
  copied: "Copied the original",
  loading: "Loading the original…",
  couldntLoad: "Couldn’t load the original",
  gone: "This message no longer exists.",
  couldntSave: "Couldn’t save the original",

  // Summary.
  messageId: "Message ID",
  createdAt: "Created at",
  deliveredAfter: (duration: string) => `Delivered after ${duration}`,
  from: "From",
  to: "To",
  cc: "Cc",
  subject: "Subject",
  authentication: "Sender checks",
  authNote:
    "What your provider’s server found when the message arrived. Fail means the sender may not be who they claim to be.",
  noChecks: "Your provider recorded no checks for this message.",
  methods: { spf: "SPF", dkim: "DKIM", dmarc: "DMARC" },
  results: {
    pass: "Pass",
    fail: "Fail",
    softfail: "Soft fail",
    neutral: "Neutral",
    none: "None",
    temperror: "Temporary error",
    permerror: "Permanent error",
  } as Readonly<Record<string, string>>,
  checkedDomain: (domain: string) => `for ${domain}`,
  path: "Delivery path",
  pathNote: "Each server the message passed, oldest first.",
  noPath: "No servers recorded.",
  columns: {
    hop: "Hop",
    from: "From",
    by: "Received by",
    with: "Protocol",
    time: "Time",
    delay: "Delay",
  },
  unknown: "–",
  clockSkew: "clocks differ",

  // Durations.
  lessThanSecond: "less than a second",
  seconds: (n: number) => plural(n, "1 second", `${String(n)} seconds`),
  minutes: (n: number) => plural(n, "1 minute", `${String(n)} minutes`),
  hours: (n: number) => plural(n, "1 hour", `${String(n)} hours`),
  days: (n: number) => plural(n, "1 day", `${String(n)} days`),

  // Headers.
  filter: "Filter headers",
  filterPlaceholder: "Filter by name or value",
  headerCount: (shown: number, all: number) =>
    shown === all
      ? plural(all, "1 header", `${String(all)} headers`)
      : `${String(shown)} of ${String(all)} headers`,
  noMatch: "No header matches.",
  asSent: "As sent",

  // Source.
  sourceLabel: "Source of the message",
  collapsed: (what: string, size: string) =>
    `${what} (${size}) isn’t shown here. Download or Copy has the whole message.`,
};

const de: typeof en = {
  show: "Original anzeigen",
  showButton: "Original anzeigen (Strg+U)",

  title: "Originalnachricht",
  tabsLabel: "Teile des Originals",
  tabs: { summary: "Übersicht", headers: "Kopfzeilen", source: "Quelltext" },
  download: "Herunterladen",
  copy: "Kopieren",
  copied: "Original kopiert",
  loading: "Original wird geladen …",
  couldntLoad: "Original konnte nicht geladen werden",
  gone: "Diese Nachricht gibt es nicht mehr.",
  couldntSave: "Original konnte nicht gespeichert werden",

  messageId: "Nachrichten-ID",
  createdAt: "Erstellt am",
  deliveredAfter: (duration) => `Zugestellt nach ${duration}`,
  from: "Von",
  to: "An",
  cc: "Cc",
  subject: "Betreff",
  authentication: "Absenderprüfungen",
  authNote:
    "Was der Server deines Anbieters beim Eintreffen der Nachricht festgestellt hat. Fehlgeschlagen heißt: Der Absender ist vielleicht nicht, wer er vorgibt zu sein.",
  noChecks: "Dein Anbieter hat für diese Nachricht keine Prüfungen vermerkt.",
  methods: { spf: "SPF", dkim: "DKIM", dmarc: "DMARC" },
  results: {
    pass: "Bestanden",
    fail: "Fehlgeschlagen",
    softfail: "Schwach fehlgeschlagen",
    neutral: "Neutral",
    none: "Keine",
    temperror: "Vorübergehender Fehler",
    permerror: "Dauerhafter Fehler",
  },
  checkedDomain: (domain) => `für ${domain}`,
  path: "Zustellweg",
  pathNote:
    "Jeder Server, den die Nachricht durchlaufen hat, der älteste zuerst.",
  noPath: "Keine Server vermerkt.",
  columns: {
    hop: "Station",
    from: "Von",
    by: "Empfangen von",
    with: "Protokoll",
    time: "Zeit",
    delay: "Verzögerung",
  },
  unknown: "–",
  clockSkew: "Uhren weichen ab",

  lessThanSecond: "weniger als einer Sekunde",
  seconds: (n) => plural(n, "1 Sekunde", `${String(n)} Sekunden`),
  minutes: (n) => plural(n, "1 Minute", `${String(n)} Minuten`),
  hours: (n) => plural(n, "1 Stunde", `${String(n)} Stunden`),
  days: (n) => plural(n, "1 Tag", `${String(n)} Tagen`),

  filter: "Kopfzeilen filtern",
  filterPlaceholder: "Nach Name oder Wert filtern",
  headerCount: (shown, all) =>
    shown === all
      ? plural(all, "1 Kopfzeile", `${String(all)} Kopfzeilen`)
      : `${String(shown)} von ${String(all)} Kopfzeilen`,
  noMatch: "Keine Kopfzeile passt.",
  asSent: "Wie gesendet",

  sourceLabel: "Quelltext der Nachricht",
  collapsed: (what, size) =>
    `${what} (${size}) wird hier nicht angezeigt. Herunterladen oder Kopieren enthält die ganze Nachricht.`,
};

/** "Show original": a message's headers and source. */
export const original = { en, de };
