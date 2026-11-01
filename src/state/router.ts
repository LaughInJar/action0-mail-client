import {
  asAccountId,
  asMailboxId,
  asMessageId,
  type AccountId,
  type MailboxId,
  type MessageId,
  type MessageRef,
} from "../core/ids";
import { Emitter } from "../lib/emitter";

/** A mail search, shown instead of the mailbox's messages. */
export interface RouteSearch {
  /** The search text as typed (provider syntax); never blank. */
  readonly text: string;
  /** Searches the whole account instead of the mailbox. */
  readonly everywhere: boolean;
}

/** A combined view other than All inboxes: every account's starred mail, sent mail or drafts. */
export type CombinedView = "flagged" | "sent" | "drafts";

/** The combined views besides All inboxes, as they appear in the URL. */
export const COMBINED_VIEWS: readonly CombinedView[] = [
  "flagged",
  "sent",
  "drafts",
];

/**
 * Navigation state kept in the URL hash:
 * `#/<accountId>/<mailboxId>[/<messageId>][?q=<search>[&in=all]][&compose=…]`,
 * or `#/all/…` for All inboxes (`#/all/<view>/…` for the other combined
 * views), or `null` for `#/` (on phones: the folder tree). With a search, `mailboxId` is the mailbox it was started from.
 * Something open over the route (Settings, a message's original) is an
 * {@link Overlay}, added after it (see {@link formatLocation}).
 */
export type Route = {
  /**
   * The account in context. In All inboxes: the account of the open (or
   * last opened) message, so the reader, replies and `g i` follow it.
   */
  readonly accountId: AccountId;
  /** The mailbox listed; in All inboxes the context account's Inbox. */
  readonly mailboxId: MailboxId;
  readonly messageId?: MessageId;
  /**
   * All inboxes: the list is every account's Inbox merged, and
   * `accountId`/`mailboxId` only say whose message is open.
   */
  readonly unified?: true;
  /**
   * With `unified`: the combined view other than All inboxes, and
   * `accountId`/`mailboxId` name the context account's mailbox of that kind.
   */
  readonly combined?: CombinedView;
  readonly search?: RouteSearch;
  /**
   * A full-screen composer is open (tablets and phones), so Back closes it:
   * `new`, or the id of its draft so a reload can reopen it. Opaque.
   */
  readonly compose?: string;
  /** The account of the draft in `compose` (a reload resumes it there). */
  readonly composeAccount?: AccountId;
} | null;

/** The first path segment of All inboxes (account ids always contain ":"). */
const UNIFIED = "all";

/** The calendar's views. */
export type CalendarView = "day" | "week" | "month" | "agenda";

const CALENDAR_VIEWS: readonly string[] = ["day", "week", "month", "agenda"];

/**
 * The calendar in the URL: `#/calendar/<view>/<YYYY-MM-DD>` plus
 * `/<event>` (open), `/<event>/edit` (being edited) or `/new[/<from>/<to>]`
 * (a new event), where `event` is opaque (it names the event).
 */
export interface CalendarRoute {
  readonly view: CalendarView;
  /** The date the view shows (local), "YYYY-MM-DD". */
  readonly date: string;
  readonly event?: string;
  /** The open event is being edited. */
  readonly edit?: true;
  /** A new event: its suggested time, local "YYYY-MM-DDTHH:MM" (or days, "YYYY-MM-DD", for all-day ones; `to` exclusive). */
  readonly create?: { readonly from?: string; readonly to?: string };
}

const DAY_OR_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

