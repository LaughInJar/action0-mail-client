# Calendar servers (CalDAV)

Calendars on a CalDAV server (RFC 4791): a mail server account's own (Fastmail, iCloud, mailbox.org, GMX, Posteo, Nextcloud, your own server), or a calendar-only server added in the calendar column. CalDAV servers don't let web pages read them (no CORS), so this works only in the desktop and Android apps; the web app greys out "Add calendar server…" with a note. Like IMAP, there's no proxy and nothing on disk: the native side carries the requests and keeps the logins, the TypeScript provider speaks DAV and iCalendar, and calendars are kept in memory.

- [Pieces](#pieces)
- [Setting up a server](#setting-up-a-server)
- [The native side](#the-native-side)
- [The provider](#the-provider)
- [Invitations and guests](#invitations-and-guests)
- [Contacts](#contacts)
- [Testing](#testing)
- [Limits](#limits)

## Pieces

| Where                                                 | What                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/accounts/calendarServer.ts`                      | Provider-neutral shapes: candidates, setup, login, `CalendarServerInfo`, and the `CalendarServers` interface the dialogs use (failures are `MailServerError`s)              |
| `src/providers/caldav/bridge.ts`                      | The contract with the native side: discover, connect, servers, remove, forget certificate, and `request` (any method, every HTTP status comes back)                         |
| `src/providers/caldav/servers.ts`                     | `createCalendarServers`: the connected servers, listed once and kept current (`info(key)`, `current()`, `subscribe`)                                                        |
| `src/providers/caldav/dav.ts`                         | DAV request bodies (calendars, ETags, `sync-collection`, `calendar-multiget`) and the `multistatus` parser                                                                  |
| `src/providers/caldav/store.ts`                       | `DavStore`: one calendar's objects in memory, brought up to date by the change list or by ETags                                                                             |
| `src/providers/caldav/CaldavCalendarProvider.ts`      | The `CalendarProvider`                                                                                                                                                      |
| `src/providers/caldav/contacts.ts`                    | `CardDavAddressBooks`: the address books (CardDAV) of a login, read and searched for address suggestions                                                                    |
| `src/providers/caldav/itip.ts`                        | Invitation, update, cancellation and answer mails (iMIP) for servers that don't send them                                                                                   |
| `src/providers/ical/icalendar.ts`                     | iCalendar reading (expansion of series, events, alarms) shared with iCal subscriptions, and writing (new events, changes, overrides, EXDATE, answers, generated time zones) |
| `src/app/caldav.ts`                                   | Wiring: the servers, an IMAP account's calendar, calendar-only sources, which account sends a calendar mail, and the mails' texts in the app's language                     |
| `src/data/calendarServers.ts`                         | `CalendarServersContext` for the UI (`null` in the web app)                                                                                                                 |
| `src/ui/calendar/CalendarServerDialog.tsx`            | Set up, change or remove a server; the certificate step                                                                                                                     |
| `src/ui/accounts/MailServerFlow.tsx` (`CalendarStep`) | After a mail server account connects: its calendars are looked for and offered                                                                                              |
| `src/platform/native/caldav.ts`                       | The bridge over Tauri commands                                                                                                                                              |
| `src-tauri/src/caldav/`                               | The native side: `caldav.vault`, discovery, the setup walk, authenticated requests with the account's pinned certificate                                                    |

## Setting up a server

A mail server account's calendar source exists from the start with `setup: "server"` and access `missing`; the calendar column offers **Set up calendar** (and so does an invitation mail). New accounts get the question in the wizard right after the mail connects (`CalendarStep`): the server is looked for and, if one answers with the mail login, the user picks **Show them** or **Not now** (which forgets it again).

1. **Discover** (`caldav_discover`): candidates in order: a table of providers action0 knows (iCloud, Fastmail, mailbox.org, GMX, web.de, Posteo, Yahoo, Zoho), the domain's DNS (`_caldavs._tcp` SRV with its TXT `path=`, desktop only), `https://<domain>/.well-known/caldav` (RFC 6764), then the mail server's host.
2. **Connect** (`caldav_connect`): for each address, `current-user-principal` (a bare `/` is tried at `/.well-known/caldav` first), then the principal's `calendar-home-set`, `calendar-user-address-set` and display name, then `OPTIONS` on the home: `calendar-auto-schedule` in the `DAV` header means the server schedules itself (RFC 6638). The first address that works is kept in `caldav.vault`; failures report the most telling one (untrusted certificate, refused login, TLS, unreachable, no CalDAV there).
3. The login is the mail account's (password, or the Yahoo/AOL token as Bearer) or a separate one. A certificate the system doesn't trust is shown and can be trusted for that server, like IMAP's ([imap.md](imap.md#certificates-and-tls)).

A calendar-only server (**Add calendar server…**) takes a name, an address, user name and password; it gets the key `caldav:<id>` and its own section in the calendar column (marked CalDAV), with the server settings behind the pencil: change the address or login, forget the certificate, remove.

## The native side

`src-tauri/src/caldav/` keeps one `CalendarServer` per source key in `caldav.vault` (same keychain key as the other vaults): principal, home, the user's address, the hosts the login may go to (origins of the final discovery URL, principal and home), the login (`SameAsMail` or a password), the pinned certificate and whether the server schedules. Removing a mail server account removes its calendar entry.

`caldav_request` is shaped like `net_fetch` (raw body; `{key, id, method, url, headers}` in the `x-a0-caldav` header; the answer framed with its final URL). It refuses addresses outside the server's hosts, drops any `Authorization` (and cookies, host, length) the UI sent and adds the login's own, follows redirects itself only within the hosts and never from https to http, and renews a Yahoo/AOL token once on 401. Every HTTP status comes back to the provider; only "no answer" rejects. Each server has its own HTTP client with its pinned certificate (`client_config` in `imap/tls.rs`, shared with IMAP).

## The provider

**Calendars**: `PROPFIND` (Depth 1) on the home: collections that are calendars and hold events, with display name, Apple's colour and order, write privilege and whether they keep a change list. The first writable one is the primary.

**Events**: each calendar's objects are kept in a `DavStore`: with `sync-collection` (RFC 6578) only changes since the last token are asked for (an expired token starts over); without it, a `PROPFIND` of ETags is compared. New and changed objects are fetched with `calendar-multiget`, 50 at a time. A calendar is checked at most every 15 s unless a change forces it. `listEvents` expands every object over the range with ical.js (series with their changed occurrences, matched by UID; generated time zones for TZIDs a server left out). Event ids are `<calendar URL>\n<object URL>\n<planned start ms>`; `seriesId` is the object URL; whose event it is and the user's answer come from ORGANIZER/ATTENDEE against the user's addresses (the account's, its From addresses, the server's calendar address).

**Writes** are `PUT` with `If-Match` (changes) or `If-None-Match: *` (new), and `DELETE` with `If-Match`. A 412 (changed elsewhere) reads the calendar again and fails as `eventChanged`, so nothing is overwritten. Scopes on a series: "this" adds an override (RECURRENCE-ID) or an EXDATE; "all" changes the series and moves its overrides and EXDATEs along; "this and following" ends the series with UNTIL (COUNT is split) and writes a new object with its own UID from that occurrence on, dropping later one-off changes. Undo puts the previous text back (or deletes what was created). New events get a VTIMEZONE for their zone, generated from what the browser knows (yearly rules from the year's daylight-saving changes). Descriptions are written as text plus `X-ALT-DESC` HTML; reminders as `VALARM` (up to 5).

## Invitations and guests

`guestNotices` depends on the server: `always` when it schedules (the editor says guests will be told); otherwise `ask` when a mail account sends from the user's address (`mailerFor` in `src/app/caldav.ts`: the account with that address or From address, if it has `calendarMail`), else `never` (the editor says nobody will be told).

Where action0 sends, it uses `sendCalendarMail` of that account (Gmail, Outlook through `sendMail` with MIME, IMAP over SMTP): REQUEST to the guests on creating and changing, CANCEL to removed guests and on deleting (one occurrence: with its RECURRENCE-ID), REPLY to the organizer on answering. The text next to the iCalendar part is in the app's language.

Invitation mails of IMAP accounts carry their iCalendar part (`Invitation.ics`). `findInvitation(uid, signal, ics)` looks the UID up in the calendars; if it isn't there, it returns the invitation from the mail as an event with `inCalendar: false`, and the bar says answering adds it to the default calendar (the one used last for new events in that account, else the primary). Answering then saves it there with the answer and `SCHEDULE-AGENT=CLIENT` on its organizer, and sends the REPLY by mail (so a scheduling server doesn't answer a second time). Events the server put into the calendar are answered by changing PARTSTAT; the server tells the organizer where it schedules. A guest's answer mail (`METHOD:REPLY`) for one of the user's events is taken into the event when the mail is opened (`applyReply`), where the server doesn't do that.

## Contacts

Address suggestions of mail server accounts come from CardDAV address books (RFC 6352), found with the calendar server's login: the setup walk asks the principal for `addressbook-home-set` too, and where the principal has none, the provider's own contacts host from the known-providers table is walked (`carddav.fastmail.com`, `contacts.icloud.com`, `carddav.gmx.net`, `carddav.web.de`, Yahoo's). That host joins the server's `hosts`, so the login may go there. Servers set up before contacts existed are checked once (`caldav_find_contacts`, `contactsChecked`).

`CardDavAddressBooks` (`src/providers/caldav/contacts.ts`) lists the address books under the home (resourcetype `addressbook`), keeps each in a `DavStore` (`kind: "addressbook"`: `addressbook-multiget` with `address-data`), reads the vCards (3.0 and 4.0) with ical.js and searches locally: every word of the query must start a word of the name (FN, else N), nickname, organization or address; whole-name matches come first, then name-word matches, then address-only ones, a preferred address a little ahead. Each address of a contact is its own suggestion. Contacts are kept in memory only.

`contactsFor(account)` (`src/app/caldav.ts`) decides whose address books an account searches: its own server's if it has one, else every calendar-only server's (merged, each address once). The IMAP provider has `contacts` and `recentToo`, so `useAddressSuggestions` shows the address book's matches first and then people from recent mail who aren't among them; without an address book, recent mail only, as before.

## Testing

- `src/test/davServer.ts`: `fakeDavServer()`, an in-memory CalDAV server behind a fake bridge: calendars, objects with ETags, change lists (or ETags only), conditional writes, scheduling on or off, and the setup calls. `icsEvent()` makes simple objects.
- `src/providers/caldav/CaldavCalendarProvider.test.ts`: calendars, expansion, following changes made elsewhere (both sync ways), create/change/delete with undo, scopes, conflicts, guests in each notice mode, invitations from mail, answers by a scheduling server, guests' answers.
- `src/providers/ical/icalendar.test.ts`: writing and reading back, time zones across daylight saving, overrides, EXDATE, moving a series, guests and answers.
- `src/providers/caldav/contacts.test.ts`: reading vCards (3.0, 4.0, grouped and preferred addresses, no FN), the search order, address books found and followed, servers checked once.
- `src/ui/caldav.test.tsx`: contact suggestions before recent mail, the wizard's calendar step, **Set up calendar**, answering an IMAP invitation (event saved, REPLY sent over SMTP), calendar-only servers (wrong password, added, removed), web app note. `renderApp({ imap, caldav })` wires them.
- `src-tauri/src/caldav/tests.rs`: host checks, the login header, redirects, discovery order, the setup walk against a local mock server, pinning.
- Live: a Radicale container (no scheduling) and a scheduling server (Baïkal) with the desktop app, Dovecot and Mailpit for the iMIP mails.

## Limits

- Desktop and Android apps only. Android has no DNS lookups, so SRV records aren't used there.
- Tasks (VTODO), creating or sharing calendars, free/busy lookups, and editing contacts or a contacts view aren't part of it; address books are used for suggestions only.
- Every calendar is downloaded once per run (then only changes): very large calendars take a moment the first time.
- One trusted certificate per server.
