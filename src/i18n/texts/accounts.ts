import type { SetupProblem } from "../../accounts/types";

const en = {
  // The sidebar and the folder tree.
  mailboxes: "Mailboxes",
  accounts: "Accounts",
  signOut: "Sign out",
  addAccount: "Add account",
  tree: "Accounts and mailboxes",
  reconnectToLoad: "Reconnect to load folders.",
  loadingFolders: "Loading folders…",
  couldntLoadFolders: "Couldn’t load folders.",
  noMatchingFolders: "No matching folders.",
  signedOut: "signed out",
  addLabelHere: "Add label",
  moveHere: "Move here",
  /** After a mailbox's count, for screen readers ("3 unread"). */
  drafts: (n: number): string => (n === 1 ? " draft" : " drafts"),
  unread: " unread",
  actionsFor: (name: string) => `Actions for ${name}`,
  filterFolders: "Filter folders",
  clearFilter: "Clear filter",

  // Welcome.
  appName: "action0 mail",
  tagline:
    "A fast, keyboard-first mail client that runs entirely in your browser.",
  noServer:
    "No server: mail is loaded directly from your provider into this browser, and this app doesn't store it.",

  // Add account: choosing the type.
  connected: (email: string) => `Connected ${email}`,
  reconnected: (email: string) => `Reconnected ${email}`,
  whichKind: "Which kind of account?",
  comingLater: "Coming later",
  oneTimeSetup: "One-time setup",
  back: "Back",
  types: {
    gmail: { title: "Google", description: "Gmail and Google Workspace" },
    microsoft: {
      title: "Microsoft",
      description: "Outlook.com, Microsoft 365 and Exchange Online",
    },
    imap: { title: "Other mail server", description: "Any provider with IMAP" },
    demo: {
      title: "Demo account",
      description: "Sample mail that lives only in this browser",
    },
  },

  // Setting Google up. Tags: see RichText.
  setUpGoogle: "Set up Google",
  setupIntro:
    "Google only lets registered apps read mail. Register this app once in your own Google Cloud project. It's free and takes about ten minutes; the README has the details.",
  setupSteps: [
    "Create a project, <gmailApi>enable the Gmail API</gmailApi> and, for address suggestions, <peopleApi>the People API</peopleApi>.",
    "In the <authPlatform>Google Auth Platform</authPlatform>, enter an app name and your email. Under <audience>Audience</audience>, choose <em>External</em> and add every address you want to connect as a <em>test user</em>.",
    "Under <dataAccess>Data access</dataAccess>, add the scopes <code>https://mail.google.com/</code>, <code>contacts.readonly</code> and <code>contacts.other.readonly</code>.",
    "Under <clients>Clients</clients>, create a client of type <em>Web application</em>. Add this exact address under <em>Authorized JavaScript origins</em> and leave redirect URIs empty:<origin/>",
    "Copy the client ID and paste it here.",
  ],
  clientId: "Client ID",
  clientIdNote:
    "Saved as a setting in this browser. The client ID isn't secret.",
  saveAndContinue: "Save and continue",
  setupProblems: {
    missing: "Paste the client ID from Google Cloud.",
    secret:
      "That's the client secret. The app needs the client ID, which ends with .apps.googleusercontent.com.",
    url: "That's a web address. The client ID ends with .apps.googleusercontent.com.",
    malformed:
      "This doesn't look like a Google client ID. It ends with .apps.googleusercontent.com.",
  } satisfies Record<SetupProblem, string>,

  // Connecting Google.
  connectGoogle: "Connect Google",
  continueWithGoogle: "Continue with Google",
  loadingGoogle: "Loading Google sign-in…",
  waitingForGoogle: "Waiting for Google…",
  connectNotes: [
    "A Google window opens. Choose your account and allow access.",
    "The app asks for full access to your mailbox, because “Delete forever” needs it. There's no server: your mail goes straight from Google to this browser.",
    "It also asks to read your contacts, for address suggestions while writing. That's optional: without it, suggestions come from your recent mail.",
    "While your Google Cloud app is in <em>Testing</em>, Google warns that it isn't verified. Choose <em>Advanced</em> → <em>Go to …</em> to continue.",
  ],
  googleError: "Did Google show an error?",
  helpOrigin: "“invalid_client” or “no registered origin”",
  helpOriginText:
    "The client in Google Cloud is missing this app's address under <em>Authorized JavaScript origins</em>, or it isn't of type <em>Web application</em>. Add exactly:<origin/>Changes can take a few minutes to take effect.",
  helpBlocked:
    "“Access blocked: … has not completed the Google verification process”",
  helpBlockedText:
    "Your address isn't a test user. Add it under <audience>Audience → Test users</audience>.",
  helpAdmin: "A message about your organization or admin",
  helpAdminText:
    "Your Google Workspace administrator blocks unverified apps. Only they can allow this app.",
  otherClientId: "Use a different client ID",
  copy: "Copy",
  copied: "Copied",
};

