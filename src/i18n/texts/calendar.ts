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
};

/** The calendar: switch, toolbar, column, views, event details, invitations. */
export const calendar = { en, de };
