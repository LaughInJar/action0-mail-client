const en = {
  // Toolbar, menus.
  summarize: "Summarize",
  summarizeButton: "Summarize with AI (b)",
  ask: "Ask about this mail",
  askButton: "Ask AI about this mail (q)",
  replyWithAi: "Reply with AI",

  // The reader's panel.
  panel: "AI assistant",
  summary: "Summary",
  you: "You",
  stop: "Stop",
  tryAgain: "Try again",
  copy: "Copy",
  copied: "Copied the answer",
  close: "Close the AI panel",
  askPlaceholder: "Ask about this mail…",
  askPlaceholderThread: "Ask about this conversation…",
  askSend: "Ask",
  writing: "Writing…",
  stopped: "Stopped.",
  partly: (included: number, total: number) =>
    `Only the newest ${String(included)} of ${String(total)} messages were read; the older ones didn’t fit.`,

  // The composer's field.
  writeButton: "Write with AI (Ctrl+J)",
  field: "AI instruction",
  placeholders: {
    new: "What should the mail say? For example: invite the team to Friday’s review",
    reply:
      "What should the reply say? For example: accept, suggest Tuesday instead",
    selection: "How should the selected text change?",
    draft: "How should the draft change?",
  },
  write: "Write",
  rewrite: "Rewrite",
  quick: {
    shorter: "Shorter",
    formal: "More formal",
    friendly: "Friendlier",
    fix: "Fix spelling & grammar",
    translate: "Translate to…",
  },
  quickActions: "Quick changes",
  /**
   * What the quick changes ask the AI (in English, which every model
   * follows); Translate goes into the field for the user to finish.
   */
  quickInstructions: {
    shorter: "Make it shorter.",
    formal: "Make it more formal.",
    friendly: "Make it friendlier.",
    fix: "Fix spelling and grammar only; change nothing else.",
    translate: "Translate to ",
  },
  undo: "Undo",
  closeField: "Close the AI field",

  // The picker.
  picker: "AI service and model",
  filterModels: "Filter models",
  recent: "Recent",
  loadingModels: "Loading models…",
  noModels: "No models match.",
  couldntLoadModels: "Couldn’t load the models.",

  // ChatGPT's notes (OpenAI asks for them).
  usingPlan: "Using ChatGPT plan",
  manageUsage: "Manage usage",

  // Errors.
  errors: {
    key: (service: string) =>
      `${service} didn’t accept the key. Check it in Settings → AI assistant.`,
    keyMissing: (service: string) =>
      `The key for ${service} isn’t known in this browser session. Enter it again in Settings → AI assistant.`,
    signIn: (service: string) =>
      `The sign-in at ${service} has run out. Sign in again in Settings → AI assistant.`,
    credit: (service: string) =>
      `${service} says the account has no credit left.`,
    limit: (service: string) =>
      `${service} is limiting requests right now. Try again in a moment.`,
    planLimit: "Your ChatGPT plan’s usage limit is reached.",
    notEligible: "Your ChatGPT plan can’t be used for this.",
    unavailable: (service: string) =>
      `${service} is busy or down right now. Try again later.`,
    unreachable: (service: string) =>
      `${service} didn’t answer. Check the connection.`,
    unreachableLocal: (service: string) =>
      `${service} didn’t answer. Is it running? A copy of action0 on a website also needs the server to allow that site (Ollama: OLLAMA_ORIGINS; LM Studio: CORS in its server settings).`,
    model: "The service doesn’t offer this model (any more). Pick another one.",
    other: (service: string, message: string) => `${service}: ${message}`,
  },
  openSettings: "Open settings",

  // The note before a service's first use.
  notice: {
    title: (service: string) => `Send mail to ${service}?`,
    message: (service: string) =>
      `When you use an AI button, action0 sends ${service} the text of that mail or conversation (senders, recipients, dates, subjects and text; no attachments or images), or of your draft. Nothing is sent otherwise.`,
    local: (service: string) =>
      `${service} runs on this computer: when you use an AI button, the mail’s text goes to it and nowhere else.`,
    policy: (service: string) => `What ${service} does with it`,
    continue: "Continue",
    chatgptTitle: "You’re using your ChatGPT plan",
    chatgptMessage:
      "action0’s requests count toward your ChatGPT plan’s usage limits. You can see and limit how much action0 uses in ChatGPT’s settings.",
  },

  // Settings.
  settings: {
    section: "AI assistant",
    intro:
      "Summaries, answers about mail, and help writing. action0 sends a mail to an AI only when you press an AI button.",
    none: "No AI service is set up yet. The AI buttons appear once one is.",
    services: "AI services",
    add: "Add AI service",
    kind: "Service",
    kindNames: { compatible: "Other server", demo: "Demo AI" },
    kindHints: {
      anthropic: "Claude, with an API key from Anthropic",
      openai: "OpenAI’s GPT models, with an API key",
      gemini: "Google’s models, with an API key from Google AI Studio",
      openrouter:
        "Claude, GPT, Gemini and many more: sign in, paid from your OpenRouter credit",
      chatgpt: "Your ChatGPT Go, Plus or Pro plan, without an API key",
      chatgptWeb:
        "Only in the desktop app: OpenAI allows this sign-in in apps only.",
      ollama: "Models running on this computer",
      lmstudio: "Models running on this computer",
      compatible:
        "A server with an OpenAI-compatible API (Azure OpenAI and others)",
      demo: "Sample answers, nothing is sent",
    },
    key: "API key",
    keyOptional: "API key (if the server needs one)",
    getKey: "Get a key",
    remember: "Remember in this browser",
    rememberHint:
      "Otherwise you enter it again after closing the browser. Anyone using this browser profile could use the key.",
    keySession: "Key kept for this browser session",
    keyRemembered: "Key remembered in this browser",
    keyNeeded: "Enter the key again for this session",
    keyVault: "Key kept by the app",
    keyUntilQuit:
      "Key kept until you quit: this computer has no keychain the app can use",
    signedIn: "Signed in",
    signedInAs: (account: string) => `Signed in as ${account}`,
    signInNeeded: "Sign in again",
    url: "Address of the API",
    urlHint: "Usually ends in /v1.",
    name: "Name",
    testAndAdd: "Test and add",
    testing: "Testing…",
    save: "Save",
    remove: "Remove",
    signOut: "Sign out",
    signInOpenRouter: "Sign in with OpenRouter",
    orKey: "Or enter an OpenRouter key",
    continueWithChatGpt: "Continue with ChatGPT",
    signingIn: "Waiting for the sign-in in the other window…",
    stopWaiting: "Stop waiting",
    popupBlocked:
      "The browser blocked the sign-in window. Allow pop-ups for this site and try again.",
    signInFailed: (service: string) => `Signing in at ${service} didn’t work.`,
    couldntConnect: (service: string) =>
      `Couldn’t connect to ${service}. Check the address and that it’s running.`,
    privacyLink: "Data policy",
    privacy: {
      anthropic:
        "Anthropic deletes what it gets through the API within 30 days and doesn’t train on it without your permission.",
      openai:
        "OpenAI doesn’t train on API data unless you opt in, and keeps it up to 30 days to detect abuse.",
      gemini:
        "Careful: with a free Gemini key, Google may use what you send to improve its products, and people may read it. Paid keys aren’t used that way.",
      openrouter:
        "OpenRouter keeps no prompts unless you opt in; the model’s provider has its own terms. OpenRouter’s settings can exclude providers that train on data.",
      chatgpt:
        "Requests count toward your plan’s usage limits. OpenAI’s terms for apps that use your plan apply.",
      ollama: "Runs on this computer: nothing leaves it.",
      lmstudio: "Runs on this computer: nothing leaves it.",
      compatible: "What happens to the mail depends on who runs the server.",
      demo: "The demo AI answers with sample text and sends nothing anywhere.",
    },
  },
};

