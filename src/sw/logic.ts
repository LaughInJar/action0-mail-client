/**
 * The parts of the service worker that need none of its globals, so they
 * can be tested: what it does with a request, its cache's name, what a
 * share brought, and the messages it and the page exchange.
 */

/** Prefix of the caches of the app's own files (one per version). */
export const CACHE_PREFIX = "a0-shell-";

/** The cache of one version's files. */
export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** Where Android's "Share → action0" posts to (the manifest's `share_target`). */
export const SHARE_PATH = "/share-target";

/**
 * What the worker does with a request:
 * - `cached`: one of the app's own files, from the cache (the network if missing);
 * - `page`: the app's page, from the network, the cached copy when offline;
 * - `share`: content shared to the app;
 * - `network`: anything else, untouched (APIs, sign-in, other sites).
 */
export type Handling = "cached" | "page" | "share" | "network";

export function handlingOf(
  request: {
    readonly method: string;
    readonly url: string;
    readonly mode: string;
  },
  origin: string,
  files: ReadonlySet<string>,
): Handling {
  const url = new URL(request.url);
  if (url.origin !== origin) return "network";
  if (request.method === "POST" && url.pathname === SHARE_PATH) return "share";
  if (request.method !== "GET") return "network";
  if (
    request.mode === "navigate" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  )
    return "page";
  // A navigation elsewhere (redirect.html) always goes to the network.
  if (request.mode === "navigate") return "network";
  return files.has(url.pathname) ? "cached" : "network";
}

/** Content another app shared (the share target's form). */
export interface SharedForm {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  readonly files: readonly File[];
}

/** Reads the share target's form: title, text, link and files. */
export function readShare(form: FormData): SharedForm {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const title = text("title");
  const body = text("text");
  const url = text("url");
  return {
    ...(title ? { title } : {}),
    ...(body ? { text: body } : {}),
    ...(url ? { url } : {}),
    files: form
      .getAll("files")
      .filter((value): value is File => typeof value !== "string")
      .filter((file) => file.size > 0 || file.name !== ""),
  };
}

/** Messages between the page and the worker. */
export type WorkerMessage =
  /** Page → worker: the new version takes over now. */
  | { readonly type: "skip-waiting" }
  /** Page → worker: the shared content with this id (answered on the port, once). */
  | { readonly type: "share"; readonly id: string }
  /** Worker → page: a notification was clicked. */
  | { readonly type: "notification-click"; readonly tag: string };

/** True if `data` is a {@link WorkerMessage} of this type. */
export function isMessage<T extends WorkerMessage["type"]>(
  data: unknown,
  type: T,
): data is Extract<WorkerMessage, { type: T }> {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === type
  );
}
