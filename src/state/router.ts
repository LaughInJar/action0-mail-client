import {
  asAccountId,
  asMailboxId,
  asMessageId,
  type AccountId,
  type MailboxId,
  type MessageId,
} from "../core/ids";
import { Emitter } from "../lib/emitter";

/**
 * Navigation state kept in the URL hash:
 * `#/<accountId>/<mailboxId>[/<messageId>]`, or `null` for `#/` (on phones:
 * the folder tree).
 */
export type Route = {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly messageId?: MessageId;
} | null;

/** Parses a location hash. Unknown or partial hashes become `null`. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (!path) return null;
  const segments = path.split("/").map(safeDecode);
  const [account, mailbox, message] = segments;
  if (!account || !mailbox || segments.length > 3) return null;
  return {
    accountId: asAccountId(account),
    mailboxId: asMailboxId(mailbox),
    ...(message ? { messageId: asMessageId(message) } : {}),
  };
}

/** Formats a route as a location hash. IDs are opaque and URI-encoded. */
export function formatRoute(route: Route): string {
  if (!route) return "#/";
  const segments = [route.accountId, route.mailboxId, route.messageId].filter(
    (segment): segment is NonNullable<typeof segment> => segment !== undefined,
  );
  return `#/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** True if both routes point to the same mailbox (ignoring the message). */
export function sameList(a: Route, b: Route): boolean {
  return a?.accountId === b?.accountId && a?.mailboxId === b?.mailboxId;
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

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
