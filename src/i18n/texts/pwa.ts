const en = {
  // The bar when a new version is ready.
  updateReady: "A new version of action0 is ready.",
  reload: "Reload",
  later: "Later",
  // The one-time install bar on phones.
  installOffer:
    "Install action0 for a home screen icon and notifications of new mail.",
  install: "Install",
  notNow: "Not now",
  // Settings → App (the web app).
  appTitle: "App",
  installTitle: "Install action0",
  installHint:
    "Installed, action0 opens in its own window, starts even offline, shows the unread count on its icon and can notify you of new mail on phones.",
  installed: "action0 is installed on this device.",
  iosSteps:
    "In Safari, tap Share (the square with the arrow), then “Add to Home Screen”.",
  macSafariSteps: "In Safari, choose File → Add to Dock.",
  cantInstall:
    "This browser can’t install web apps. Chrome, Edge and Safari can.",
  emailLinks: "Use action0 for email links",
  emailLinksHint:
    "Email links on web pages then open a new mail in action0. Your browser asks first.",
  emailLinksAsked: "Your browser asked whether to use action0 for email links.",
};

const de: typeof en = {
  updateReady: "Eine neue Version von action0 ist bereit.",
  reload: "Neu laden",
  later: "Später",
  installOffer:
    "Installiere action0 für ein Symbol auf dem Startbildschirm und Benachrichtigungen bei neuen Mails.",
  install: "Installieren",
  notNow: "Jetzt nicht",
  appTitle: "App",
  installTitle: "action0 installieren",
  installHint:
    "Installiert öffnet sich action0 in einem eigenen Fenster, startet auch offline, zeigt die Zahl der ungelesenen Mails auf seinem Symbol und kann dich auf Smartphones über neue Mails benachrichtigen.",
  installed: "action0 ist auf diesem Gerät installiert.",
  iosSteps:
    "Tippe in Safari auf Teilen (das Quadrat mit dem Pfeil) und dann auf „Zum Home-Bildschirm“.",
  macSafariSteps: "Wähle in Safari Ablage → Zum Dock hinzufügen.",
  cantInstall:
    "Dieser Browser kann keine Web-Apps installieren. Chrome, Edge und Safari können das.",
  emailLinks: "action0 für E-Mail-Links verwenden",
  emailLinksHint:
    "E-Mail-Links auf Webseiten öffnen dann eine neue Mail in action0. Dein Browser fragt vorher nach.",
  emailLinksAsked:
    "Dein Browser hat gefragt, ob action0 E-Mail-Links öffnen soll.",
};

/** The installable web app: updates, installing, email links. */
export const pwa = { en, de };