const de: typeof en = {
  summarize: "Zusammenfassen",
  summarizeButton: "Mit KI zusammenfassen (b)",
  ask: "Fragen zu dieser Mail",
  askButton: "Die KI zu dieser Mail fragen (q)",
  replyWithAi: "Mit KI antworten",

  panel: "KI-Assistent",
  summary: "Zusammenfassung",
  you: "Du",
  stop: "Stopp",
  tryAgain: "Nochmal",
  copy: "Kopieren",
  copied: "Antwort kopiert",
  close: "KI-Bereich schließen",
  askPlaceholder: "Frag etwas zu dieser Mail …",
  askPlaceholderThread: "Frag etwas zu dieser Unterhaltung …",
  askSend: "Fragen",
  writing: "Schreibt …",
  stopped: "Angehalten.",
  partly: (included: number, total: number) =>
    `Nur die neuesten ${String(included)} von ${String(total)} Nachrichten wurden gelesen; die älteren passten nicht mehr.`,

  writeButton: "Mit KI schreiben (Strg+J)",
  field: "Anweisung für die KI",
  placeholders: {
    new: "Was soll in der Mail stehen? Zum Beispiel: lade das Team zur Besprechung am Freitag ein",
    reply:
      "Was soll die Antwort sagen? Zum Beispiel: zusagen, aber Dienstag vorschlagen",
    selection: "Wie soll sich der markierte Text ändern?",
    draft: "Wie soll sich der Entwurf ändern?",
  },
  write: "Schreiben",
  rewrite: "Umschreiben",
  quick: {
    shorter: "Kürzer",
    formal: "Förmlicher",
    friendly: "Freundlicher",
    fix: "Rechtschreibung & Grammatik",
    translate: "Übersetzen nach …",
  },
  quickActions: "Schnelle Änderungen",
  quickInstructions: {
    shorter: "Make it shorter.",
    formal: "Make it more formal.",
    friendly: "Make it friendlier.",
    fix: "Fix spelling and grammar only; change nothing else.",
    translate: "Übersetze nach ",
  },
  undo: "Rückgängig",
  closeField: "KI-Feld schließen",

  picker: "KI-Dienst und Modell",
  filterModels: "Modelle filtern",
  recent: "Zuletzt verwendet",
  loadingModels: "Modelle werden geladen …",
  noModels: "Kein Modell passt.",
  couldntLoadModels: "Die Modelle konnten nicht geladen werden.",

  usingPlan: "Nutzt dein ChatGPT-Abo",
  manageUsage: "Nutzung verwalten",

  errors: {
    key: (service: string) =>
      `${service} hat den Schlüssel nicht angenommen. Prüf ihn unter Einstellungen → KI-Assistent.`,
    keyMissing: (service: string) =>
      `Der Schlüssel für ${service} ist in dieser Browsersitzung nicht bekannt. Gib ihn unter Einstellungen → KI-Assistent erneut ein.`,
    signIn: (service: string) =>
      `Die Anmeldung bei ${service} ist abgelaufen. Melde dich unter Einstellungen → KI-Assistent neu an.`,
    credit: (service: string) =>
      `${service} meldet, dass auf dem Konto kein Guthaben mehr ist.`,
    limit: (service: string) =>
      `${service} begrenzt gerade die Anfragen. Versuch es gleich nochmal.`,
    planLimit: "Das Nutzungslimit deines ChatGPT-Abos ist erreicht.",
    notEligible: "Dein ChatGPT-Abo kann dafür nicht genutzt werden.",
    unavailable: (service: string) =>
      `${service} ist gerade ausgelastet oder nicht erreichbar. Versuch es später nochmal.`,
    unreachable: (service: string) =>
      `${service} hat nicht geantwortet. Prüf die Verbindung.`,
    unreachableLocal: (service: string) =>
      `${service} hat nicht geantwortet. Läuft es? Eine action0-Kopie auf einer Website braucht außerdem die Erlaubnis des Servers für diese Site (Ollama: OLLAMA_ORIGINS; LM Studio: CORS in den Server-Einstellungen).`,
    model: "Der Dienst bietet dieses Modell nicht (mehr) an. Wähl ein anderes.",
    other: (service: string, message: string) => `${service}: ${message}`,
  },
  openSettings: "Einstellungen öffnen",

  notice: {
    title: (service: string) => `Mails an ${service} senden?`,
    message: (service: string) =>
      `Wenn du einen KI-Knopf verwendest, schickt action0 ${service} den Text dieser Mail oder Unterhaltung (Absender, Empfänger, Datum, Betreff und Text; keine Anhänge oder Bilder) oder deines Entwurfs. Sonst wird nichts gesendet.`,
    local: (service: string) =>
      `${service} läuft auf diesem Computer: Wenn du einen KI-Knopf verwendest, geht der Text der Mail dorthin und sonst nirgends.`,
    policy: (service: string) => `Was ${service} damit macht`,
    continue: "Weiter",
    chatgptTitle: "Du nutzt dein ChatGPT-Abo",
    chatgptMessage:
      "Anfragen von action0 zählen zu den Nutzungslimits deines ChatGPT-Abos. In den ChatGPT-Einstellungen siehst und begrenzt du, wie viel action0 verbraucht.",
  },

  settings: {
    section: "KI-Assistent",
    intro:
      "Zusammenfassungen, Antworten zu Mails und Hilfe beim Schreiben. action0 schickt eine Mail nur dann an eine KI, wenn du einen KI-Knopf drückst.",
    none: "Noch kein KI-Dienst eingerichtet. Die KI-Knöpfe erscheinen, sobald einer da ist.",
    services: "KI-Dienste",
    add: "KI-Dienst hinzufügen",
    kind: "Dienst",
    kindNames: { compatible: "Anderer Server", demo: "Demo-KI" },
    kindHints: {
      anthropic: "Claude, mit einem API-Schlüssel von Anthropic",
      openai: "Die GPT-Modelle von OpenAI, mit einem API-Schlüssel",
      gemini:
        "Die Modelle von Google, mit einem API-Schlüssel aus Google AI Studio",
      openrouter:
        "Claude, GPT, Gemini und viele mehr: anmelden, bezahlt mit deinem OpenRouter-Guthaben",
      chatgpt: "Dein ChatGPT-Abo (Go, Plus oder Pro), ohne API-Schlüssel",
      chatgptWeb:
        "Nur in der Desktop-App: OpenAI erlaubt diese Anmeldung nur in Apps.",
      ollama: "Modelle auf diesem Computer",
      lmstudio: "Modelle auf diesem Computer",
      compatible:
        "Ein Server mit OpenAI-kompatibler API (Azure OpenAI und andere)",
      demo: "Beispielantworten, nichts wird gesendet",
    },
    key: "API-Schlüssel",
    keyOptional: "API-Schlüssel (falls der Server einen braucht)",
    getKey: "Schlüssel holen",
    remember: "In diesem Browser merken",
    rememberHint:
      "Sonst gibst du ihn nach dem Schließen des Browsers erneut ein. Wer dieses Browserprofil nutzt, könnte den Schlüssel verwenden.",
    keySession: "Schlüssel für diese Browsersitzung gespeichert",
    keyRemembered: "Schlüssel in diesem Browser gemerkt",
    keyNeeded: "Gib den Schlüssel für diese Sitzung erneut ein",
    keyVault: "Schlüssel in der App gespeichert",
    keyUntilQuit:
      "Schlüssel bis zum Beenden gespeichert: Dieser Computer hat keinen Schlüsselbund, den die App nutzen kann",
    signedIn: "Angemeldet",
    signedInAs: (account: string) => `Angemeldet als ${account}`,
    signInNeeded: "Neu anmelden",
    url: "Adresse der API",
    urlHint: "Endet meist auf /v1.",
    name: "Name",
    testAndAdd: "Testen und hinzufügen",
    testing: "Wird getestet …",
    save: "Speichern",
    remove: "Entfernen",
    signOut: "Abmelden",
    signInOpenRouter: "Bei OpenRouter anmelden",
    orKey: "Oder einen OpenRouter-Schlüssel eingeben",
    continueWithChatGpt: "Weiter mit ChatGPT",
    signingIn: "Warte auf die Anmeldung im anderen Fenster …",
    stopWaiting: "Nicht mehr warten",
    popupBlocked:
      "Der Browser hat das Anmeldefenster blockiert. Erlaube Pop-ups für diese Site und versuch es nochmal.",
    signInFailed: (service: string) =>
      `Die Anmeldung bei ${service} hat nicht geklappt.`,
    couldntConnect: (service: string) =>
      `Keine Verbindung zu ${service}. Prüf die Adresse und ob er läuft.`,
    privacyLink: "Datenschutz",
    privacy: {
      anthropic:
        "Anthropic löscht, was über die API kommt, innerhalb von 30 Tagen und trainiert ohne deine Erlaubnis nicht damit.",
      openai:
        "OpenAI trainiert nicht mit API-Daten, außer du stimmst zu, und bewahrt sie bis zu 30 Tage zur Missbrauchserkennung auf.",
      gemini:
        "Achtung: Mit einem kostenlosen Gemini-Schlüssel darf Google das Gesendete zur Verbesserung seiner Produkte nutzen, und Menschen können es lesen. Bezahlte Schlüssel werden so nicht genutzt.",
      openrouter:
        "OpenRouter speichert keine Anfragen, außer du stimmst zu; für das Modell gelten die Bedingungen seines Anbieters. In den OpenRouter-Einstellungen kannst du Anbieter ausschließen, die mit Daten trainieren.",
      chatgpt:
        "Anfragen zählen zu den Nutzungslimits deines Abos. Es gelten die Bedingungen von OpenAI für Apps, die dein Abo nutzen.",
      ollama: "Läuft auf diesem Computer: Nichts verlässt ihn.",
      lmstudio: "Läuft auf diesem Computer: Nichts verlässt ihn.",
      compatible:
        "Was mit den Mails passiert, hängt davon ab, wer den Server betreibt.",
      demo: "Die Demo-KI antwortet mit Beispieltext und sendet nichts.",
    },
  },
};

export const ai = { en, de };
