import type {
  Repeat,
  ResponseStatus,
  Rsvp,
  VideoCall,
} from "../../core/calendar";
import type { CalendarView } from "../../state/router";

const en = {
  // The Mail | Calendar switch.
  mail: "Mail",
  calendar: "Calendar",
  switchLabel: "Mail or calendar",

  // The toolbar.
  today: "Today",
  previous: "Previous",
  next: "Next",
  viewLabel: "View",
  views: {
    day: "Day",
    week: "Week",
    month: "Month",
    agenda: "Agenda",
  } satisfies Record<CalendarView, string>,
  showCalendars: "Show calendars",

  // The calendar column.
  calendars: "Calendars",
  chooseDate: "Choose a date",
  previousMonth: "Previous month",
  nextMonth: "Next month",
  allowCalendar: "Allow calendar",
  allowHint: "Calendar access isn’t allowed for this account yet.",
  reconnectFirst: "Reconnect the account to see its calendars.",
  loadingCalendars: "Loading calendars…",
  couldntLoad: (why: string) => `Couldn’t load: ${why}`,
  noSources:
    "No calendars yet. Google and Microsoft accounts bring theirs; you can also add a calendar by its address.",
  icsMarker: "iCal subscription, saved in this browser",
  icsBadge: "iCal",
  calendarActions: (name: string) => `Actions for ${name}`,
  edit: "Edit…",
  remove: "Remove",
  removeTitle: (name: string) => `Remove “${name}”?`,
  removeMessage:
    "The calendar disappears from action0 in this browser. The calendar itself stays where it is.",
  removed: (name: string) => `Removed “${name}”`,

  // Adding an iCal calendar.
  addByUrl: "Add calendar by address…",
  // Calendar servers (CalDAV).
  addServer: "Add calendar server…",
  addServerAppsOnly:
    "Calendar servers (CalDAV) work in the desktop and Android apps.",
  setUpCalendar: "Set up calendar",
  setUpHint: "Show this account’s calendars from its calendar server.",
  serverBadge: "CalDAV",
  serverMarker: "Calendar server (CalDAV)",
  serverSettingsOf: (name: string) => `Calendar server of ${name}`,
  guestsNotNotified:
    "Guests won’t be notified: no account in action0 sends mail from your address on this calendar.",
  answeringAdds: (calendar: string) =>
    `Not in your calendar yet: answering adds it to “${calendar}”.`,
  replyApplied: "The guest’s answer is now in your event.",
  server: {
    titleAccount: (address: string) => `Calendars of ${address}`,
    titleNew: "Add calendar server",
    titleEdit: (name: string) => `Calendar server: ${name}`,
    looking: "Looking for the calendar server…",
    found: (where: string) => `Found: ${where}.`,
    notFound:
      "No calendar server was found for this address. Enter its address if you know it.",
    url: "Server address",
    urlHint:
      "The server’s web address, e.g. https://cloud.example.com (Nextcloud: …/remote.php/dav).",
    name: "Name",
    sameLogin: "Same login as the mail",
    otherLogin: "Another login",
    username: "User name",
    password: "Password",
    passwordAgain: "Enter the password again to save changes.",
    appPassword: "Create an app password",
    connect: "Connect",
    connecting: "Connecting…",
    connected: (name: string) => `Calendars of ${name} are shown`,
    connectedWithContacts: (name: string) =>
      `Calendars and contacts of ${name} are used`,
    disconnect: "Stop showing these calendars",
    forgetCertificate: "Forget the trusted certificate",
    certificateForgotten: "The certificate is no longer trusted.",
    removeTitle: (name: string) => `Remove ${name}?`,
    removeMessage:
      "Its calendars disappear from action0. They stay on the server.",
    disconnectTitle: (name: string) => `Stop showing the calendars of ${name}?`,
    removed: (name: string) => `Removed ${name}`,
    errors: {
      auth: "The server refused the login. Check the user name and password; many providers need an app password.",
      notFound: "No calendar server answered at this address.",
      unreachable: (host: string) => `${host} couldn’t be reached.`,
      tls: (host: string) => `No secure connection to ${host}.`,
      server: (message: string) => `The server said: ${message}`,
    },
  },
  calendarStep: {
    looking: "Looking for the account’s calendars…",
    found: (host: string) =>
      `This account’s calendars are on ${host}. Show them in action0’s calendar too?`,
    foundWithContacts: (host: string) =>
      `This account’s calendars and contacts are on ${host}. Show them in action0 too?`,
    show: "Show them",
    notNow: "Not now",
  },
  addTitle: "Add calendar by address",
  editTitle: (name: string) => `Edit “${name}”`,
  url: "Address (iCal)",
  urlHint:
    "An https:// or webcal:// address of an .ics calendar. It’s saved in this browser; anyone with the address can read the calendar, so treat it like a password.",
  name: "Name",
  colour: "Colour",
  checking: "Checking…",
  add: "Add",
  save: "Save",
  added: (name: string) => `Added “${name}”`,
  defaultName: "Subscribed calendar",

  // Views.
  allDay: "All day",
  more: (n: number) => `+${String(n)} more`,
  noEvents: "Nothing planned.",
  agendaEmpty: "Nothing planned in these 30 days.",
  laterInAgenda: "Show 30 more days",
  week: (n: number) => `Week ${String(n)}`,
  now: "Now",
  loading: "Loading events…",
  noTitle: "(No title)",

  // An event.
  closeEvent: "Close",
  location: "Location",
  join: "Join meeting",
  organizer: "Organizer",
  guests: (n: number) => (n === 1 ? "1 guest" : `${String(n)} guests`),
  responses: {
    accepted: "Accepted",
    tentative: "Maybe",
    declined: "Declined",
    needsAction: "No answer yet",
  } satisfies Record<ResponseStatus, string>,
  optional: "optional",
  plannedIn: (zone: string) => `Planned in ${zone}`,
  repeats: "Repeats",
  cancelled: "Cancelled",
  tentativeEvent: "Tentative",
  openOriginal: "Open in its calendar",
  description: "Description",
  calendarLine: (calendar: string, source: string) => `${calendar} · ${source}`,

  // Answering.
  going: "Going?",
  answers: {
    accepted: "Yes",
    tentative: "Maybe",
    declined: "No",
  } satisfies Record<Rsvp, string>,
  answered: (answer: Rsvp, title: string): string =>
    answer === "accepted"
      ? `Accepted “${title}”`
      : answer === "tentative"
        ? `Answered maybe to “${title}”`
        : `Declined “${title}”`,
  couldntAnswer: "Couldn’t send your answer",

  // Invitations in mail.
  invitation: "Invitation",
  notInCalendar: "This event isn’t in your calendar (yet).",
  clashes: (titles: string) => `Clashes with: ${titles}`,
  noClash: "Nothing else at that time.",
  invitationCancelled: "This event was cancelled.",
  invitationReply: "An answer to an invitation.",
  // Mails action0 sends for calendar servers that don't (iMIP).
  itip: {
    request: (title: string) => `Invitation: ${title}`,
    update: (title: string) => `Updated invitation: ${title}`,
    cancel: (title: string) => `Cancelled: ${title}`,
    reply: (name: string, answer: Rsvp, title: string) =>
      `${name} ${answer === "accepted" ? "accepted" : answer === "tentative" ? "might come" : "declined"}: ${title}`,
    when: "When",
    where: "Where",
    organizer: "Organizer",
  },
  lookingUp: "Looking up the event…",
  allowToAnswer: "Allow calendar access to answer here.",

  // Creating and editing.
  newEvent: "New event",
  editEvent: "Edit event",
  titleLabel: "Title",
  titlePlaceholder: "Add a title",
  starts: "Starts",
  ends: "Ends",
  startDate: "Start date",
  startTime: "Start time",
  endDate: "End date",
  endTime: "End time",
  endsBeforeStart: "The event ends before it starts.",
  repeatLabel: "Repeat",
  repeatNone: "Doesn’t repeat",
  repeatKinds: {
    daily: () => "Daily",
    weekdays: () => "Every weekday (Monday to Friday)",
    weekly: (weekday: string) => `Weekly on ${weekday}`,
    monthly: (day: number) => `Monthly on day ${String(day)}`,
    yearly: (date: string) => `Annually on ${date}`,
    custom: () => "Custom (stays as it is)",
  } satisfies Record<Repeat["kind"], (value: never) => string>,
  repeatEnds: "Ends",
  endsNever: "Never",
  endsOn: "On a date",
  untilLabel: "Last day",
  calendarLabel: "Calendar",
  videoCalls: {
    googleMeet: "Add a Google Meet video call",
    teams: "Add a Teams meeting",
  } satisfies Record<VideoCall, string>,
  teamsFixed: "A Teams meeting can’t be removed again.",
  locationPlaceholder: "Add a location",
  guestsLabel: "Guests",
  guestsNotified: "Guests will be notified of changes.",
  descriptionPlaceholder: "Add a description",
  loadingEvent: "Loading the event…",
  couldntLoadEvent: (why: string) => `Couldn’t load the event: ${why}`,
  noWritableCalendar:
    "There’s no calendar you can add events to yet. Allow calendar access for a Google or Microsoft account first.",
  newEventHere: "New event",

  // Questions.
  scopeTitle: (kind: "change" | "delete"): string =>
    kind === "change" ? "Change a repeating event" : "Delete a repeating event",
  scopeThis: "This event",
  scopeFollowing: "This and following events",
  scopeFollowingHint:
    "Later events that were changed on their own lose those changes.",
  scopeAll: "All events",
  notifyTitle: (kind: "create" | "change" | "delete"): string =>
    kind === "create"
      ? "Send invitations to the guests?"
      : kind === "change"
        ? "Send an update to the guests?"
        : "Send a cancellation to the guests?",
  notifyMessage: "Guests get an email from Google.",
  send: "Send",
  dontSend: "Don’t send",
  deleteMeetingTitle: (title: string) => `Delete “${title}”?`,
  deleteMeetingMessage: "The guests get a cancellation. This can’t be undone.",
  discardTitle: "Discard changes?",
  discardMessage: "Your changes to this event haven’t been saved.",
  discard: "Discard",
  keepEditing: "Keep editing",

  // Toasts.
  created: (title: string) => `Created “${title}”`,
  saved: (title: string) => `Saved “${title}”`,
  moved: (title: string) => `Moved “${title}”`,
  deleted: (title: string) => `Deleted “${title}”`,
  couldntSave: "Couldn’t save the event",
  couldntDelete: "Couldn’t delete the event",

  // Reminders.
  reminders: {
    label: "Reminders",
    numbered: (n: number) => `Reminder ${String(n)}`,
    add: "Add reminder",
    remove: (what: string) => `Remove the reminder “${what}”`,
    none: "No reminders",
    atStart: "At the start",
    minutesBefore: (n: number) =>
      n === 1 ? "1 minute before" : `${String(n)} minutes before`,
    hoursBefore: (n: number) =>
      n === 1 ? "1 hour before" : `${String(n)} hours before`,
    daysBefore: (n: number) =>
      n === 1 ? "1 day before" : `${String(n)} days before`,
    onTheDay: "On the day",
    dayBeforeAt: (time: string) => `The day before at ${time}`,
    daysBeforeAt: (n: number, time: string) =>
      `${String(n)} days before at ${time}`,
    weekBeforeAt: (time: string) => `A week before at ${time}`,
    panel: "Reminders",
    inMinutes: (n: number) =>
      n <= 0 ? "Now" : n === 1 ? "In 1 minute" : `In ${String(n)} minutes`,
    startedAgo: (n: number) =>
      n === 1 ? "Started 1 minute ago" : `Started ${String(n)} minutes ago`,
    tomorrow: "Tomorrow",
    join: "Join",
    open: "Open",
    snooze: "Snooze",
    snoozeFor: (what: string) => `Snooze ${what}`,
    snoozeChoices: {
      5: "5 minutes",
      10: "10 minutes",
      60: "1 hour",
    } satisfies Record<5 | 10 | 60, string>,
    untilStart: "Until it starts",
    dismiss: "Dismiss",
    dismissAll: "Dismiss all",
    notifyBody: (when: string, where: string | undefined) =>
      where ? `${when} · ${where}` : when,
    couldntUpdate: "Couldn’t update the reminder",
  },
};

