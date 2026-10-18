const en = {
  messageList: "Message list",
  message: "Message",
  folders: "Folders",
  closePanel: (label: string) => `Close ${label}`,
  resize: (label: string) => `Resize ${label}`,
  dropToCompose: "Drop to start a new mail with these files",
  reconnectExpired: (email: string) =>
    `Reconnect ${email} to keep reading mail.`,
  reconnectSoon: (email: string) => `The session for ${email} expires soon.`,
  reconnect: "Reconnect",
  theme: "Theme",
  themeSystem: "System",
  themeSystemHint: "System theme (follows your device)",
  themeLight: "Light",
  themeLightHint: "Light theme",
  themeDark: "Dark",
  themeDarkHint: "Dark theme",
  settings: "Settings",
  compose: "Compose",
  notificationsAsk:
    "Get a notification when new mail arrives while you’re in another tab or app?",
  notificationsOn: "Turn on notifications",
  notNow: "Not now",
  notifyMany: (n: number) => `${n} new messages`,
  notifyOne: "New message",
  titleReconnect: (app: string) => `Reconnect – ${app}`,
  openLink: "Open",
};

const de: typeof en = {
  messageList: "Nachrichtenliste",
  message: "Nachricht",
  folders: "Ordner",
  closePanel: (label) => `${label} schließen`,
  resize: (label) => `Breite ändern: ${label}`,
  dropToCompose:
    "Loslassen, um eine neue E-Mail mit diesen Dateien zu beginnen",
  reconnectExpired: (email) =>
    `Verbinde ${email} neu, um weiter E-Mails zu lesen.`,
  reconnectSoon: (email) => `Die Sitzung für ${email} läuft bald ab.`,
  reconnect: "Neu verbinden",
  theme: "Design",
  themeSystem: "System",
  themeSystemHint: "Systemdesign (wie dein Gerät)",
  themeLight: "Hell",
  themeLightHint: "Helles Design",
  themeDark: "Dunkel",
  themeDarkHint: "Dunkles Design",
  settings: "Einstellungen",
  compose: "Schreiben",
  notificationsAsk:
    "Benachrichtigt werden, wenn neue E-Mails ankommen, während du in einem anderen Tab oder einer anderen App bist?",
  notificationsOn: "Benachrichtigungen einschalten",
  notNow: "Jetzt nicht",
  notifyMany: (n) => `${n} neue Nachrichten`,
  notifyOne: "Neue Nachricht",
  titleReconnect: (app) => `Neu verbinden – ${app}`,
  openLink: "Öffnen",
};

export const layout = { en, de };
