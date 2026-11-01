const en = {
  title: "Command palette",
  /** The button in the left column's header. */
  open: "Command palette (Ctrl+K)",
  placeholder: "Go to, do or search…",
  sections: {
    recent: "Recent",
    places: "Places",
    actions: "Actions",
    search: "Search",
  },
  noMatch: "Nothing matches.",
  close: "Close",
  searchMail: (text: string) => `Search mail for “${text}”`,
  everywhere: "Everywhere",
  theme: (name: string) => `Theme: ${name}`,
};

const de: typeof en = {
  title: "Befehlspalette",
  open: "Befehlspalette (Strg+K)",
  placeholder: "Gehe zu, tu oder suche …",
  sections: {
    recent: "Zuletzt",
    places: "Orte",
    actions: "Aktionen",
    search: "Suche",
  },
  noMatch: "Nichts passt.",
  close: "Schließen",
  searchMail: (text: string) => `Mails nach „${text}“ durchsuchen`,
  everywhere: "Überall",
  theme: (name: string) => `Design: ${name}`,
};

export const palette = { en, de };