const de: typeof en = {
  mail: "Mail",
  calendar: "Kalender",
  switchLabel: "Mail oder Kalender",

  today: "Heute",
  previous: "Zurück",
  next: "Weiter",
  viewLabel: "Ansicht",
  views: {
    day: "Tag",
    week: "Woche",
    month: "Monat",
    agenda: "Terminliste",
  },
  showCalendars: "Kalender anzeigen",

  calendars: "Kalender",
  chooseDate: "Datum wählen",
  previousMonth: "Voriger Monat",
  nextMonth: "Nächster Monat",
  allowCalendar: "Kalender erlauben",
  allowHint: "Für dieses Konto ist der Kalenderzugriff noch nicht erlaubt.",
  reconnectFirst: "Verbinde das Konto neu, um seine Kalender zu sehen.",
  loadingCalendars: "Kalender werden geladen …",
  couldntLoad: (why) => `Laden fehlgeschlagen: ${why}`,
  noSources:
    "Noch keine Kalender. Google- und Microsoft-Konten bringen ihre mit; du kannst auch einen Kalender über seine Adresse hinzufügen.",
  icsMarker: "iCal-Abo, in diesem Browser gespeichert",
  icsBadge: "iCal",
  calendarActions: (name) => `Aktionen für ${name}`,
  edit: "Bearbeiten …",
  remove: "Entfernen",
  removeTitle: (name) => `„${name}“ entfernen?`,
  removeMessage:
    "Der Kalender verschwindet in diesem Browser aus action0. Der Kalender selbst bleibt, wo er ist.",
  removed: (name) => `„${name}“ entfernt`,

  addByUrl: "Kalender über Adresse hinzufügen …",
  addServer: "Kalenderserver hinzufügen …",
  addServerAppsOnly:
    "Kalenderserver (CalDAV) gibt es in der Desktop- und der Android-App.",
  setUpCalendar: "Kalender einrichten",
  setUpHint: "Zeigt die Kalender dieses Kontos von seinem Kalenderserver.",
  serverBadge: "CalDAV",
  serverMarker: "Kalenderserver (CalDAV)",
  serverSettingsOf: (name) => `Kalenderserver von ${name}`,
  guestsNotNotified:
    "Die Gäste werden nicht informiert: Kein Konto in action0 sendet Mails von deiner Adresse in diesem Kalender.",
  answeringAdds: (calendar) =>
    `Noch nicht in deinem Kalender: Deine Antwort trägt ihn in „${calendar}“ ein.`,
  replyApplied: "Die Antwort des Gastes steht jetzt in deinem Termin.",
  server: {
    titleAccount: (address) => `Kalender von ${address}`,
    titleNew: "Kalenderserver hinzufügen",
    titleEdit: (name) => `Kalenderserver: ${name}`,
    looking: "Kalenderserver wird gesucht …",
    found: (where) => `Gefunden: ${where}.`,
    notFound:
      "Für diese Adresse wurde kein Kalenderserver gefunden. Gib seine Adresse ein, wenn du sie kennst.",
    url: "Serveradresse",
    urlHint:
      "Die Webadresse des Servers, z. B. https://cloud.example.com (Nextcloud: …/remote.php/dav).",
    name: "Name",
    sameLogin: "Dieselbe Anmeldung wie für die Mails",
    otherLogin: "Eine andere Anmeldung",
    username: "Benutzername",
    password: "Passwort",
    passwordAgain:
      "Gib das Passwort noch einmal ein, um Änderungen zu speichern.",
    appPassword: "App-Passwort erstellen",
    connect: "Verbinden",
    connecting: "Wird verbunden …",
    connected: (name) => `Die Kalender von ${name} werden angezeigt`,
    connectedWithContacts: (name) =>
      `Die Kalender und Kontakte von ${name} werden verwendet`,
    disconnect: "Diese Kalender nicht mehr anzeigen",
    forgetCertificate: "Vertrauenswürdiges Zertifikat vergessen",
    certificateForgotten: "Dem Zertifikat wird nicht mehr vertraut.",
    removeTitle: (name) => `${name} entfernen?`,
    removeMessage:
      "Seine Kalender verschwinden aus action0. Auf dem Server bleiben sie.",
    disconnectTitle: (name) => `Die Kalender von ${name} nicht mehr anzeigen?`,
    removed: (name) => `${name} entfernt`,
    errors: {
      auth: "Der Server hat die Anmeldung abgelehnt. Prüf Benutzername und Passwort; viele Anbieter brauchen ein App-Passwort.",
      notFound: "Unter dieser Adresse hat kein Kalenderserver geantwortet.",
      unreachable: (host) => `${host} war nicht erreichbar.`,
      tls: (host) => `Keine sichere Verbindung zu ${host}.`,
      server: (message) => `Der Server meldet: ${message}`,
    },
  },
  calendarStep: {
    looking: "Die Kalender des Kontos werden gesucht …",
    found: (host) =>
      `Die Kalender dieses Kontos liegen auf ${host}. Auch im Kalender von action0 anzeigen?`,
    foundWithContacts: (host) =>
      `Die Kalender und Kontakte dieses Kontos liegen auf ${host}. Auch in action0 anzeigen?`,
    show: "Anzeigen",
    notNow: "Jetzt nicht",
  },
  addTitle: "Kalender über Adresse hinzufügen",
  editTitle: (name) => `„${name}“ bearbeiten`,
  url: "Adresse (iCal)",
  urlHint:
    "Eine https://- oder webcal://-Adresse eines .ics-Kalenders. Sie wird in diesem Browser gespeichert; wer die Adresse hat, kann den Kalender lesen, also behandle sie wie ein Passwort.",
  name: "Name",
  colour: "Farbe",
  checking: "Wird geprüft …",
  add: "Hinzufügen",
  save: "Speichern",
  added: (name) => `„${name}“ hinzugefügt`,
  defaultName: "Abonnierter Kalender",

  allDay: "Ganztägig",
  more: (n) => `+${String(n)} weitere`,
  noEvents: "Nichts geplant.",
  agendaEmpty: "In diesen 30 Tagen ist nichts geplant.",
  laterInAgenda: "30 weitere Tage zeigen",
  week: (n) => `KW ${String(n)}`,
  now: "Jetzt",
  loading: "Termine werden geladen …",
  noTitle: "(Ohne Titel)",

  closeEvent: "Schließen",
  location: "Ort",
  join: "An Besprechung teilnehmen",
  organizer: "Organisator",
  guests: (n) => (n === 1 ? "1 Gast" : `${String(n)} Gäste`),
  responses: {
    accepted: "Zugesagt",
    tentative: "Vielleicht",
    declined: "Abgesagt",
    needsAction: "Noch keine Antwort",
  },
  optional: "optional",
  plannedIn: (zone) => `Geplant in ${zone}`,
  repeats: "Wiederholt sich",
  cancelled: "Abgesagt",
  tentativeEvent: "Vorläufig",
  openOriginal: "In seinem Kalender öffnen",
  description: "Beschreibung",
  calendarLine: (calendar, source) => `${calendar} · ${source}`,

  going: "Teilnehmen?",
  answers: {
    accepted: "Ja",
    tentative: "Vielleicht",
    declined: "Nein",
  },
  answered: (answer, title) =>
    answer === "accepted"
      ? `„${title}“ zugesagt`
      : answer === "tentative"
        ? `„${title}“ mit Vielleicht beantwortet`
        : `„${title}“ abgesagt`,
  couldntAnswer: "Deine Antwort konnte nicht gesendet werden",

  invitation: "Einladung",
  notInCalendar: "Dieser Termin ist (noch) nicht in deinem Kalender.",
  clashes: (titles) => `Überschneidet sich mit: ${titles}`,
  noClash: "Zu dieser Zeit ist sonst nichts.",
  invitationCancelled: "Dieser Termin wurde abgesagt.",
  invitationReply: "Eine Antwort auf eine Einladung.",
  itip: {
    request: (title) => `Einladung: ${title}`,
    update: (title) => `Geänderte Einladung: ${title}`,
    cancel: (title) => `Abgesagt: ${title}`,
    reply: (name, answer, title) =>
      `${name} ${answer === "accepted" ? "hat zugesagt" : answer === "tentative" ? "kommt vielleicht" : "hat abgesagt"}: ${title}`,
    when: "Wann",
    where: "Wo",
    organizer: "Organisation",
  },
  lookingUp: "Termin wird gesucht …",
  allowToAnswer: "Erlaube den Kalenderzugriff, um hier zu antworten.",

  newEvent: "Neuer Termin",
  editEvent: "Termin bearbeiten",
  titleLabel: "Titel",
  titlePlaceholder: "Titel hinzufügen",
  starts: "Beginn",
  ends: "Ende",
  startDate: "Anfangsdatum",
  startTime: "Anfangszeit",
  endDate: "Enddatum",
  endTime: "Endzeit",
  endsBeforeStart: "Der Termin endet, bevor er beginnt.",
  repeatLabel: "Wiederholen",
  repeatNone: "Keine Wiederholung",
  repeatKinds: {
    daily: () => "Täglich",
    weekdays: () => "Jeden Werktag (Montag bis Freitag)",
    weekly: (weekday: string) => `Wöchentlich am ${weekday}`,
    monthly: (day: number) => `Monatlich am ${String(day)}.`,
    yearly: (date: string) => `Jährlich am ${date}`,
    custom: () => "Benutzerdefiniert (bleibt, wie sie ist)",
  },
  repeatEnds: "Endet",
  endsNever: "Nie",
  endsOn: "An einem Datum",
  untilLabel: "Letzter Tag",
  calendarLabel: "Kalender",
  videoCalls: {
    googleMeet: "Google-Meet-Videokonferenz hinzufügen",
    teams: "Teams-Besprechung hinzufügen",
  },
  teamsFixed: "Eine Teams-Besprechung kann nicht mehr entfernt werden.",
  locationPlaceholder: "Ort hinzufügen",
  guestsLabel: "Gäste",
  guestsNotified: "Die Gäste werden über Änderungen informiert.",
  descriptionPlaceholder: "Beschreibung hinzufügen",
  loadingEvent: "Termin wird geladen …",
  couldntLoadEvent: (why) => `Termin konnte nicht geladen werden: ${why}`,
  noWritableCalendar:
    "Es gibt noch keinen Kalender, in den du Termine eintragen kannst. Erlaube zuerst den Kalenderzugriff für ein Google- oder Microsoft-Konto.",
  newEventHere: "Neuer Termin",

  scopeTitle: (kind) =>
    kind === "change"
      ? "Wiederkehrenden Termin ändern"
      : "Wiederkehrenden Termin löschen",
  scopeThis: "Dieser Termin",
  scopeFollowing: "Dieser und alle folgenden Termine",
  scopeFollowingHint:
    "Spätere Termine, die einzeln geändert wurden, verlieren diese Änderungen.",
  scopeAll: "Alle Termine",
  notifyTitle: (kind) =>
    kind === "create"
      ? "Einladungen an die Gäste senden?"
      : kind === "change"
        ? "Aktualisierung an die Gäste senden?"
        : "Absage an die Gäste senden?",
  notifyMessage: "Die Gäste bekommen eine E-Mail von Google.",
  send: "Senden",
  dontSend: "Nicht senden",
  deleteMeetingTitle: (title) => `„${title}“ löschen?`,
  deleteMeetingMessage:
    "Die Gäste bekommen eine Absage. Das kann nicht rückgängig gemacht werden.",
  discardTitle: "Änderungen verwerfen?",
  discardMessage:
    "Deine Änderungen an diesem Termin sind noch nicht gespeichert.",
  discard: "Verwerfen",
  keepEditing: "Weiter bearbeiten",

  created: (title) => `„${title}“ erstellt`,
  saved: (title) => `„${title}“ gespeichert`,
  moved: (title) => `„${title}“ verschoben`,
  deleted: (title) => `„${title}“ gelöscht`,
  couldntSave: "Der Termin konnte nicht gespeichert werden",
  couldntDelete: "Der Termin konnte nicht gelöscht werden",

  reminders: {
    label: "Erinnerungen",
    numbered: (n) => `Erinnerung ${String(n)}`,
    add: "Erinnerung hinzufügen",
    remove: (what) => `Erinnerung „${what}“ entfernen`,
    none: "Keine Erinnerungen",
    atStart: "Zu Beginn",
    minutesBefore: (n) =>
      n === 1 ? "1 Minute vorher" : `${String(n)} Minuten vorher`,
    hoursBefore: (n) =>
      n === 1 ? "1 Stunde vorher" : `${String(n)} Stunden vorher`,
    daysBefore: (n) => (n === 1 ? "1 Tag vorher" : `${String(n)} Tage vorher`),
    onTheDay: "Am selben Tag",
    dayBeforeAt: (time) => `Am Vortag um ${time}`,
    daysBeforeAt: (n, time) => `${String(n)} Tage vorher um ${time}`,
    weekBeforeAt: (time) => `Eine Woche vorher um ${time}`,
    panel: "Erinnerungen",
    inMinutes: (n) =>
      n <= 0 ? "Jetzt" : n === 1 ? "In 1 Minute" : `In ${String(n)} Minuten`,
    startedAgo: (n) =>
      n === 1
        ? "Hat vor 1 Minute begonnen"
        : `Hat vor ${String(n)} Minuten begonnen`,
    tomorrow: "Morgen",
    join: "Teilnehmen",
    open: "Öffnen",
    snooze: "Später erinnern",
    snoozeFor: (what) => `In ${what} erinnern`,
    snoozeChoices: {
      5: "5 Minuten",
      10: "10 Minuten",
      60: "1 Stunde",
    },
    untilStart: "Zu Beginn",
    dismiss: "Schließen",
    dismissAll: "Alle schließen",
    notifyBody: (when, where) => (where ? `${when} · ${where}` : when),
    couldntUpdate: "Die Erinnerung konnte nicht geändert werden",
  },
};

/** The calendar: switch, toolbar, column, views, event details, invitations. */
export const calendar = { en, de };
