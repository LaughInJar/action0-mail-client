import { plural } from "../plural";

const en = {
  // The page the browser shows after signing in.
  signedIn: {
    done: "You’re signed in. You can close this tab and go back to action0.",
    failed:
      "action0 couldn’t sign you in. Close this tab and try again in the app.",
  },
  // The tray menu and icons.
  tray: {
    show: "Show action0",
    compose: "New mail",
    quit: "Quit action0",
  },
  unread: (n: number) =>
    n === 0
      ? "action0"
      : plural(n, "action0: 1 unread", `action0: ${String(n)} unread`),
  closedToTray: {
    title: "action0 is still running",
    body: "It keeps checking for mail in the tray. Quit it from the tray menu or with Ctrl/⌘+Q.",
  },

  // Settings → App.
  section: "App",
  whenClosing: "When the window closes",
  closing: {
    tray: "Keep running in the tray",
    quit: "Quit",
  },
  trayHint:
    "In the tray, action0 keeps checking for mail and notifies you. On GNOME, tray icons need the AppIndicator extension.",
  autostart: "Start with the system",
  autostartHint: "action0 starts hidden in the tray when you log in.",
  defaultApp: "Default mail app",
  defaultAppHint: "Then mailto: links anywhere open a new mail in action0.",
  makeDefault: "Make action0 the default mail app",
  defaultDone: "action0 is now your default mail app.",
  defaultSettings:
    "In the Default apps settings that just opened, choose action0 for email.",
  defaultManual:
    "On macOS, choose action0 in Apple Mail under Settings → General → Default email reader.",
  defaultFailed: (why: string) =>
    `action0 couldn’t become the default mail app: ${why}`,
  version: (version: string) => `Version ${version}`,
  checkUpdates: "Check for updates",
  checking: "Checking…",
  upToDate: "action0 is up to date.",

  // A newer version.
  updateAvailable: (version: string) => `action0 ${version} is available.`,
  installUpdate: "Install and restart",
  installing: "Installing…",
  updateFailed: (why: string) => `The update couldn’t be installed: ${why}`,
  later: "Later",
};

const de: typeof en = {
  signedIn: {
    done: "Du bist angemeldet. Du kannst diesen Tab schließen und zu action0 zurückkehren.",
    failed:
      "action0 konnte dich nicht anmelden. Schließe diesen Tab und versuche es in der App noch einmal.",
  },
  tray: {
    show: "action0 anzeigen",
    compose: "Neue E-Mail",
    quit: "action0 beenden",
  },
  unread: (n) =>
    n === 0
      ? "action0"
      : plural(n, "action0: 1 ungelesen", `action0: ${String(n)} ungelesen`),
  closedToTray: {
    title: "action0 läuft weiter",
    body: "Es sucht im Infobereich weiter nach neuen E-Mails. Beenden kannst du es im Menü des Symbols oder mit Strg/⌘+Q.",
  },

  section: "App",
  whenClosing: "Wenn das Fenster geschlossen wird",
  closing: {
    tray: "Im Infobereich weiterlaufen",
    quit: "Beenden",
  },
  trayHint:
    "Im Infobereich sucht action0 weiter nach neuen E-Mails und benachrichtigt dich. Unter GNOME braucht das Symbol die Erweiterung „AppIndicator“.",
  autostart: "Mit dem System starten",
  autostartHint: "action0 startet beim Anmelden ausgeblendet im Infobereich.",
  defaultApp: "Standard-Mail-App",
  defaultAppHint:
    "Dann öffnen mailto:-Links überall eine neue E-Mail in action0.",
  makeDefault: "action0 als Standard-Mail-App festlegen",
  defaultDone: "action0 ist jetzt deine Standard-Mail-App.",
  defaultSettings:
    "Wähle in den eben geöffneten Einstellungen „Standard-Apps“ action0 für E-Mail.",
  defaultManual:
    "Unter macOS wählst du action0 in Apple Mail unter Einstellungen → Allgemein → Standard-E-Mail-Programm.",
  defaultFailed: (why) =>
    `action0 konnte nicht zur Standard-Mail-App werden: ${why}`,
  version: (version) => `Version ${version}`,
  checkUpdates: "Nach Updates suchen",
  checking: "Wird gesucht …",
  upToDate: "action0 ist auf dem neuesten Stand.",

  updateAvailable: (version) => `action0 ${version} ist verfügbar.`,
  installUpdate: "Installieren und neu starten",
  installing: "Wird installiert …",
  updateFailed: (why) => `Das Update konnte nicht installiert werden: ${why}`,
  later: "Später",
};

/** The desktop app: tray, settings, updates, the sign-in page. */
export const desktop = { en, de };
