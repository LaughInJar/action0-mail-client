import { asCalendarId } from "../../core/calendar";
import type { EmailAddress } from "../../core/model";
import type { FakeCalendarData } from "./FakeCalendarProvider";

/** UID of the invitation the demo inbox has a mail for. */
export const DEMO_INVITATION_UID = "design-review@demo.example";

/** Calendar ids of the demo account. */
export const DEMO_CALENDAR = {
  work: asCalendarId("work"),
  personal: asCalendarId("personal"),
  holidays: asCalendarId("holidays"),
} as const;

const ME: EmailAddress = { name: "Demo User", address: "demo@example.com" };
const ANNA: EmailAddress = {
  name: "Anna Berger",
  address: "anna.berger@example.org",
};
const JONAS: EmailAddress = {
  name: "Jonas Gruber",
  address: "jonas.gruber@example.org",
};
const MIA: EmailAddress = {
  name: "Mia Steiner",
  address: "mia.steiner@example.com",
};

/** The demo account's calendars, with events around `now`. */
export function createDemoCalendar(now = Date.now()): FakeCalendarData {
  const { work, personal, holidays } = DEMO_CALENDAR;
  return {
    me: ME,
    now,
    calendars: [
      {
        id: work,
        name: "Work",
        color: "#039be5",
        primary: true,
        shownByDefault: true,
        readOnly: false,
        videoCall: "googleMeet",
      },
      {
        id: personal,
        name: "Personal",
        color: "#33b679",
        primary: false,
        shownByDefault: true,
        readOnly: false,
      },
      {
        id: holidays,
        name: "Holidays",
        color: "#f4511e",
        primary: false,
        shownByDefault: true,
        readOnly: true,
      },
    ],
    events: [
      {
        key: "standup",
        calendarId: work,
        title: "Stand-up",
        weekdays: [1, 2, 3, 4, 5],
        start: "09:30",
        end: "09:45",
        meetingUrl: "https://meet.example/standup",
        organizer: ME,
        attendees: [ANNA, JONAS, MIA],
      },
      {
        key: "team",
        calendarId: work,
        title: "Team meeting",
        weekdays: [2],
        start: "14:00",
        end: "15:00",
        location: "Meeting room 1",
        organizer: ANNA,
        attendees: [JONAS, MIA],
        invited: "accepted",
        description: "Weekly status, then one topic in depth.",
      },
      {
        key: "design-review",
        calendarId: work,
        title: "Design review",
        day: 3,
        start: "11:00",
        end: "12:00",
        location: "Meeting room 2",
        organizer: ANNA,
        attendees: [JONAS],
        invited: "needsAction",
        description: "Let's go through the new logo and the website drafts.",
        uid: DEMO_INVITATION_UID,
      },
      {
        key: "one-on-one",
        calendarId: work,
        title: "1:1 with Mia",
        day: 3,
        start: "11:30",
        end: "12:00",
        organizer: MIA,
        invited: "accepted",
      },
      {
        key: "planning",
        calendarId: work,
        title: "Quarterly planning",
        day: 7,
        start: "10:00",
        end: "11:30",
        organizer: JONAS,
        attendees: [ANNA, MIA],
        invited: "needsAction",
        meetingUrl: "https://meet.example/planning",
      },
      {
        key: "conference",
        calendarId: work,
        title: "Web conference in Vienna",
        day: 9,
        days: 3,
        location: "Austria Center Vienna",
      },
      {
        key: "lunch",
        calendarId: personal,
        title: "Lunch with Sophie",
        day: 2,
        start: "12:30",
        end: "13:30",
        location: "Café Central",
      },
      {
        key: "gym",
        calendarId: personal,
        title: "Gym",
        weekdays: [1, 4],
        start: "18:00",
        end: "19:00",
      },
      {
        key: "holiday",
        calendarId: holidays,
        title: "Public holiday",
        day: 4,
      },
    ],
  };
}