const de: typeof en = {
  mailboxes: "Postfächer",
  accounts: "Konten",
  signOut: "Abmelden",
  addAccount: "Konto hinzufügen",
  tree: "Konten und Postfächer",
  reconnectToLoad: "Verbinde dich neu, um die Ordner zu laden.",
  loadingFolders: "Ordner werden geladen …",
  couldntLoadFolders: "Die Ordner konnten nicht geladen werden.",
  noMatchingFolders: "Keine passenden Ordner.",
  signedOut: "abgemeldet",
  addLabelHere: "Label hinzufügen",
  moveHere: "Hierher verschieben",
  drafts: (n) => (n === 1 ? " Entwurf" : " Entwürfe"),
  unread: " ungelesen",
  actionsFor: (name) => `Aktionen für ${name}`,
  filterFolders: "Ordner filtern",
  clearFilter: "Filter löschen",

  appName: "action0 mail",
  tagline:
    "Ein schneller Mail-Client für die Tastatur, der ganz in deinem Browser läuft.",
  noServer:
    "Kein Server: Deine Mails kommen direkt von deinem Anbieter in diesen Browser, und die App speichert sie nicht.",

  connected: (email) => `${email} verbunden`,
  reconnected: (email) => `${email} neu verbunden`,
  whichKind: "Welche Art von Konto?",
  comingLater: "Kommt später",
  oneTimeSetup: "Einmalige Einrichtung",
  back: "Zurück",
  types: {
    gmail: { title: "Google", description: "Gmail und Google Workspace" },
    microsoft: {
      title: "Microsoft",
      description: "Outlook.com, Microsoft 365 und Exchange Online",
    },
    imap: {
      title: "Anderer Mailserver",
      description: "Jeder Anbieter mit IMAP",
    },
    demo: {
      title: "Demokonto",
      description: "Beispielmails, die nur in diesem Browser existieren",
    },
  },

  setUpGoogle: "Google einrichten",
  setupIntro:
    "Google lässt nur registrierte Apps Mails lesen. Registriere diese App einmal in deinem eigenen Google-Cloud-Projekt. Das ist kostenlos und dauert etwa zehn Minuten; Details stehen im README.",
  setupSteps: [
    "Leg ein Projekt an, <gmailApi>aktiviere die Gmail API</gmailApi> und, für Adressvorschläge, <peopleApi>die People API</peopleApi>.",
    "Gib in der <authPlatform>Google Auth Platform</authPlatform> einen App-Namen und deine E-Mail-Adresse ein. Wähl unter <audience>Zielgruppe (Audience)</audience> <em>Extern</em> und füge jede Adresse, die du verbinden willst, als <em>Testnutzer</em> hinzu.",
    "Füge unter <dataAccess>Datenzugriff (Data access)</dataAccess> die Bereiche <code>https://mail.google.com/</code>, <code>contacts.readonly</code> und <code>contacts.other.readonly</code> hinzu.",
    "Leg unter <clients>Clients</clients> einen Client vom Typ <em>Webanwendung</em> an. Trag genau diese Adresse unter <em>Autorisierte JavaScript-Quellen</em> ein und lass die Weiterleitungs-URIs leer:<origin/>",
    "Kopier die Client-ID und füge sie hier ein.",
  ],
  clientId: "Client-ID",
  clientIdNote:
    "Wird als Einstellung in diesem Browser gespeichert. Die Client-ID ist nicht geheim.",
  saveAndContinue: "Speichern und weiter",
  setupProblems: {
    missing: "Füge die Client-ID aus Google Cloud ein.",
    secret:
      "Das ist das Client-Secret. Die App braucht die Client-ID, die auf .apps.googleusercontent.com endet.",
    url: "Das ist eine Webadresse. Die Client-ID endet auf .apps.googleusercontent.com.",
    malformed:
      "Das sieht nicht nach einer Google-Client-ID aus. Sie endet auf .apps.googleusercontent.com.",
  },

  connectGoogle: "Google verbinden",
  continueWithGoogle: "Weiter mit Google",
  loadingGoogle: "Google-Anmeldung wird geladen …",
  waitingForGoogle: "Warte auf Google …",
  connectNotes: [
    "Ein Google-Fenster öffnet sich. Wähl dein Konto und erlaube den Zugriff.",
    "Die App bittet um vollen Zugriff auf dein Postfach, weil „Endgültig löschen“ ihn braucht. Es gibt keinen Server: Deine Mails gehen direkt von Google in diesen Browser.",
    "Sie bittet auch darum, deine Kontakte zu lesen, für Adressvorschläge beim Schreiben. Das ist freiwillig: Ohne kommen die Vorschläge aus deinen letzten Mails.",
    "Solange deine Google-Cloud-App im Status <em>Test</em> ist, warnt Google, dass sie nicht überprüft ist. Wähl <em>Erweitert</em> → <em>Zu … wechseln</em>, um fortzufahren.",
  ],
  googleError: "Hat Google einen Fehler angezeigt?",
  helpOrigin: "„invalid_client“ oder „no registered origin“",
  helpOriginText:
    "Beim Client in Google Cloud fehlt die Adresse dieser App unter <em>Autorisierte JavaScript-Quellen</em>, oder er ist nicht vom Typ <em>Webanwendung</em>. Trag genau das ein:<origin/>Es kann ein paar Minuten dauern, bis Änderungen wirken.",
  helpBlocked:
    "„Zugriff blockiert: … hat das Bestätigungsverfahren von Google nicht abgeschlossen“",
  helpBlockedText:
    "Deine Adresse ist nicht als Testnutzer eingetragen. Füge sie unter <audience>Zielgruppe → Testnutzer</audience> hinzu.",
  helpAdmin: "Eine Meldung über deine Organisation oder die Administration",
  helpAdminText:
    "Die Administration deines Google Workspace blockiert nicht überprüfte Apps. Nur sie kann diese App erlauben.",
  otherClientId: "Eine andere Client-ID verwenden",
  copy: "Kopieren",
  copied: "Kopiert",
};

/** Accounts: the sidebar and folder tree, the welcome screen, Add account. */
export const accounts = { en, de };
