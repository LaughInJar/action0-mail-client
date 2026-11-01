const en = {
  snooze: "Snooze",
  /** The toolbar button and menu entry, with the key. */
  button: "Snooze (h)",
  presets: {
    "later-today": "Later today",
    "tomorrow-morning": "Tomorrow morning",
    weekend: "This weekend",
    "next-week": "Next week",
  },
  /** A snoozed row: when it comes back. */
  back: (when: string) => `Back ${when}`,
  /** The tag of a row that came back. */
  backTag: "Back from snooze",
  // A snoozed mail in the reader.
  banner: (when: string) => `Snoozed until ${when}.`,
  unsnooze: "Unsnooze",
  changeTime: "Change time",
  rescheduled: (when: string) => `Snoozed until ${when}`,
  // Commands (the command palette).
  commandUnsnooze: "Unsnooze: back to the Inbox now",
  commandChangeTime: "Change the snooze time",
  // Coming back.
  backNotice: (subject: string) => `Back from snooze: ${subject}`,
  backMany: (count: number) => `${String(count)} snoozed messages are back`,
  couldntWake: "Couldn’t bring snoozed mail back",
};

const de: typeof en = {
  snooze: "Zurückstellen",
  button: "Zurückstellen (h)",
  presets: {
    "later-today": "Später heute",
    "tomorrow-morning": "Morgen früh",
    weekend: "Am Wochenende",
    "next-week": "Nächste Woche",
  },
  back: (when: string) => `Zurück ${when}`,
  backTag: "Wieder da",
  banner: (when: string) => `Zurückgestellt bis ${when}.`,
  unsnooze: "Zurückholen",
  changeTime: "Zeit ändern",
  rescheduled: (when: string) => `Zurückgestellt bis ${when}`,
  commandUnsnooze: "Zurückholen: jetzt wieder in den Posteingang",
  commandChangeTime: "Zeit des Zurückstellens ändern",
  backNotice: (subject: string) => `Wieder da: ${subject}`,
  backMany: (count: number) =>
    `${String(count)} zurückgestellte Nachrichten sind wieder da`,
  couldntWake: "Zurückgestellte Mails konnten nicht zurückgeholt werden",
};

export const snooze = { en, de };
