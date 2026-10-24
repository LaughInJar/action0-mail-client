const en = {
  /** The background check's notification for several messages ({count} is replaced). */
  newMessages: "{count} new messages",
  releaseAvailable: (version: string) =>
    `action0 ${version} is available for Android.`,
  download: "Download",
  later: "Later",
  share: "Share",
  shareFile: (name: string) => `Share ${name}`,
  couldntShare: "Couldn’t share the file",
  checkForUpdates: "Check for updates",
  checking: "Checking…",
  upToDate: "action0 is up to date.",
  version: (version: string) => `Version ${version}`,
  notificationsAsk:
    "Get a notification when new mail arrives while action0 isn't open?",
  notifications: "Notifications for new mail",
  notificationsHint:
    "Only new unread Inbox mail. Android checks for it about every 15 minutes, or less often to save battery, while action0 isn't open.",
  notificationsBlocked:
    "Notifications are off for action0 in Android's settings (Apps → action0 → Notifications).",
};

const de: typeof en = {
  newMessages: "{count} neue Nachrichten",
  releaseAvailable: (version) =>
    `action0 ${version} ist für Android verfügbar.`,
  download: "Herunterladen",
  later: "Später",
  share: "Teilen",
  shareFile: (name) => `${name} teilen`,
  couldntShare: "Die Datei konnte nicht geteilt werden",
  checkForUpdates: "Nach Updates suchen",
  checking: "Suche …",
  upToDate: "action0 ist aktuell.",
  version: (version) => `Version ${version}`,
  notificationsAsk:
    "Eine Benachrichtigung bekommen, wenn neue E-Mails ankommen, während action0 nicht offen ist?",
  notifications: "Benachrichtigungen bei neuen E-Mails",
  notificationsHint:
    "Nur neue ungelesene E-Mails im Posteingang. Android sieht etwa alle 15 Minuten nach, um Akku zu sparen auch seltener, solange action0 nicht offen ist.",
  notificationsBlocked:
    "Benachrichtigungen für action0 sind in den Android-Einstellungen aus (Apps → action0 → Benachrichtigungen).",
};

/** The Android app's own texts. */
export const android = { en, de };
