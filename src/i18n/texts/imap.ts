const en = {
  // Adding an account.
  title: "Other mail server",
  intro:
    "Any provider with IMAP: GMX, web.de, iCloud, Yahoo, Fastmail, mailbox.org, Posteo, your own server, …",
  appsOnly: "In the desktop and Android apps",
  address: "Email address",
  name: "Your name",
  nameHint: "Recipients see it as the sender.",
  next: "Continue",
  lookingUp: "Looking up the settings…",
  invalidAddress: "Enter an email address.",

  // A Google or Microsoft address.
  betterGmail:
    "This is a Google address. It works best as a Gmail account: labels, Gmail’s search, and no app password.",
  addAsGmail: "Add as Gmail account",
  useImapAnyway: "Use IMAP anyway",
  betterMicrosoft:
    "Microsoft doesn’t allow passwords over IMAP. Add it as a Microsoft account instead.",
  addAsMicrosoft: "Add as Microsoft account",

  // Where the settings came from.
  found: {
    provider: "Your provider’s settings were found.",
    ispdb: "The settings were found in Mozilla’s provider database.",
    mx: "The settings were found through your domain’s mail servers.",
    none: "No settings were found. Enter them from your provider’s help pages.",
  },
  foundFor: (provider: string) => `Settings for ${provider}.`,
  serverSettings: "Server settings",
  incoming: "Incoming mail (IMAP)",
  outgoing: "Outgoing mail (SMTP)",
  host: "Server",
  port: "Port",
  security: "Encryption",
  securities: { tls: "TLS", starttls: "STARTTLS" },
  username: "Username",

  // Signing in.
  password: "Password",
  appPasswordHint:
    "Your provider wants an app password for other mail apps, not your usual password.",
  makeAppPassword: "Create an app password",
  enableImap: "Switch on IMAP access in your account’s settings first.",
  enableImapLink: "How to switch it on",
  connect: "Connect",
  connecting: "Connecting…",
  signInWith: (provider: string) => `Sign in with ${provider}`,
  signingIn: "Waiting for the sign-in in your browser…",
  orPassword: "Or use an app password:",

  // A Yahoo/AOL app registration.
  oauthSetup: {
    title: (provider: string) => `Set up the ${provider} sign-in`,
    text: (provider: string) =>
      `Signing in with ${provider} needs an app registration that ${provider} approved for mail (Yahoo reviews these by hand). Enter its client ID here; the redirect address it needs is http://127.0.0.1.`,
    clientId: "Client ID",
    clientSecret: "Client secret (if you got one)",
    save: "Save",
    change: "Change the app registration",
  },

  // What went wrong.
  errors: {
    auth: "The server refused the username or password.",
    authAppPassword:
      "The server refused the password. Many providers need an app password for other mail apps.",
    unreachable: (host: string) =>
      `Couldn’t reach ${host}. Check the server name and port.`,
    tls: (host: string) =>
      `${host} offers no encrypted connection on this port. Try the other encryption setting or port.`,
    smtp: (detail: string) => `Sending (SMTP): ${detail}`,
    oauth: (provider: string, detail: string) =>
      `Signing in with ${provider} didn’t work: ${detail}`,
    server: (detail: string) => `The server answered: ${detail}`,
  },

  // A certificate the system doesn't trust.
  certificate: {
    title: "Untrusted certificate",
    text: (host: string) =>
      `This system doesn’t trust the certificate of ${host}. That’s normal for your own server with a self-made certificate, but it can also mean someone is intercepting the connection.`,
    check:
      "Only trust it if you know it’s yours, for example by comparing the fingerprint with your server’s.",
    fingerprint: "SHA-256 fingerprint",
    subject: "Issued to",
    issuer: "Issued by",
    valid: (from: string, to: string) => `Valid from ${from} to ${to}`,
    trust: "Trust it for this account",
  },

  // Signing in again, and the trusted certificate.
  reconnectPassword: (address: string) => `New password for ${address}`,
  forgetCertificate: "Forget certificate",
  forgetQuestion: {
    title: "Forget the trusted certificate?",
    message: (address: string) =>
      `action0 then refuses ${address}’s server until it has a certificate this system trusts. To trust this one again, add the account again.`,
    confirm: "Forget",
  },
};

