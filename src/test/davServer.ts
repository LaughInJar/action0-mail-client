/**
 * An in-memory CalDAV server behind a fake {@link CaldavBridge}: calendars
 * with objects, ETags, a change list (sync tokens), conditional writes, and
 * the setup calls (discover, connect, servers). Enough for the provider and
 * the UI; it answers the requests action0 sends, not every DAV request.
 */
import { vi } from "vitest";
import type {
  CalendarServerCandidate,
  CalendarServerInfo,
  CalendarServerSetup,
} from "../accounts/calendarServer";
import { MailServerError } from "../accounts/mailServer";
import type {
  CaldavBridge,
  DavRequest,
  DavResponse,
} from "../providers/caldav/bridge";

export const DAV_ORIGIN = "https://dav.example.com";
export const DAV_HOME = `${DAV_ORIGIN}/calendars/me/`;

/** A calendar on the fake server. */
export interface FakeDavCalendar {
  /** Its path segment under the home ("work"). */
  readonly name: string;
  readonly displayName: string;
  readonly color?: string;
  readonly readOnly?: boolean;
}

interface Stored {
  text: string;
  etag: string;
}

interface Change {
  readonly version: number;
  readonly href: string;
  readonly removed: boolean;
}

/** Options of {@link fakeDavServer}. */
export interface FakeDavOptions {
  readonly calendars?: readonly FakeDavCalendar[];
  /** Objects per calendar name: file name → iCalendar text. */
  readonly objects?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The server keeps a change list (`sync-collection`). Default: yes. */
  readonly syncable?: boolean;
  /** The server sends invitations and answers itself (RFC 6638). */
  readonly scheduling?: boolean;
  /** Servers already connected (by source key). */
  readonly connected?: readonly string[];
  /** The user's calendar address. */
  readonly address?: string;
  /** Candidates `discover` finds. */
  readonly candidates?: readonly CalendarServerCandidate[];
  /** Failures `connect` throws first, in order. */
  readonly connectFailures?: readonly MailServerError[];
  /** PUT answers leave out the ETag (some servers do). */
  readonly noEtagOnPut?: boolean;
  /**
   * Address books (CardDAV) by name: file name → vCard text. Without them
   * the login has no address book home.
   */
  readonly addressBooks?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Connected servers looked for address books already. Default: yes. */
  readonly contactsChecked?: boolean;
}

/** The address book home of the fake server. */
export const DAV_CONTACTS = `${DAV_ORIGIN}/addressbooks/me/`;

