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
 * `#/<accountId>/<mailboxId>[/<messageId>][?q=<search>[&in=all]]`, or `null`
 * for `#/` (on phones: the folder tree). With a search, `mailboxId` is the
 * mailbox it was started from.
 */
export type Route = {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly messageId?: MessageId;
  readonly search?: RouteSearch;
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
  return {
    accountId: asAccountId(account),
    mailboxId: asMailboxId(mailbox),
    ...(message ? { messageId: asMessageId(message) } : {}),
    ...(text.trim()
      ? { search: { text, everywhere: params.get("in") === "all" } }
      : {}),
  };
}

/** Formats a route as a location hash. IDs are opaque and URI-encoded. */
export function formatRoute(route: Route): string {
  if (!route) return "#/";
  const segments = [route.accountId, route.mailboxId, route.messageId].filter(
    (segment): segment is NonNullable<typeof segment> => segment !== undefined,
  );
  const path = segments.map((segment) => encodeURIComponent(segment));
  const { search } = route;
  if (!search?.text.trim()) return `#/${path.join("/")}`;
  const params = new URLSearchParams({ q: search.text });
  if (search.everywhere) params.set("in", "all");
  return `#/${path.join("/")}?${params.toString()}`;
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

/** Hash-based router. */
export interface HashRouter {
  /** Current route; the object identity only changes when the route changes. */
  readonly getRoute: () => Route;
  /** Navigates; `replace` avoids a new history entry. */
  readonly navigate: (route: Route, options?: { replace?: boolean }) => void;
  /** True if going back stays inside the app. */
  readonly canGoBack: () => boolean;
  readonly back: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

interface HistoryState {
  /** Number of in-app history entries below this one. */
  a0Depth?: number;
}

const depthOf = (state: unknown): number =>
  typeof (state as HistoryState | null)?.a0Depth === "number"
    ? ((state as HistoryState).a0Depth ?? 0)
    : 0;

/** Creates a router on `window.location.hash` and the History API. */
export function createHashRouter(win: Window = window): HashRouter {
  const emitter = new Emitter();
  let current = parseHash(win.location.hash);

  const sync = () => {
    const next = parseHash(win.location.hash);
    if (formatRoute(next) === formatRoute(current)) return;
    current = next;
    emitter.emit();
  };
  win.addEventListener("popstate", sync);
  win.addEventListener("hashchange", sync);

  return {
    getRoute: () => current,
    navigate: (route, { replace = false } = {}) => {
      const url = formatRoute(route);
      if (url === formatRoute(current)) return;
      const depth = depthOf(win.history.state);
      if (replace) win.history.replaceState({ a0Depth: depth }, "", url);
      else win.history.pushState({ a0Depth: depth + 1 }, "", url);
      sync();
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