const de: typeof en = {
  title: "Anderer Mailserver",
  intro:
    "Jeder Anbieter mit IMAP: GMX, web.de, iCloud, Yahoo, Fastmail, mailbox.org, Posteo, dein eigener Server, …",
  appsOnly: "In der Desktop- und Android-App",
  address: "E-Mail-Adresse",
  name: "Dein Name",
  nameHint: "Empfänger sehen ihn als Absender.",
  next: "Weiter",
  lookingUp: "Einstellungen werden gesucht …",
  invalidAddress: "Gib eine E-Mail-Adresse ein.",

  betterGmail:
    "Das ist eine Google-Adresse. Als Gmail-Konto klappt sie am besten: Labels, die Gmail-Suche und kein App-Passwort.",
  addAsGmail: "Als Gmail-Konto hinzufügen",
  useImapAnyway: "Trotzdem IMAP verwenden",
  betterMicrosoft:
    "Microsoft erlaubt über IMAP keine Passwörter. Füge sie stattdessen als Microsoft-Konto hinzu.",
  addAsMicrosoft: "Als Microsoft-Konto hinzufügen",

  found: {
    provider: "Die Einstellungen deines Anbieters wurden gefunden.",
    ispdb: "Die Einstellungen wurden in Mozillas Anbieterverzeichnis gefunden.",
    mx: "Die Einstellungen wurden über die Mailserver deiner Domain gefunden.",
    none: "Keine Einstellungen gefunden. Trag sie aus den Hilfeseiten deines Anbieters ein.",
  },
  foundFor: (provider: string) => `Einstellungen für ${provider}.`,
  serverSettings: "Server-Einstellungen",
  incoming: "Posteingang (IMAP)",
  outgoing: "Postausgang (SMTP)",
  host: "Server",
  port: "Port",
  security: "Verschlüsselung",
  securities: { tls: "TLS", starttls: "STARTTLS" },
  username: "Benutzername",

  password: "Passwort",
  appPasswordHint:
    "Dein Anbieter will für andere Mail-Apps ein App-Passwort, nicht dein normales Passwort.",
  makeAppPassword: "App-Passwort erstellen",
  enableImap:
    "Schalte zuerst in den Einstellungen deines Kontos den IMAP-Zugriff ein.",
  enableImapLink: "So schaltest du ihn ein",
  connect: "Verbinden",
  connecting: "Wird verbunden …",
  signInWith: (provider: string) => `Mit ${provider} anmelden`,
  signingIn: "Warte auf die Anmeldung in deinem Browser …",
  orPassword: "Oder verwende ein App-Passwort:",

  oauthSetup: {
    title: (provider: string) => `Anmeldung mit ${provider} einrichten`,
    text: (provider: string) =>
      `Die Anmeldung mit ${provider} braucht eine App-Registrierung, die ${provider} für Mail freigegeben hat (Yahoo prüft sie von Hand). Trag hier ihre Client-ID ein; die nötige Weiterleitungsadresse ist http://127.0.0.1.`,
    clientId: "Client-ID",
    clientSecret: "Client-Secret (falls du eines bekommen hast)",
    save: "Speichern",
    change: "App-Registrierung ändern",
  },

  errors: {
    auth: "Der Server hat Benutzername oder Passwort abgelehnt.",
    authAppPassword:
      "Der Server hat das Passwort abgelehnt. Viele Anbieter wollen für andere Mail-Apps ein App-Passwort.",
    unreachable: (host: string) =>
      `${host} ist nicht erreichbar. Prüf Servername und Port.`,
    tls: (host: string) =>
      `${host} bietet auf diesem Port keine verschlüsselte Verbindung. Versuch die andere Verschlüsselung oder einen anderen Port.`,
    smtp: (detail: string) => `Senden (SMTP): ${detail}`,
    oauth: (provider: string, detail: string) =>
      `Die Anmeldung mit ${provider} hat nicht geklappt: ${detail}`,
    server: (detail: string) => `Der Server antwortet: ${detail}`,
  },

  certificate: {
    title: "Nicht vertrauenswürdiges Zertifikat",
    text: (host: string) =>
      `Dieses System vertraut dem Zertifikat von ${host} nicht. Bei deinem eigenen Server mit selbst erstelltem Zertifikat ist das normal, es kann aber auch heißen, dass jemand die Verbindung abfängt.`,
    check:
      "Vertrau ihm nur, wenn du weißt, dass es deines ist, zum Beispiel weil der Fingerabdruck mit dem deines Servers übereinstimmt.",
    fingerprint: "SHA-256-Fingerabdruck",
    subject: "Ausgestellt für",
    issuer: "Ausgestellt von",
    valid: (from: string, to: string) => `Gültig von ${from} bis ${to}`,
    trust: "Für dieses Konto vertrauen",
  },

  reconnectPassword: (address: string) => `Neues Passwort für ${address}`,
  forgetCertificate: "Zertifikat vergessen",
  forgetQuestion: {
    title: "Das vertraute Zertifikat vergessen?",
    message: (address: string) =>
      `action0 lehnt den Server von ${address} dann ab, bis er ein Zertifikat hat, dem dieses System vertraut. Um diesem wieder zu vertrauen, füge das Konto neu hinzu.`,
    confirm: "Vergessen",
  },
};

export const imap = { en, de };
