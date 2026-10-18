import {
  asAccountId,
  asMailboxId,
  asMessageId,
  type AccountId,
  type MailboxId,
  type MessageId,
} from "../core/ids";
import { Emitter } from "../lib/emitter";

/** A mail search, shown instead of the mailbox's messages. */
export interface RouteSearch {
  /** The search text as typed (provider syntax); never blank. */
  readonly text: string;
  /** Searches the whole account instead of the mailbox. */
  readonly everywhere: boolean;
}

/**
 * Navigation state kept in the URL hash:
 * `#/<accountId>/<mailboxId>[/<messageId>][?q=<search>[&in=all]][&compose=…]`,
 * or `null` for `#/` (on phones: the folder tree). With a search,
 * `mailboxId` is the mailbox it was started from. A `settings` flag after
 * it (see {@link formatLocation}) means Settings is open over the route.
 */
export type Route = {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly messageId?: MessageId;
  readonly search?: RouteSearch;
  /**
   * A full-screen composer is open (tablets and phones), so Back closes it:
   * `new`, or the id of its draft so a reload can reopen it. Opaque.
   */
  readonly compose?: string;
} | null;

/** Parses a location hash. Unknown or partial hashes become `null`. */
export function parseHash(hash: string): Route {
  const [path, query] = splitOnce(hash.replace(/^#\/?/, ""), "?");
  if (!path) return null;
  const segments = path.split("/").map(safeDecode);
  const [account, mailbox, message] = segments;
  if (!account || !mailbox || segments.length > 3) return null;
  const params = new URLSearchParams(query);
  const text = params.get("q") ?? "";
  const compose = params.get("compose");
  return {
    accountId: asAccountId(account),
    mailboxId: asMailboxId(mailbox),
    ...(message ? { messageId: asMessageId(message) } : {}),
    ...(text.trim()
      ? { search: { text, everywhere: params.get("in") === "all" } }
      : {}),
    ...(compose ? { compose } : {}),
  };
}

/** Formats a route as a location hash. IDs are opaque and URI-encoded. */
export function formatRoute(route: Route): string {
  if (!route) return "#/";
  const segments = [route.accountId, route.mailboxId, route.messageId].filter(
    (segment): segment is NonNullable<typeof segment> => segment !== undefined,
  );
  const path = segments.map((segment) => encodeURIComponent(segment));
  const { search, compose } = route;
  const params = new URLSearchParams();
  if (search?.text.trim()) {
    params.set("q", search.text);
    if (search.everywhere) params.set("in", "all");
  }
  if (compose) params.set("compose", compose);
  const query = params.toString();
  return `#/${path.join("/")}${query ? `?${query}` : ""}`;
}

/** True if both routes show the same list: mailbox and search (ignoring the message). */
export function sameList(a: Route, b: Route): boolean {
  return (
    a?.accountId === b?.accountId &&
    a?.mailboxId === b?.mailboxId &&
    a?.search?.text.trim() === b?.search?.text.trim() &&
    a?.search?.everywhere === b?.search?.everywhere
  );
}

/** The route of the list that `route` shows (the same route without the message). */
export function listRoute(route: NonNullable<Route>): NonNullable<Route> {
  const { messageId, ...list } = route;
  return list;
}

/** True if the hash has the `settings` flag (Settings is open over the route). */
export function hasSettingsFlag(hash: string): boolean {
  const [, query] = splitOnce(hash.replace(/^#\/?/, ""), "?");
  return new URLSearchParams(query).has("settings");
}

/** A location hash: the route, plus the `settings` flag while Settings is open. */
export function formatLocation(route: Route, settings: boolean): string {
  const hash = formatRoute(route);
  if (!settings) return hash;
  return `${hash}${hash.includes("?") ? "&" : "?"}settings`;
}

/** Hash-based router. */
export interface HashRouter {
  /** Current route; the object identity only changes when the route changes. */
  readonly getRoute: () => Route;
  /**
   * Navigates; `replace` avoids a new history entry. A new entry closes
   * Settings; replacing keeps it open.
   */
  readonly navigate: (route: Route, options?: { replace?: boolean }) => void;
  /** Settings is open (over the current route), so Back closes it. */
  readonly isSettingsOpen: () => boolean;
  /** Opens Settings as a new history entry. */
  readonly openSettings: () => void;
  /** Closes Settings: Back if it was opened here, else the flag is removed. */
  readonly closeSettings: () => void;
  /** True if going back stays inside the app. */
  readonly canGoBack: () => boolean;
  readonly back: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

interface HistoryState {
  /** Number of in-app history entries below this one. */
  a0Depth?: number;
  /** This entry was added by opening Settings. */
  a0Settings?: boolean;
}

const depthOf = (state: unknown): number =>
  typeof (state as HistoryState | null)?.a0Depth === "number"
    ? ((state as HistoryState).a0Depth ?? 0)
    : 0;

/** Creates a router on `window.location.hash` and the History API. */
export function createHashRouter(win: Window = window): HashRouter {
  const emitter = new Emitter();
  let current = parseHash(win.location.hash);
  let settings = hasSettingsFlag(win.location.hash);

  const sync = () => {
    const next = parseHash(win.location.hash);
    const nextSettings = hasSettingsFlag(win.location.hash);
    const routeChanged = formatRoute(next) !== formatRoute(current);
    if (!routeChanged && nextSettings === settings) return;
    if (routeChanged) current = next;
    settings = nextSettings;
    emitter.emit();
  };
  win.addEventListener("popstate", sync);
  win.addEventListener("hashchange", sync);

  return {
    getRoute: () => current,
    navigate: (route, { replace = false } = {}) => {
      const url = formatLocation(route, replace && settings);
      if (url === formatLocation(current, settings)) return;
      const depth = depthOf(win.history.state);
      if (replace)
        win.history.replaceState(
          { ...(win.history.state as HistoryState | null), a0Depth: depth },
          "",
          url,
        );
      else win.history.pushState({ a0Depth: depth + 1 }, "", url);
      sync();
    },
    isSettingsOpen: () => settings,
    openSettings: () => {
      if (settings) return;
      win.history.pushState(
        { a0Depth: depthOf(win.history.state) + 1, a0Settings: true },
        "",
        formatLocation(current, true),
      );
      sync();
    },
    closeSettings: () => {
      if (!settings) return;
      if ((win.history.state as HistoryState | null)?.a0Settings === true)
        win.history.back();
      else {
        win.history.replaceState(
          win.history.state,
          "",
          formatLocation(current, false),
        );
        sync();
      }
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
