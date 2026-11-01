const en = {
  // The composer.
  sendLater: "Send later",
  menu: "Send later…",
  /** The menu's button next to Send (and the clock on phones). */
  options: "More send options (Ctrl+Shift+Enter)",
  presets: {
    "this-afternoon": "This afternoon",
    "tomorrow-morning": "Tomorrow morning",
    "tomorrow-afternoon": "Tomorrow afternoon",
    "monday-morning": "Monday morning",
  },
  lastPicked: "As last time",
  pickTime: "Pick date & time…",
  pickTitle: "Send later",
  date: "Date",
  time: "Time",
  schedule: "Schedule",
  cancel: "Cancel",
  mustBeLater: "Pick a time at least a minute from now.",
  /** The composer's line above a scheduled mail. */
  scheduledLine: (when: string) => `Scheduled for ${when}`,
  dontSchedule: "Don’t schedule",
  sendNow: "Send now",
  // Toasts.
  scheduledFor: (when: string) => `Scheduled for ${when}`,
  rescheduled: (when: string) => `Rescheduled for ${when}`,
  unscheduled: "Back in Drafts",
  sent: (subject: string) => `Sent your scheduled mail “${subject}”`,
  couldntSchedule: "Couldn’t schedule the mail",
  couldntUnschedule: "Couldn’t take the mail back",
  couldntSend: "Couldn’t send the scheduled mail",
  // A scheduled mail in the reader.
  banner: (when: string) => `This mail goes out ${when}.`,
  bannerHeld: "Outlook sends it, even with action0 closed.",
  bannerDrafts:
    "action0 sends it if it’s running then (in a browser tab or the action0 app).",
  changeTime: "Change time",
  edit: "Edit",
  cancelSend: "Cancel send",
  // Commands (the command palette).
  commandSendNow: "Send the scheduled mail now",
  commandChangeTime: "Change the send time",
  commandEdit: "Edit the scheduled mail",
  commandCancel: "Cancel the scheduled send",
  // Mail that wasn't sent in time.
  missed: (count: number, when: string) =>
    count === 1
      ? `1 scheduled mail wasn’t sent (${when})`
      : `${String(count)} scheduled mails weren’t sent (from ${when})`,
  open: "Open",
  dismiss: "Not now",
};

const de: typeof en = {
  sendLater: "Später senden",
  menu: "Später senden …",
  options: "Weitere Sendeoptionen (Strg+Umschalt+Eingabe)",
  presets: {
    "this-afternoon": "Heute Nachmittag",
    "tomorrow-morning": "Morgen früh",
    "tomorrow-afternoon": "Morgen Nachmittag",
    "monday-morning": "Montag früh",
  },
  lastPicked: "Wie zuletzt",
  pickTime: "Datum und Uhrzeit wählen …",
  pickTitle: "Später senden",
  date: "Datum",
  time: "Uhrzeit",
  schedule: "Planen",
  cancel: "Abbrechen",
  mustBeLater: "Wähle eine Zeit mindestens eine Minute ab jetzt.",
  scheduledLine: (when: string) => `Geplant für ${when}`,
  dontSchedule: "Nicht planen",
  sendNow: "Jetzt senden",
  scheduledFor: (when: string) => `Geplant für ${when}`,
  rescheduled: (when: string) => `Neu geplant für ${when}`,
  unscheduled: "Zurück in den Entwürfen",
  sent: (subject: string) => `Geplante Mail „${subject}“ gesendet`,
  couldntSchedule: "Die Mail konnte nicht geplant werden",
  couldntUnschedule: "Die Mail konnte nicht zurückgeholt werden",
  couldntSend: "Die geplante Mail konnte nicht gesendet werden",
  banner: (when: string) => `Diese Mail geht ${when} hinaus.`,
  bannerHeld: "Outlook sendet sie, auch wenn action0 geschlossen ist.",
  bannerDrafts:
    "action0 sendet sie, wenn es dann läuft (in einem Browser-Tab oder in der action0-App).",
  changeTime: "Zeit ändern",
  edit: "Bearbeiten",
  cancelSend: "Senden abbrechen",
  commandSendNow: "Geplante Mail jetzt senden",
  commandChangeTime: "Sendezeit ändern",
  commandEdit: "Geplante Mail bearbeiten",
  commandCancel: "Geplantes Senden abbrechen",
  missed: (count: number, when: string) =>
    count === 1
      ? `1 geplante Mail wurde nicht gesendet (${when})`
      : `${String(count)} geplante Mails wurden nicht gesendet (ab ${when})`,
  open: "Öffnen",
  dismiss: "Nicht jetzt",
};

export const schedule = { en, de };
