const en = {
  searchAll: "Search all mail",
  searchIn: (where: string) => `Search ${where}`,
  searchMail: "Search mail",
  clearSearch: "Clear search",
  changeOrder: "Change the sort order",
  newestFirst: "Newest first",
  oldestFirst: "Oldest first",
  searchScope: "Search in",
  scopeIn: "In",
  everywhere: "Everywhere",
  chooseFolder: "Choose a folder.",
  reconnectToSee: "Reconnect the account to see its messages.",
  sortingOldest:
    "Sorting oldest first: big folders take a moment, because every message has to be listed first.",
  noMatch: (conversations: boolean, text: string) =>
    `No ${conversations ? "conversations" : "messages"} match “${text}”.`,
  noMatchIn: (conversations: boolean, text: string, where: string) =>
    `No ${conversations ? "conversations" : "messages"} match “${text}” in ${where}.`,
  searchEverywhere: "Search everywhere",
  empty: (conversations: boolean): string =>
    conversations ? "No conversations here." : "No messages here.",
  results: (text: string) => `Results for “${text}”`,
  messagesIn: (where: string) => `Messages in ${where}`,
  messages: "Messages",
  showFolders: "Show folders",
  selected: (n: number) => `${n} selected`,
  composeButton: "Compose (c)",
  refresh: "Refresh",
  selectionActions: "Actions for the selected messages",
  loadingMessages: "Loading messages",
  deletedAfter30: (where: string) =>
    `Messages in ${where} are deleted automatically after 30 days.`,
  newAbove: (n: number) =>
    n === 1 ? "1 new message" : `${String(n)} new messages`,
  loadMore: "Load more",
  draft: "Draft",
  messageCount: " messages",
  unread: "Unread, ",
  hasAttachments: ", has attachments",
  starred: ", starred",
};

const de: typeof en = {
  searchAll: "Alle E-Mails durchsuchen",
  searchIn: (where) => `${where} durchsuchen`,
  searchMail: "E-Mails durchsuchen",
  clearSearch: "Suche löschen",
  changeOrder: "Sortierung ändern",
  newestFirst: "Neueste zuerst",
  oldestFirst: "Älteste zuerst",
  searchScope: "Suchen in",
  scopeIn: "In",
  everywhere: "Überall",
  chooseFolder: "Wähle einen Ordner.",
  reconnectToSee: "Verbinde das Konto neu, um seine Nachrichten zu sehen.",
  sortingOldest:
    "Älteste zuerst: Bei großen Ordnern dauert das einen Moment, weil zuerst alle Nachrichten aufgelistet werden.",
  noMatch: (conversations, text) =>
    `Keine ${conversations ? "Unterhaltungen" : "Nachrichten"} passen zu „${text}“.`,
  noMatchIn: (conversations, text, where) =>
    `Keine ${conversations ? "Unterhaltungen" : "Nachrichten"} in ${where} passen zu „${text}“.`,
  searchEverywhere: "Überall suchen",
  empty: (conversations) =>
    conversations ? "Keine Unterhaltungen hier." : "Keine Nachrichten hier.",
  results: (text) => `Ergebnisse für „${text}“`,
  messagesIn: (where) => `Nachrichten in ${where}`,
  messages: "Nachrichten",
  showFolders: "Ordner anzeigen",
  selected: (n) => `${n} ausgewählt`,
  composeButton: "Schreiben (c)",
  refresh: "Aktualisieren",
  selectionActions: "Aktionen für die ausgewählten Nachrichten",
  loadingMessages: "Nachrichten werden geladen",
  deletedAfter30: (where) =>
    `Nachrichten in ${where} werden nach 30 Tagen automatisch gelöscht.`,
  newAbove: (n) =>
    n === 1 ? "1 neue Nachricht" : `${String(n)} neue Nachrichten`,
  loadMore: "Mehr laden",
  draft: "Entwurf",
  messageCount: " Nachrichten",
  unread: "Ungelesen, ",
  hasAttachments: ", mit Anhang",
  starred: ", mit Stern",
};

export const list = { en, de };