const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** See the module docs. */
export function fakeDavServer(options: FakeDavOptions = {}) {
  const calendars = options.calendars ?? [
    { name: "personal", displayName: "Personal", color: "#33b679ff" },
  ];
  const syncable = options.syncable ?? true;
  /** Objects by absolute path ("/calendars/me/personal/x.ics"). */
  const objects = new Map<string, Stored>();
  const changes: Change[] = [];
  let version = 1;
  let etagCounter = 1;
  const nextEtag = () => `"e${String(etagCounter++)}"`;
  const pathOf = (calendar: string) => `/calendars/me/${calendar}/`;
  const bookPath = (book: string) => `/addressbooks/me/${book}/`;
  for (const [calendar, files] of Object.entries(options.objects ?? {}))
    for (const [file, text] of Object.entries(files))
      objects.set(`${pathOf(calendar)}${file}`, { text, etag: nextEtag() });
  for (const [book, files] of Object.entries(options.addressBooks ?? {}))
    for (const [file, text] of Object.entries(files))
      objects.set(`${bookPath(book)}${file}`, { text, etag: nextEtag() });
  /** Calendars and address books, by path. */
  const collections = [
    ...calendars.map((calendar) => ({
      path: pathOf(calendar.name),
      readOnly: calendar.readOnly === true,
      kind: "calendar" as const,
    })),
    ...Object.keys(options.addressBooks ?? {}).map((book) => ({
      path: bookPath(book),
      readOnly: false,
      kind: "addressbook" as const,
    })),
  ];

  const servers = new Map<string, CalendarServerInfo>();
  const info = (key: string, sameAsMail = true): CalendarServerInfo => ({
    key,
    label: key.replace(/^imap:/, ""),
    home: DAV_HOME,
    principal: `${DAV_ORIGIN}/principals/me/`,
    ...(options.address ? { address: options.address } : {}),
    username: sameAsMail ? "" : "me",
    sameAsMail,
    scheduling: options.scheduling ?? false,
    pinned: false,
    ...(options.addressBooks && contactsChecked
      ? { contacts: DAV_CONTACTS }
      : {}),
    contactsChecked,
  });
  let contactsChecked = true;
  for (const key of options.connected ?? []) servers.set(key, info(key));
  // Servers set up before contacts were looked for.
  if (options.contactsChecked === false) {
    contactsChecked = false;
    for (const key of options.connected ?? []) servers.set(key, info(key));
    contactsChecked = true;
  }
  const failures = [...(options.connectFailures ?? [])];
  /** Every request, for assertions. */
  const requests: DavRequest[] = [];
  const connected: CalendarServerSetup[] = [];
  let nextId = 1;

  const record = (href: string, removed: boolean) => {
    version++;
    changes.push({ version, href, removed });
  };

  const multistatus = (responses: readonly string[], token?: string) => ({
    status: 207,
    headers: { "content-type": "application/xml; charset=utf-8" },
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">
${responses.join("\n")}
${token === undefined ? "" : `<d:sync-token>${token}</d:sync-token>`}
</d:multistatus>`,
  });
  const ok = (href: string, props: string) =>
    `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const missing = (href: string) =>
    `<d:response><d:href>${xmlEscape(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
  const inCollection = (collection: string) =>
    [...objects.keys()].filter((path) => path.startsWith(collection));
  const inCalendar = (calendar: string) => inCollection(pathOf(calendar));
  const collectionOf = (path: string) =>
    collections.find((collection) => path.startsWith(collection.path));

  const answer = (request: DavRequest): Omit<DavResponse, "url"> => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const body = request.body ?? "";
    const header = (name: string) =>
      Object.entries(request.headers ?? {}).find(
        ([key]) => key.toLowerCase() === name,
      )?.[1];
    if (request.method === "PROPFIND" && path === "/calendars/me/") {
      return multistatus([
        ok(
          "/calendars/me/",
          "<d:resourcetype><d:collection/></d:resourcetype>",
        ),
        ...calendars.map((calendar) =>
          ok(
            pathOf(calendar.name),
            [
              "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
              `<d:displayname>${xmlEscape(calendar.displayName)}</d:displayname>`,
              calendar.color
                ? `<a:calendar-color>${calendar.color}</a:calendar-color>`
                : "",
              '<c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>',
              `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${calendar.readOnly ? "" : "<d:privilege><d:write/></d:privilege>"}</d:current-user-privilege-set>`,
              syncable
                ? `<d:sync-token>v:${String(version)}</d:sync-token>`
                : "",
            ].join(""),
          ),
        ),
        ok(
          "/calendars/me/inbox/",
          "<d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>",
        ),
      ]);
    }
    if (
      request.method === "PROPFIND" &&
      path === "/addressbooks/me/" &&
      options.addressBooks
    ) {
      return multistatus([
        ok(
          "/addressbooks/me/",
          "<d:resourcetype><d:collection/></d:resourcetype>",
        ),
        ...Object.keys(options.addressBooks).map((book) =>
          ok(
            bookPath(book),
            `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>${xmlEscape(book)}</d:displayname>${syncable ? `<d:sync-token>v:${String(version)}</d:sync-token>` : ""}`,
          ),
        ),
      ]);
    }
    const calendar = collectionOf(path);
    if (request.method === "PROPFIND" && calendar) {
      return multistatus([
        ok(
          calendar.path,
          calendar.kind === "calendar"
            ? "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"
            : "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>",
        ),
        ...inCollection(calendar.path).map((href) =>
          ok(href, `<d:getetag>${objects.get(href)?.etag ?? ""}</d:getetag>`),
        ),
      ]);
    }
    if (
      request.method === "REPORT" &&
      calendar &&
      body.includes("sync-collection")
    ) {
      if (!syncable) return { status: 403, headers: {}, body: "" };
      const token =
        /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(body)?.[1] ?? "";
      let since = 0;
      if (token) {
        const match = /^v:(\d+)$/.exec(token);
        if (!match) return { status: 403, headers: {}, body: "" };
        since = Number(match[1]);
      }
      const entries = new Map<string, boolean>();
      if (since === 0)
        for (const href of inCollection(calendar.path))
          entries.set(href, false);
      else
        for (const change of changes)
          if (change.version > since && collectionOf(change.href) === calendar)
            entries.set(change.href, change.removed);
      return multistatus(
        [...entries].map(([href, removed]) =>
          removed || !objects.has(href)
            ? missing(href)
            : ok(
                href,
                `<d:getetag>${objects.get(href)?.etag ?? ""}</d:getetag>`,
              ),
        ),
        `v:${String(version)}`,
      );
    }
    if (
      request.method === "REPORT" &&
      calendar &&
      (body.includes("calendar-multiget") ||
        body.includes("addressbook-multiget"))
    ) {
      const data =
        calendar.kind === "calendar" ? "c:calendar-data" : "card:address-data";
      const hrefs = [...body.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map(
        (match) => decodeURIComponent(match[1] ?? ""),
      );
      return multistatus(
        hrefs.map((href) => {
          const stored = objects.get(href);
          return stored
            ? ok(
                href,
                `<d:getetag>${stored.etag}</d:getetag><${data}>${xmlEscape(stored.text)}</${data}>`,
              )
            : missing(href);
        }),
      );
    }
    if (request.method === "PUT" && calendar) {
      if (calendar.readOnly) return { status: 403, headers: {}, body: "" };
      const existing = objects.get(path);
      const ifMatch = header("if-match");
      if (header("if-none-match") === "*" && existing)
        return { status: 412, headers: {}, body: "" };
      if (ifMatch && ifMatch !== existing?.etag)
        return { status: 412, headers: {}, body: "" };
      const etag = nextEtag();
      objects.set(path, { text: body, etag });
      record(path, false);
      return {
        status: existing ? 204 : 201,
        headers: options.noEtagOnPut ? {} : { etag },
        body: "",
      };
    }
    if (request.method === "DELETE" && calendar) {
      const existing = objects.get(path);
      if (!existing) return { status: 404, headers: {}, body: "" };
      const ifMatch = header("if-match");
      if (ifMatch && ifMatch !== existing.etag)
        return { status: 412, headers: {}, body: "" };
      objects.delete(path);
      record(path, true);
      return { status: 204, headers: {}, body: "" };
    }
    return { status: 400, headers: {}, body: "" };
  };

  const bridge: CaldavBridge = {
    discover: vi.fn<CaldavBridge["discover"]>(() =>
      Promise.resolve(
        options.candidates ?? [{ url: `${DAV_ORIGIN}/`, source: "wellKnown" }],
      ),
    ),
    connect: vi.fn<CaldavBridge["connect"]>((setup) => {
      connected.push(setup);
      const failure = failures.shift();
      if (failure) return Promise.reject(failure);
      if ("password" in setup.login && setup.login.password !== "secret")
        return Promise.reject(
          new MailServerError("auth", "401", { server: "caldav" }),
        );
      const key = setup.key ?? `caldav:${String(nextId++)}`;
      const connectedInfo = {
        ...info(key, "sameAsMail" in setup.login),
        ...(setup.label ? { label: setup.label } : {}),
      };
      servers.set(key, connectedInfo);
      return Promise.resolve(connectedInfo);
    }),
    servers: () => Promise.resolve([...servers.values()]),
    remove: vi.fn<CaldavBridge["remove"]>((key) => {
      servers.delete(key);
      return Promise.resolve();
    }),
    findContacts: vi.fn<CaldavBridge["findContacts"]>((key) => {
      const found = servers.get(key);
      if (!found)
        return Promise.reject(new MailServerError("notFound", "No server."));
      const updated = {
        ...found,
        ...(options.addressBooks ? { contacts: DAV_CONTACTS } : {}),
        contactsChecked: true,
      };
      servers.set(key, updated);
      return Promise.resolve(updated);
    }),
    forgetCertificate: vi.fn<CaldavBridge["forgetCertificate"]>(() =>
      Promise.resolve(),
    ),
    request: (key, request, signal) => {
      signal?.throwIfAborted();
      if (!servers.has(key))
        return Promise.reject(new MailServerError("notFound", "No server."));
      requests.push(request);
      return Promise.resolve({ ...answer(request), url: request.url });
    },
  };

  return {
    bridge,
    objects,
    requests,
    connected,
    /** Another client changes an object (or adds it). */
    edit: (calendar: string, file: string, text: string) => {
      const path = `${pathOf(calendar)}${file}`;
      objects.set(path, { text, etag: nextEtag() });
      record(path, false);
    },
    /** Another client changes (or adds) a contact. */
    editCard: (book: string, file: string, text: string) => {
      const path = `${bookPath(book)}${file}`;
      objects.set(path, { text, etag: nextEtag() });
      record(path, false);
    },
    /** Another client deletes an object. */
    remove: (calendar: string, file: string) => {
      const path = `${pathOf(calendar)}${file}`;
      objects.delete(path);
      record(path, true);
    },
    /** The text of an object by file name. */
    text: (calendar: string, file: string) =>
      objects.get(`${pathOf(calendar)}${file}`)?.text,
    /** The objects of a calendar: file name → text. */
    files: (calendar: string) =>
      Object.fromEntries(
        inCalendar(calendar).map((path) => [
          path.slice(pathOf(calendar).length),
          objects.get(path)?.text ?? "",
        ]),
      ),
  };
}

/** A simple VCALENDAR with one event (times in UTC, `YYYYMMDDTHHMMSSZ`). */
export function icsEvent(fields: {
  readonly uid: string;
  readonly start: string;
  readonly end: string;
  readonly summary: string;
  readonly extra?: readonly string[];
}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//test//EN",
    "BEGIN:VEVENT",
    `UID:${fields.uid}`,
    "DTSTAMP:20261001T000000Z",
    `DTSTART:${fields.start}`,
    `DTEND:${fields.end}`,
    `SUMMARY:${fields.summary}`,
    ...(fields.extra ?? []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
