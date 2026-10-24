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
  addCategoryHere: "Add category",
  moveHere: "Move here",
  otherAccount: "Other account",
  allInboxes: "All inboxes",
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

  // Setting a provider up and connecting it. Tags: see RichText.
  clientId: "Client ID",
  clientIdNote:
    "Saved as a setting in this browser. The client ID isn't secret.",
  saveAndContinue: "Save and continue",
  google: {
    setUp: "Set up Google",
    intro:
      "Google only lets registered apps read mail. Register this app once in your own Google Cloud project. It's free and takes about ten minutes; the README has the details.",
    steps: [
      "Create a project, <gmailApi>enable the Gmail API</gmailApi>, for address suggestions <peopleApi>the People API</peopleApi> and, for the calendar, <calendarApi>the Google Calendar API</calendarApi>.",
      "In the <authPlatform>Google Auth Platform</authPlatform>, enter an app name and your email. Under <audience>Audience</audience>, choose <em>External</em> and add every address you want to connect as a <em>test user</em>.",
      "Under <dataAccess>Data access</dataAccess>, add the scopes <code>https://mail.google.com/</code>, <code>contacts.readonly</code>, <code>contacts.other.readonly</code>, <code>calendar.calendarlist.readonly</code> and <code>calendar.events</code>.",
      "Under <clients>Clients</clients>, create a client of type <em>Web application</em>. Add this exact address under <em>Authorized JavaScript origins</em> and leave redirect URIs empty:<origin/>",
      "Copy the client ID and paste it here.",
    ],
    problems: {
      missing: "Paste the client ID from Google Cloud.",
      secret:
        "That's the client secret. The app needs the client ID, which ends with .apps.googleusercontent.com.",
      url: "That's a web address. The client ID ends with .apps.googleusercontent.com.",
      malformed:
        "This doesn't look like a Google client ID. It ends with .apps.googleusercontent.com.",
    } satisfies Record<SetupProblem, string>,
    connect: "Connect Google",
    continueWith: "Continue with Google",
    loading: "Loading Google sign-in…",
    waiting: "Waiting for Google…",
    notes: [
      "A Google window opens. Choose your account and allow access.",
      "The app asks for full access to your mailbox, because “Delete forever” needs it. There's no server: your mail goes straight from Google to this browser.",
      "It also asks to read your contacts, for address suggestions while writing. That's optional: without it, suggestions come from your recent mail.",
      "While your Google Cloud app is in <em>Testing</em>, Google warns that it isn't verified. Choose <em>Advanced</em> → <em>Go to …</em> to continue.",
    ],
    errorQuestion: "Did Google show an error?",
    help: [
      {
        term: "“invalid_client” or “no registered origin”",
        text: "The client in Google Cloud is missing this app's address under <em>Authorized JavaScript origins</em>, or it isn't of type <em>Web application</em>. Add exactly:<origin/>Changes can take a few minutes to take effect.",
      },
      {
        term: "“Access blocked: … has not completed the Google verification process”",
        text: "Your address isn't a test user. Add it under <audience>Audience → Test users</audience>.",
      },
      {
        term: "A message about your organization or admin",
        text: "Your Google Workspace administrator blocks unverified apps. Only they can allow this app.",
      },
    ],
  },
  microsoft: {
    setUp: "Set up Microsoft",
    intro:
      "Microsoft only lets registered apps read mail. Register this app once in Microsoft Entra. It's free and takes about five minutes; the README has the details. You need a Microsoft 365 work account or a (free) Azure account for it: an Outlook.com account can sign in, but can't register apps.",
    steps: [
      "In the <entra>Microsoft Entra admin center</entra>, open <registrations>App registrations</registrations> and choose <em>New registration</em>. Name it, e.g. action0.",
      "Under <em>Supported account types</em>, choose <em>Accounts in any organizational directory and personal Microsoft accounts</em>.",
      "Under <em>Redirect URI</em>, choose <em>Single-page application (SPA)</em> and enter exactly:<redirect/>",
      "After registering, open <em>API permissions</em> → <em>Add a permission</em> → <em>Microsoft Graph</em> → <em>Delegated permissions</em> and add <code>Mail.ReadWrite</code>, <code>Mail.Send</code>, <code>People.Read</code>, <code>Calendars.ReadWrite</code> and <code>MailboxSettings.ReadWrite</code> (<code>User.Read</code> is already there).",
      "On the <em>Overview</em> page, copy the <em>Application (client) ID</em> and paste it here.",
    ],
    problems: {
      missing: "Paste the Application (client) ID from Microsoft Entra.",
      secret:
        "That's a client secret. The app needs the Application (client) ID, which looks like 00000000-0000-0000-0000-000000000000.",
      url: "That's a web address. The Application (client) ID looks like 00000000-0000-0000-0000-000000000000.",
      malformed:
        "This doesn't look like an Application (client) ID. It looks like 00000000-0000-0000-0000-000000000000.",
    } satisfies Record<SetupProblem, string>,
    connect: "Connect Microsoft",
    continueWith: "Continue with Microsoft",
    loading: "Loading Microsoft sign-in…",
    waiting: "Waiting for Microsoft…",
    notes: [
      "A Microsoft window opens. Choose your account and allow access.",
      "The app asks to read, change and send your mail, and to see the people you write with, for address suggestions. There's no server: your mail goes straight from Microsoft to this browser.",
      "Signatures can't be read from Outlook: you set them up once in Settings → Writing (they're kept in this browser).",
    ],
    errorQuestion: "Did Microsoft show an error?",
    help: [
      {
        term: "“AADSTS50011”: the redirect URI doesn't match",
        text: "The app registration is missing this exact redirect URI, of type <em>Single-page application</em> (not <em>Web</em>):<redirect/>",
      },
      {
        term: "“AADSTS700016”, “unauthorized_client” or “not supported for personal accounts”",
        text: "The client ID is wrong, or the app doesn't allow this kind of account. Check <em>Supported account types</em> under the app's <em>Authentication</em>.",
      },
      {
        term: "“Need admin approval”",
        text: "Your organization only allows apps an administrator approved. Only your IT can grant consent for this app.",
      },
    ],
  },
  // The desktop app signs in through the system browser, with other clients.
  googleDesktop: {
    setUp: "Set up Google",
    intro:
      "Google only lets registered apps read mail. Register action0 once in your own Google Cloud project. It's free and takes about ten minutes; the README has the details.",
    steps: [
      "Create a project, <gmailApi>enable the Gmail API</gmailApi>, for address suggestions <peopleApi>the People API</peopleApi> and, for the calendar, <calendarApi>the Google Calendar API</calendarApi>.",
      "In the <authPlatform>Google Auth Platform</authPlatform>, enter an app name and your email. Under <audience>Audience</audience>, choose <em>External</em> and add every address you want to connect as a <em>test user</em>. To stay signed in for longer than 7 days, choose <em>Publish app</em> there too (it stays unverified, which is fine for your own use).",
      "Under <dataAccess>Data access</dataAccess>, add the scopes <code>https://mail.google.com/</code>, <code>contacts.readonly</code>, <code>contacts.other.readonly</code>, <code>calendar.calendarlist.readonly</code> and <code>calendar.events</code>.",
      "Under <clients>Clients</clients>, create a client of type <em>Desktop app</em>.",
      "Copy the client ID and the client secret right away (Google shows the secret only once) and paste them here.",
    ],
    problems: {
      missing: "Paste the client ID from Google Cloud.",
      secret:
        "That's the client secret. It goes into the second field; the client ID ends with .apps.googleusercontent.com.",
      url: "That's a web address. The client ID ends with .apps.googleusercontent.com.",
      malformed:
        "This doesn't look like a Google client ID. It ends with .apps.googleusercontent.com.",
    } satisfies Record<SetupProblem, string>,
    connect: "Connect Google",
    continueWith: "Continue with Google",
    loading: "Loading Google sign-in…",
    waiting: "Waiting for Google in your browser…",
    notes: [
      "Your browser opens Google's sign-in. Choose your account, allow access, then come back to action0.",
      "The app asks for full access to your mailbox, because “Delete forever” needs it. There's no server: your mail goes straight from Google to this app.",
      "It also asks to read your contacts, for address suggestions while writing. That's optional: without it, suggestions come from your recent mail.",
      "While your Google Cloud app isn't verified, Google warns about it. Choose <em>Advanced</em> → <em>Go to …</em> to continue.",
    ],
    errorQuestion: "Did Google show an error?",
    help: [
      {
        term: "“invalid_client” or “client_secret is missing”",
        text: "The client ID or secret is wrong, or the client isn't of type <em>Desktop app</em>. Use “Use a different client ID” below to enter them again.",
      },
      {
        term: "“Access blocked: … has not completed the Google verification process”",
        text: "Your address isn't a test user. Add it under <audience>Audience → Test users</audience>, or publish the app there.",
      },
      {
        term: "Signed out again after a week",
        text: "While your Google Cloud app is in <em>Testing</em>, Google ends sign-ins after 7 days. Choose <em>Publish app</em> under <audience>Audience</audience>.",
      },
    ],
  },
  microsoftDesktop: {
    setUp: "Set up Microsoft",
    intro:
      "Microsoft only lets registered apps read mail. Register action0 once in Microsoft Entra. It's free and takes about five minutes; the README has the details. You need a Microsoft 365 work account or a (free) Azure account for it: an Outlook.com account can sign in, but can't register apps.",
    steps: [
      "In the <entra>Microsoft Entra admin center</entra>, open <registrations>App registrations</registrations> and choose <em>New registration</em>. Name it, e.g. action0. (Registered it for the web version already? Open it and continue with the next step but one.)",
      "Under <em>Supported account types</em>, choose <em>Accounts in any organizational directory and personal Microsoft accounts</em>.",
      "Under <em>Authentication</em> → <em>Add a platform</em>, choose <em>Mobile and desktop applications</em> and add exactly this custom redirect URI:<redirect/>",
      "Under <em>API permissions</em> → <em>Add a permission</em> → <em>Microsoft Graph</em> → <em>Delegated permissions</em>, add <code>Mail.ReadWrite</code>, <code>Mail.Send</code>, <code>People.Read</code>, <code>Calendars.ReadWrite</code> and <code>MailboxSettings.ReadWrite</code> (<code>User.Read</code> is already there).",
      "On the <em>Overview</em> page, copy the <em>Application (client) ID</em> and paste it here.",
    ],
    problems: {
      missing: "Paste the Application (client) ID from Microsoft Entra.",
      secret:
        "That's a client secret. The app needs the Application (client) ID, which looks like 00000000-0000-0000-0000-000000000000.",
      url: "That's a web address. The Application (client) ID looks like 00000000-0000-0000-0000-000000000000.",
      malformed:
        "This doesn't look like an Application (client) ID. It looks like 00000000-0000-0000-0000-000000000000.",
    } satisfies Record<SetupProblem, string>,
    connect: "Connect Microsoft",
    continueWith: "Continue with Microsoft",
    loading: "Loading Microsoft sign-in…",
    waiting: "Waiting for Microsoft in your browser…",
    notes: [
      "Your browser opens Microsoft's sign-in. Choose your account, allow access, then come back to action0.",
      "The app asks to read, change and send your mail, to see the people you write with, for address suggestions, and to use your calendar. There's no server: your mail goes straight from Microsoft to this app.",
      "Signatures can't be read from Outlook: you set them up once in Settings → Writing (they're kept in this app).",
    ],
    errorQuestion: "Did Microsoft show an error?",
    help: [
      {
        term: "“AADSTS50011”: the redirect URI doesn't match",
        text: "The app registration is missing this exact redirect URI on the platform <em>Mobile and desktop applications</em>:<redirect/>",
      },
      {
        term: "“AADSTS700016”, “unauthorized_client” or “not supported for personal accounts”",
        text: "The client ID is wrong, or the app doesn't allow this kind of account. Check <em>Supported account types</em> under the app's <em>Authentication</em>.",
      },
      {
        term: "“Need admin approval”",
        text: "Your organization only allows apps an administrator approved. Only your IT can grant consent for this app.",
      },
    ],
  },
  clientSecret: "Client secret",
  clientSecretNote:
    "Saved in the app. For desktop apps, Google doesn't treat the secret as confidential.",
  secretProblems: {
    missing:
      "Paste the client secret too (Google shows it when the client is created).",
    secret: "Paste the client secret here.",
    url: "That's a web address, not the client secret.",
    malformed:
      "This doesn't look like a client secret. It's shown next to the client ID and usually starts with GOCSPX-.",
  } satisfies Record<SetupProblem, string>,
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
  addCategoryHere: "Kategorie hinzufügen",
  moveHere: "Hierher verschieben",
  otherAccount: "Anderes Konto",
  allInboxes: "Alle Posteingänge",
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

  clientId: "Client-ID",
  clientIdNote:
    "Wird als Einstellung in diesem Browser gespeichert. Die Client-ID ist nicht geheim.",
  saveAndContinue: "Speichern und weiter",
  google: {
    setUp: "Google einrichten",
    intro:
      "Google lässt nur registrierte Apps Mails lesen. Registriere diese App einmal in deinem eigenen Google-Cloud-Projekt. Das ist kostenlos und dauert etwa zehn Minuten; Details stehen im README.",
    steps: [
      "Leg ein Projekt an, <gmailApi>aktiviere die Gmail API</gmailApi>, für Adressvorschläge <peopleApi>die People API</peopleApi> und, für den Kalender, <calendarApi>die Google Calendar API</calendarApi>.",
      "Gib in der <authPlatform>Google Auth Platform</authPlatform> einen App-Namen und deine E-Mail-Adresse ein. Wähl unter <audience>Zielgruppe (Audience)</audience> <em>Extern</em> und füge jede Adresse, die du verbinden willst, als <em>Testnutzer</em> hinzu.",
      "Füge unter <dataAccess>Datenzugriff (Data access)</dataAccess> die Bereiche <code>https://mail.google.com/</code>, <code>contacts.readonly</code>, <code>contacts.other.readonly</code>, <code>calendar.calendarlist.readonly</code> und <code>calendar.events</code> hinzu.",
      "Leg unter <clients>Clients</clients> einen Client vom Typ <em>Webanwendung</em> an. Trag genau diese Adresse unter <em>Autorisierte JavaScript-Quellen</em> ein und lass die Weiterleitungs-URIs leer:<origin/>",
      "Kopier die Client-ID und füge sie hier ein.",
    ],
    problems: {
      missing: "Füge die Client-ID aus Google Cloud ein.",
      secret:
        "Das ist das Client-Secret. Die App braucht die Client-ID, die auf .apps.googleusercontent.com endet.",
      url: "Das ist eine Webadresse. Die Client-ID endet auf .apps.googleusercontent.com.",
      malformed:
        "Das sieht nicht nach einer Google-Client-ID aus. Sie endet auf .apps.googleusercontent.com.",
    },
    connect: "Google verbinden",
    continueWith: "Weiter mit Google",
    loading: "Google-Anmeldung wird geladen …",
    waiting: "Warte auf Google …",
    notes: [
      "Ein Google-Fenster öffnet sich. Wähl dein Konto und erlaube den Zugriff.",
      "Die App bittet um vollen Zugriff auf dein Postfach, weil „Endgültig löschen“ ihn braucht. Es gibt keinen Server: Deine Mails gehen direkt von Google in diesen Browser.",
      "Sie bittet auch darum, deine Kontakte zu lesen, für Adressvorschläge beim Schreiben. Das ist freiwillig: Ohne kommen die Vorschläge aus deinen letzten Mails.",
      "Solange deine Google-Cloud-App im Status <em>Test</em> ist, warnt Google, dass sie nicht überprüft ist. Wähl <em>Erweitert</em> → <em>Zu … wechseln</em>, um fortzufahren.",
    ],
    errorQuestion: "Hat Google einen Fehler angezeigt?",
    help: [
      {
        term: "„invalid_client“ oder „no registered origin“",
        text: "Beim Client in Google Cloud fehlt die Adresse dieser App unter <em>Autorisierte JavaScript-Quellen</em>, oder er ist nicht vom Typ <em>Webanwendung</em>. Trag genau das ein:<origin/>Es kann ein paar Minuten dauern, bis Änderungen wirken.",
      },
      {
        term: "„Zugriff blockiert: … hat das Bestätigungsverfahren von Google nicht abgeschlossen“",
        text: "Deine Adresse ist nicht als Testnutzer eingetragen. Füge sie unter <audience>Zielgruppe → Testnutzer</audience> hinzu.",
      },
      {
        term: "Eine Meldung über deine Organisation oder die Administration",
        text: "Die Administration deines Google Workspace blockiert nicht überprüfte Apps. Nur sie kann diese App erlauben.",
      },
    ],
  },
  microsoft: {
    setUp: "Microsoft einrichten",
    intro:
      "Microsoft lässt nur registrierte Apps Mails lesen. Registriere diese App einmal in Microsoft Entra. Das ist kostenlos und dauert etwa fünf Minuten; Details stehen im README. Du brauchst dafür ein Microsoft-365-Arbeitskonto oder ein (kostenloses) Azure-Konto: Mit einem Outlook.com-Konto kannst du dich anmelden, aber keine Apps registrieren.",
    steps: [
      "Öffne im <entra>Microsoft Entra Admin Center</entra> die <registrations>App-Registrierungen</registrations> und wähl <em>Neue Registrierung</em>. Gib ihr einen Namen, z. B. action0.",
      "Wähl unter <em>Unterstützte Kontotypen</em> <em>Konten in einem beliebigen Organisationsverzeichnis und persönliche Microsoft-Konten</em>.",
      "Wähl unter <em>Umleitungs-URI</em> <em>Single-Page-Webanwendung (SPA)</em> und trag genau das ein:<redirect/>",
      "Öffne nach dem Registrieren <em>API-Berechtigungen</em> → <em>Berechtigung hinzufügen</em> → <em>Microsoft Graph</em> → <em>Delegierte Berechtigungen</em> und füge <code>Mail.ReadWrite</code>, <code>Mail.Send</code>, <code>People.Read</code>, <code>Calendars.ReadWrite</code> und <code>MailboxSettings.ReadWrite</code> hinzu (<code>User.Read</code> ist schon da).",
      "Kopier auf der Seite <em>Übersicht</em> die <em>Anwendungs-ID (Client)</em> und füge sie hier ein.",
    ],
    problems: {
      missing: "Füge die Anwendungs-ID (Client) aus Microsoft Entra ein.",
      secret:
        "Das ist ein geheimer Clientschlüssel. Die App braucht die Anwendungs-ID (Client), die so aussieht: 00000000-0000-0000-0000-000000000000.",
      url: "Das ist eine Webadresse. Die Anwendungs-ID (Client) sieht so aus: 00000000-0000-0000-0000-000000000000.",
      malformed:
        "Das sieht nicht nach einer Anwendungs-ID (Client) aus. Sie sieht so aus: 00000000-0000-0000-0000-000000000000.",
    },
    connect: "Microsoft verbinden",
    continueWith: "Weiter mit Microsoft",
    loading: "Microsoft-Anmeldung wird geladen …",
    waiting: "Warte auf Microsoft …",
    notes: [
      "Ein Microsoft-Fenster öffnet sich. Wähl dein Konto und erlaube den Zugriff.",
      "Die App bittet darum, deine Mails zu lesen, zu ändern und zu senden, und die Personen zu sehen, mit denen du schreibst, für Adressvorschläge. Es gibt keinen Server: Deine Mails gehen direkt von Microsoft in diesen Browser.",
      "Signaturen lassen sich nicht aus Outlook lesen: Du richtest sie einmal unter Einstellungen → Schreiben ein (sie bleiben in diesem Browser).",
    ],
    errorQuestion: "Hat Microsoft einen Fehler angezeigt?",
    help: [
      {
        term: "„AADSTS50011“: Die Umleitungs-URI passt nicht",
        text: "Bei der App-Registrierung fehlt genau diese Umleitungs-URI, vom Typ <em>Single-Page-Webanwendung</em> (nicht <em>Web</em>):<redirect/>",
      },
      {
        term: "„AADSTS700016“, „unauthorized_client“ oder „not supported for personal accounts“",
        text: "Die Client-ID ist falsch, oder die App erlaubt diese Art von Konto nicht. Prüf die <em>Unterstützten Kontotypen</em> unter <em>Authentifizierung</em> der App.",
      },
      {
        term: "„Administratorgenehmigung erforderlich“",
        text: "Deine Organisation erlaubt nur Apps, die eine Administration genehmigt hat. Nur deine IT kann dieser App zustimmen.",
      },
    ],
  },
  googleDesktop: {
    setUp: "Google einrichten",
    intro:
      "Google lässt nur registrierte Apps Mails lesen. Registriere action0 einmal in deinem eigenen Google-Cloud-Projekt. Das ist kostenlos und dauert etwa zehn Minuten; Details stehen im README.",
    steps: [
      "Lege ein Projekt an und <gmailApi>aktiviere die Gmail API</gmailApi>, für Adressvorschläge <peopleApi>die People API</peopleApi> und für den Kalender <calendarApi>die Google Calendar API</calendarApi>.",
      "Gib in der <authPlatform>Google Auth Platform</authPlatform> einen App-Namen und deine E-Mail-Adresse ein. Wähle unter <audience>Zielgruppe</audience> <em>Extern</em> und füge jede Adresse, die du verbinden willst, als <em>Testnutzer</em> hinzu. Damit du länger als 7 Tage angemeldet bleibst, wähle dort auch <em>App veröffentlichen</em> (sie bleibt unbestätigt; für den eigenen Gebrauch passt das).",
      "Füge unter <dataAccess>Datenzugriff</dataAccess> die Bereiche <code>https://mail.google.com/</code>, <code>contacts.readonly</code>, <code>contacts.other.readonly</code>, <code>calendar.calendarlist.readonly</code> und <code>calendar.events</code> hinzu.",
      "Lege unter <clients>Clients</clients> einen Client vom Typ <em>Desktop-App</em> an.",
      "Kopiere die Client-ID und gleich auch den Clientschlüssel (Google zeigt ihn nur einmal) und füge beide hier ein.",
    ],
    problems: {
      missing: "Füge die Client-ID aus Google Cloud ein.",
      secret:
        "Das ist der Clientschlüssel. Er gehört ins zweite Feld; die Client-ID endet auf .apps.googleusercontent.com.",
      url: "Das ist eine Webadresse. Die Client-ID endet auf .apps.googleusercontent.com.",
      malformed:
        "Das sieht nicht nach einer Google-Client-ID aus. Sie endet auf .apps.googleusercontent.com.",
    },
    connect: "Google verbinden",
    continueWith: "Weiter mit Google",
    loading: "Google-Anmeldung wird geladen …",
    waiting: "Warte auf Google in deinem Browser …",
    notes: [
      "Dein Browser öffnet die Google-Anmeldung. Wähle dein Konto, erlaube den Zugriff und kehre dann zu action0 zurück.",
      "Die App fragt nach vollem Zugriff auf dein Postfach, weil „Endgültig löschen“ ihn braucht. Es gibt keinen Server: Deine Mails kommen direkt von Google in diese App.",
      "Sie fragt auch, ob sie deine Kontakte lesen darf, für Adressvorschläge beim Schreiben. Das ist freiwillig: Ohne kommen die Vorschläge aus deinen letzten Mails.",
      "Solange deine Google-Cloud-App nicht bestätigt ist, warnt Google davor. Wähle <em>Erweitert</em> → <em>Weiter zu …</em>, um fortzufahren.",
    ],
    errorQuestion: "Hat Google einen Fehler gezeigt?",
    help: [
      {
        term: "„invalid_client“ oder „client_secret is missing“",
        text: "Client-ID oder Clientschlüssel stimmen nicht, oder der Client ist nicht vom Typ <em>Desktop-App</em>. Gib sie unten mit „Andere Client-ID verwenden“ neu ein.",
      },
      {
        term: "„Zugriff blockiert: … hat die Google-Überprüfung nicht abgeschlossen“",
        text: "Deine Adresse ist kein Testnutzer. Füge sie unter <audience>Zielgruppe → Testnutzer</audience> hinzu oder veröffentliche die App dort.",
      },
      {
        term: "Nach einer Woche wieder abgemeldet",
        text: "Solange deine Google-Cloud-App im <em>Test</em> ist, beendet Google Anmeldungen nach 7 Tagen. Wähle unter <audience>Zielgruppe</audience> <em>App veröffentlichen</em>.",
      },
    ],
  },
  microsoftDesktop: {
    setUp: "Microsoft einrichten",
    intro:
      "Microsoft lässt nur registrierte Apps Mails lesen. Registriere action0 einmal in Microsoft Entra. Das ist kostenlos und dauert etwa fünf Minuten; Details stehen im README. Dafür brauchst du ein Microsoft-365-Arbeitskonto oder ein (kostenloses) Azure-Konto: Ein Outlook.com-Konto kann sich anmelden, aber keine Apps registrieren.",
    steps: [
      "Öffne im <entra>Microsoft Entra Admin Center</entra> die <registrations>App-Registrierungen</registrations> und wähle <em>Neue Registrierung</em>. Gib ihr einen Namen, z. B. action0. (Schon für die Web-Version registriert? Öffne sie und mach beim übernächsten Schritt weiter.)",
      "Wähle unter <em>Unterstützte Kontotypen</em> <em>Konten in allen Organisationsverzeichnissen und persönliche Microsoft-Konten</em>.",
      "Wähle unter <em>Authentifizierung</em> → <em>Plattform hinzufügen</em> <em>Mobile und Desktopanwendungen</em> und füge genau diesen benutzerdefinierten Umleitungs-URI hinzu:<redirect/>",
      "Füge unter <em>API-Berechtigungen</em> → <em>Berechtigung hinzufügen</em> → <em>Microsoft Graph</em> → <em>Delegierte Berechtigungen</em> <code>Mail.ReadWrite</code>, <code>Mail.Send</code>, <code>People.Read</code>, <code>Calendars.ReadWrite</code> und <code>MailboxSettings.ReadWrite</code> hinzu (<code>User.Read</code> ist schon da).",
      "Kopiere auf der Seite <em>Übersicht</em> die <em>Anwendungs-ID (Client)</em> und füge sie hier ein.",
    ],
    problems: {
      missing: "Füge die Anwendungs-ID (Client) aus Microsoft Entra ein.",
      secret:
        "Das ist ein geheimer Clientschlüssel. Die App braucht die Anwendungs-ID (Client), die so aussieht: 00000000-0000-0000-0000-000000000000.",
      url: "Das ist eine Webadresse. Die Anwendungs-ID (Client) sieht so aus: 00000000-0000-0000-0000-000000000000.",
      malformed:
        "Das sieht nicht nach einer Anwendungs-ID (Client) aus. Sie sieht so aus: 00000000-0000-0000-0000-000000000000.",
    },
    connect: "Microsoft verbinden",
    continueWith: "Weiter mit Microsoft",
    loading: "Microsoft-Anmeldung wird geladen …",
    waiting: "Warte auf Microsoft in deinem Browser …",
    notes: [
      "Dein Browser öffnet die Microsoft-Anmeldung. Wähle dein Konto, erlaube den Zugriff und kehre dann zu action0 zurück.",
      "Die App fragt, ob sie deine Mails lesen, ändern und senden, die Personen sehen darf, mit denen du schreibst (für Adressvorschläge), und deinen Kalender verwenden darf. Es gibt keinen Server: Deine Mails kommen direkt von Microsoft in diese App.",
      "Signaturen lassen sich nicht aus Outlook lesen: Du richtest sie einmal unter Einstellungen → Schreiben ein (sie bleiben in dieser App).",
    ],
    errorQuestion: "Hat Microsoft einen Fehler gezeigt?",
    help: [
      {
        term: "„AADSTS50011“: Der Umleitungs-URI passt nicht",
        text: "In der App-Registrierung fehlt genau dieser Umleitungs-URI auf der Plattform <em>Mobile und Desktopanwendungen</em>:<redirect/>",
      },
      {
        term: "„AADSTS700016“, „unauthorized_client“ oder „not supported for personal accounts“",
        text: "Die Client-ID stimmt nicht, oder die App lässt diese Art von Konto nicht zu. Prüfe die <em>Unterstützten Kontotypen</em> unter <em>Authentifizierung</em> der App.",
      },
      {
        term: "„Administratorgenehmigung erforderlich“",
        text: "Deine Organisation erlaubt nur Apps, die ein Administrator genehmigt hat. Nur deine IT kann dieser App zustimmen.",
      },
    ],
  },
  clientSecret: "Clientschlüssel",
  clientSecretNote:
    "Wird in der App gespeichert. Bei Desktop-Apps behandelt Google den Schlüssel nicht als geheim.",
  secretProblems: {
    missing:
      "Füge auch den Clientschlüssel ein (Google zeigt ihn beim Anlegen des Clients).",
    secret: "Füge hier den Clientschlüssel ein.",
    url: "Das ist eine Webadresse, nicht der Clientschlüssel.",
    malformed:
      "Das sieht nicht nach einem Clientschlüssel aus. Er steht neben der Client-ID und beginnt meist mit GOCSPX-.",
  },
  otherClientId: "Eine andere Client-ID verwenden",
  copy: "Kopieren",
  copied: "Kopiert",
};

/** Accounts: the sidebar and folder tree, the welcome screen, Add account. */
export const accounts = { en, de };