/** Parses a calendar location hash; `null` for any other hash. */
export function parseCalendarHash(hash: string): CalendarRoute | null {
  const [path] = splitOnce(hash.replace(/^#\/?/, ""), "?");
  const [prefix, view, date, ...more] = path.split("/").map(safeDecode);
  if (prefix !== "calendar") return null;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "");
  const base = {
    view: CALENDAR_VIEWS.includes(view ?? "") ? (view as CalendarView) : "week",
    date: valid && date ? date : today(),
  } as const;
  const [first, from, to, ...rest] = more;
  if (rest.length > 0) return null;
  if (first === "new") {
    const times =
      from !== undefined &&
      to !== undefined &&
      DAY_OR_TIME.test(from) &&
      DAY_OR_TIME.test(to);
    return { ...base, create: times ? { from, to } : {} };
  }
  if (!first) return base;
  if (from === undefined) return { ...base, event: first };
  return from === "edit" && to === undefined
    ? { ...base, event: first, edit: true }
    : null;
}

/** Formats a calendar route as a location hash. */
export function formatCalendarRoute(route: CalendarRoute): string {
  const { create, event } = route;
  const segments = [
    route.view,
    route.date,
    ...(create
      ? [
          "new",
          ...(create.from !== undefined && create.to !== undefined
            ? [create.from, create.to]
            : []),
        ]
      : event !== undefined
        ? [event, ...(route.edit ? ["edit"] : [])]
        : []),
  ];
  return `#/calendar/${segments.map(encodeURIComponent).join("/")}`;
}

/** Today as a local "YYYY-MM-DD". */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The contacts in the URL: `#/contacts/<list>` plus `/<contact>` (open),
 * `/<contact>/edit` (being edited), `/new` (a new contact) or
 * `/duplicates` (finding duplicates), and `?q=<search>`. `list` is `all`
 * or names a source's address book or group, `contact` a contact; both
 * are opaque (the data layer makes them).
 */
export interface ContactsRoute {
  readonly list: string;
  readonly contact?: string;
  /** The open contact is being edited. */
  readonly edit?: true;
  /** A new contact, maybe started from mail with a name and an address. */
  readonly create?: { readonly name?: string; readonly address?: string };
  /** "Find duplicates" is open for the list's account. */
  readonly duplicates?: true;
  /** The import preview is open (the file itself is in memory only). */
  readonly importing?: true;
  /** Filters the list; never blank. */
  readonly search?: string;
}

/** The list of every source's contacts. */
export const ALL_CONTACTS = "all";

/** Parses a contacts location hash; `null` for any other hash. */
export function parseContactsHash(hash: string): ContactsRoute | null {
  const [path, query] = splitOnce(hash.replace(/^#\/?/, ""), "?");
  const [prefix, list, first, second, ...rest] = path
    .split("/")
    .map(safeDecode);
  if (prefix !== "contacts" || rest.length > 0) return null;
  const params = new URLSearchParams(query);
  const search = params.get("q") ?? "";
  const base = {
    list: list || ALL_CONTACTS,
    ...(search.trim() ? { search } : {}),
    ...(params.has("import") ? { importing: true as const } : {}),
  };
  if (!first) return second === undefined ? base : null;
  if (first === "new" && second === undefined) {
    const name = params.get("name");
    const address = params.get("address");
    return {
      ...base,
      create: {
        ...(name ? { name } : {}),
        ...(address ? { address } : {}),
      },
    };
  }
  if (first === "duplicates" && second === undefined)
    return { ...base, duplicates: true };
  if (second === undefined) return { ...base, contact: first };
  return second === "edit" ? { ...base, contact: first, edit: true } : null;
}

/** Formats a contacts route as a location hash. */
export function formatContactsRoute(route: ContactsRoute): string {
  const segments = [
    route.list,
    ...(route.create
      ? ["new"]
      : route.duplicates
        ? ["duplicates"]
        : route.contact !== undefined
          ? [route.contact, ...(route.edit ? ["edit"] : [])]
          : []),
  ];
  const params = new URLSearchParams();
  if (route.search?.trim()) params.set("q", route.search);
  if (route.create?.name) params.set("name", route.create.name);
  if (route.create?.address) params.set("address", route.create.address);
  const query = params.toString();
  const flags = [
    ...(query ? [query] : []),
    ...(route.importing ? ["import"] : []),
  ];
  return `#/contacts/${segments.map(encodeURIComponent).join("/")}${
    flags.length > 0 ? `?${flags.join("&")}` : ""
  }`;
}

/** Parses a location hash. Unknown or partial hashes become `null`. */
export function parseHash(hash: string): Route {
  if (parseCalendarHash(hash) || parseContactsHash(hash)) return null;
  const [path, query] = splitOnce(hash.replace(/^#\/?/, ""), "?");
  if (!path) return null;
  const all = path.split("/").map(safeDecode);
  const unified = all[0] === UNIFIED;
  // Account ids always contain ":", so a view's name can't be one.
  const view = unified
    ? COMBINED_VIEWS.find((name) => name === all[1])
    : undefined;
  const segments = unified ? all.slice(view ? 2 : 1) : all;
  const [account, mailbox, message] = segments;
  if (!account || !mailbox || segments.length > 3) return null;
  const params = new URLSearchParams(query);
  const text = params.get("q") ?? "";
  const compose = params.get("compose");
  const composeAccount = params.get("ca");
  return {
    accountId: asAccountId(account),
    mailboxId: asMailboxId(mailbox),
    ...(message ? { messageId: asMessageId(message) } : {}),
    ...(unified ? { unified: true } : {}),
    ...(view ? { combined: view } : {}),
    ...(text.trim()
      ? { search: { text, everywhere: params.get("in") === "all" } }
      : {}),
    ...(compose ? { compose } : {}),
    ...(compose && composeAccount
      ? { composeAccount: asAccountId(composeAccount) }
      : {}),
  };
}

/** Formats a route as a location hash. IDs are opaque and URI-encoded. */
export function formatRoute(route: Route): string {
  if (!route) return "#/";
  const segments = [route.accountId, route.mailboxId, route.messageId].filter(
    (segment): segment is NonNullable<typeof segment> => segment !== undefined,
  );
  const path = [
    ...(route.unified
      ? [UNIFIED, ...(route.combined ? [route.combined] : [])]
      : []),
    ...segments.map((segment) => encodeURIComponent(segment)),
  ];
  const { search, compose, composeAccount } = route;
  const params = new URLSearchParams();
  if (search?.text.trim()) {
    params.set("q", search.text);
    if (search.everywhere) params.set("in", "all");
  }
  if (compose) {
    params.set("compose", compose);
    if (composeAccount) params.set("ca", composeAccount);
  }
  const query = params.toString();
  return `#/${path.join("/")}${query ? `?${query}` : ""}`;
}

/**
 * True if both routes show the same list: mailbox and search (ignoring the
 * message). A combined view is one list, whichever account is in context.
 */
export function sameList(a: Route, b: Route): boolean {
  const unified = a?.unified === true;
  return (
    unified === (b?.unified === true) &&
    a?.combined === b?.combined &&
    (unified ||
      (a?.accountId === b?.accountId && a?.mailboxId === b?.mailboxId)) &&
    a?.search?.text.trim() === b?.search?.text.trim() &&
    a?.search?.everywhere === b?.search?.everywhere
  );
}

/** The route of the list that `route` shows (the same route without the message). */
export function listRoute(route: NonNullable<Route>): NonNullable<Route> {
  const { messageId, ...list } = route;
  return list;
}

/** An editor open over Settings (its own screen on phones). */
export type SettingsEditor = "filter" | "auto-reply";

const SETTINGS_EDITORS: readonly string[] = [
  "filter",
  "auto-reply",
] satisfies SettingsEditor[];

/**
 * What's open over the route (mail or calendar), in the URL so Back closes
 * it: Settings (`?settings`, or `?settings=<editor>` with an editor open
 * over it), or the original of a message
 * (`?original=<messageId>&oa=<accountId>`; any account, since a row of
 * All inboxes may be another account's).
 */
export type Overlay =
  | { readonly kind: "settings"; readonly editor?: SettingsEditor }
  | { readonly kind: "original"; readonly message: MessageRef };

/** The overlay a location hash names, if any. */
export function overlayOf(hash: string): Overlay | null {
  const [, query] = splitOnce(hash.replace(/^#\/?/, ""), "?");
  const params = new URLSearchParams(query);
  const settings = params.get("settings");
  if (settings !== null)
    return SETTINGS_EDITORS.includes(settings)
      ? { kind: "settings", editor: settings as SettingsEditor }
      : { kind: "settings" };
  const messageId = params.get("original");
  const accountId = params.get("oa");
  return messageId && accountId
    ? {
        kind: "original",
        message: {
          accountId: asAccountId(accountId),
          messageId: asMessageId(messageId),
        },
      }
    : null;
}

/** A location hash: the route, plus the overlay open over it. */
export function formatLocation(route: Route, overlay: Overlay | null): string {
  return withOverlay(formatRoute(route), overlay);
}

/** A hash with `overlay` added to its query. */
function withOverlay(hash: string, overlay: Overlay | null): string {
  if (!overlay) return hash;
  const flag =
    overlay.kind === "settings"
      ? overlay.editor
        ? `settings=${overlay.editor}`
        : "settings"
      : new URLSearchParams({
          original: overlay.message.messageId,
          oa: overlay.message.accountId,
        }).toString();
  return `${hash}${hash.includes("?") ? "&" : "?"}${flag}`;
}

function sameOverlay(a: Overlay | null, b: Overlay | null): boolean {
  return withOverlay("", a) === withOverlay("", b);
}

/** The three parts of the app. */
export type AppPart = "mail" | "calendar" | "contacts";

/** Hash-based router. */
export interface HashRouter {
  /**
   * Current mail route; the object identity only changes when the route
   * changes. `null` while the calendar or the contacts are open.
   */
  readonly getRoute: () => Route;
  /** Which part of the app is open. */
  readonly part: () => AppPart;
  /** The last mail route (what the Mail switch goes back to), if any. */
  readonly getLastMailRoute: () => Route;
  /** The calendar, while it's open; otherwise `null`. Identity like {@link getRoute}. */
  readonly getCalendarRoute: () => CalendarRoute | null;
  /** Opens the calendar (a new history entry unless `replace`). */
  readonly openCalendar: (
    route: CalendarRoute,
    options?: { replace?: boolean },
  ) => void;
  /** The contacts, while they're open; otherwise `null`. Identity like {@link getRoute}. */
  readonly getContactsRoute: () => ContactsRoute | null;
  /** The last contacts route (what the Contacts switch goes back to), if any. */
  readonly getLastContactsRoute: () => ContactsRoute | null;
  /** Opens the contacts (a new history entry unless `replace`). */
  readonly openContacts: (
    route: ContactsRoute,
    options?: { replace?: boolean },
  ) => void;
  /**
   * Navigates; `replace` avoids a new history entry. A new entry closes
   * the overlay (Settings, an original); replacing keeps it open.
   */
  readonly navigate: (route: Route, options?: { replace?: boolean }) => void;
  /** Settings is open (over the current route), so Back closes it. */
  readonly isSettingsOpen: () => boolean;
  /** Opens Settings as a new history entry. */
  readonly openSettings: () => void;
  /** Closes Settings: Back if it was opened here, else the flag is removed. */
  readonly closeSettings: () => void;
  /** The editor open over Settings, if any. */
  readonly getSettingsEditor: () => SettingsEditor | null;
  /** Opens an editor over Settings as a new history entry, so Back closes it. */
  readonly openSettingsEditor: (editor: SettingsEditor) => void;
  /** Closes the editor over Settings (Back if it was opened here); Settings stays. */
  readonly closeSettingsEditor: () => void;
  /**
   * The message whose original is shown over the route, if any. The
   * identity only changes when it does.
   */
  readonly getOriginal: () => MessageRef | null;
  /** Shows a message's original (headers and source) as a new history entry. */
  readonly openOriginal: (message: MessageRef) => void;
  /** Closes the original: Back if it was opened here, else it's removed from the URL. */
  readonly closeOriginal: () => void;
  /** True if going back stays inside the app. */
  readonly canGoBack: () => boolean;
  readonly back: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

interface HistoryState {
  /** Number of in-app history entries below this one. */
  a0Depth?: number;
  /** This entry was added by opening an overlay (Settings, an original). */
  a0Overlay?: boolean;
}

const depthOf = (state: unknown): number =>
  typeof (state as HistoryState | null)?.a0Depth === "number"
    ? ((state as HistoryState).a0Depth ?? 0)
    : 0;

/** Creates a router on `window.location.hash` and the History API. */
export function createHashRouter(win: Window = window): HashRouter {
  const emitter = new Emitter();
  let current = parseHash(win.location.hash);
  let lastMail = current;
  let calendar = parseCalendarHash(win.location.hash);
  let contacts = parseContactsHash(win.location.hash);
  let lastContacts = contacts;
  let overlay = overlayOf(win.location.hash);

  /** The location of the current mail route, calendar or contacts, with `over` open. */
  const here = (over: Overlay | null) =>
    calendar
      ? withOverlay(formatCalendarRoute(calendar), over)
      : contacts
        ? withOverlay(formatContactsRoute(contacts), over)
        : formatLocation(current, over);

  const sync = () => {
    const next = parseHash(win.location.hash);
    const nextCalendar = parseCalendarHash(win.location.hash);
    const nextContacts = parseContactsHash(win.location.hash);
    const nextOverlay = overlayOf(win.location.hash);
    const routeChanged = formatRoute(next) !== formatRoute(current);
    const calendarChanged =
      (nextCalendar && formatCalendarRoute(nextCalendar)) !==
      (calendar && formatCalendarRoute(calendar));
    const contactsChanged =
      (nextContacts && formatContactsRoute(nextContacts)) !==
      (contacts && formatContactsRoute(contacts));
    const overlayChanged = !sameOverlay(nextOverlay, overlay);
    if (
      !routeChanged &&
      !calendarChanged &&
      !contactsChanged &&
      !overlayChanged
    )
      return;
    if (routeChanged) current = next;
    if (current !== null) lastMail = current;
    if (calendarChanged) calendar = nextCalendar;
    if (contactsChanged) contacts = nextContacts;
    if (contacts !== null) lastContacts = contacts;
    if (overlayChanged) overlay = nextOverlay;
    emitter.emit();
  };

  const go = (url: string, replace: boolean) => {
    if (url === here(overlay)) return;
    const depth = depthOf(win.history.state);
    if (replace)
      win.history.replaceState(
        { ...(win.history.state as HistoryState | null), a0Depth: depth },
        "",
        url,
      );
    else win.history.pushState({ a0Depth: depth + 1 }, "", url);
    sync();
  };
  win.addEventListener("popstate", sync);
  win.addEventListener("hashchange", sync);

  const open = (next: Overlay) => {
    if (sameOverlay(overlay, next)) return;
    win.history.pushState(
      { a0Depth: depthOf(win.history.state) + 1, a0Overlay: true },
      "",
      here(next),
    );
    sync();
  };
  const close = (kind: Overlay["kind"]) => {
    if (overlay?.kind !== kind) return;
    if ((win.history.state as HistoryState | null)?.a0Overlay === true)
      win.history.back();
    else {
      win.history.replaceState(win.history.state, "", here(null));
      sync();
    }
  };

  return {
    getRoute: () => current,
    part: () => (calendar ? "calendar" : contacts ? "contacts" : "mail"),
    getCalendarRoute: () => calendar,
    getContactsRoute: () => contacts,
    getLastContactsRoute: () => lastContacts,
    getLastMailRoute: () => lastMail,
    navigate: (route, { replace = false } = {}) => {
      go(formatLocation(route, replace ? overlay : null), replace);
    },
    openCalendar: (route, { replace = false } = {}) => {
      go(
        withOverlay(formatCalendarRoute(route), replace ? overlay : null),
        replace,
      );
    },
    openContacts: (route, { replace = false } = {}) => {
      go(
        withOverlay(formatContactsRoute(route), replace ? overlay : null),
        replace,
      );
    },
    isSettingsOpen: () => overlay?.kind === "settings",
    openSettings: () => {
      open({ kind: "settings" });
    },
    closeSettings: () => {
      close("settings");
    },
    getSettingsEditor: () =>
      overlay?.kind === "settings" ? (overlay.editor ?? null) : null,
    openSettingsEditor: (editor) => {
      open({ kind: "settings", editor });
    },
    closeSettingsEditor: () => {
      if (overlay?.kind !== "settings" || !overlay.editor) return;
      if ((win.history.state as HistoryState | null)?.a0Overlay === true)
        win.history.back();
      else {
        win.history.replaceState(
          win.history.state,
          "",
          here({ kind: "settings" }),
        );
        sync();
      }
    },
    getOriginal: () => (overlay?.kind === "original" ? overlay.message : null),
    openOriginal: (message) => {
      open({ kind: "original", message });
    },
    closeOriginal: () => {
      close("original");
    },
    canGoBack: () => depthOf(win.history.state) > 0,
    back: () => {
      win.history.back();
    },
    subscribe: emitter.subscribe,
    dispose: () => {
      win.removeEventListener("popstate", sync);
      win.removeEventListener("hashchange", sync);
    },
  };
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  return index === -1
    ? [text, ""]
    : [text.slice(0, index), text.slice(index + 1)];
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
