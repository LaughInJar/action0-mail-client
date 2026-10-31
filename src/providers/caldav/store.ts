import type { DavRequest, DavResponse } from "./bridge";
import {
  CALDAV,
  CARDDAV,
  DAV,
  ETAGS_PROPFIND,
  multiget,
  parseMultistatus,
  propHas,
  propText,
  sameUrl,
  syncCollection,
} from "./dav";

/** Sends a request to the calendar server (errors already mapped). */
export type DavSend = (
  request: DavRequest,
  signal?: AbortSignal,
) => Promise<DavResponse>;

/**
 * One object of a collection: a calendar object (`.ics`: a single event or
 * a series with its changes) or a contact (`.vcf`).
 */
export interface StoredObject {
  readonly url: string;
  /** Unknown right after a write whose answer had none: the next sync fetches it. */
  readonly etag?: string;
  readonly text: string;
}

/** Objects fetched per `calendar-multiget`. */
const MULTIGET_BATCH = 50;

/** A calendar is checked at most this often unless a change forces it. */
const FRESH_MS = 15_000;

const XML = { "Content-Type": "application/xml; charset=utf-8" };

/**
 * A calendar's or address book's objects, in memory only, brought up to
 * date with the server's change list (`sync-collection`, RFC 6578) or,
 * where it has none, by comparing ETags; only new and changed objects are
 * fetched.
 */
export class DavStore {
  readonly url: string;
  readonly #kind: "calendar" | "addressbook";
  readonly #send: DavSend;
  readonly #now: () => number;
  /** The server keeps a change list for this calendar. */
  #syncable: boolean;
  #token = "";
  readonly #objects = new Map<string, StoredObject>();
  #checkedAt = Number.NEGATIVE_INFINITY;
  #running: Promise<void> | undefined;

  constructor(
    url: string,
    syncable: boolean,
    send: DavSend,
    now: () => number = Date.now,
    kind: "calendar" | "addressbook" = "calendar",
  ) {
    this.url = url;
    this.#kind = kind;
    this.#syncable = syncable;
    this.#send = send;
    this.#now = now;
  }

  /** The objects as last fetched. */
  objects(): IterableIterator<StoredObject> {
    return this.#objects.values();
  }

  get(url: string): StoredObject | undefined {
    for (const [key, object] of this.#objects)
      if (sameUrl(key, url)) return object;
    return undefined;
  }

  /** Records the object as written (its new ETag, if the server said). */
  put(object: StoredObject): void {
    this.forget(object.url);
    this.#objects.set(object.url, object);
  }

  forget(url: string): void {
    for (const key of [...this.#objects.keys()])
      if (sameUrl(key, url)) this.#objects.delete(key);
  }

  /** Brings the objects up to date: shared while running, skipped if recent unless `force`. */
  sync(signal?: AbortSignal, force = false): Promise<void> {
    if (this.#running) return this.#running;
    if (!force && this.#now() - this.#checkedAt < FRESH_MS)
      return Promise.resolve();
    const running = this.#sync(signal).finally(() => {
      this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  async #sync(signal: AbortSignal | undefined): Promise<void> {
    const changed = this.#syncable
      ? await this.#changes(signal)
      : await this.#compareEtags(signal);
    await this.#fetch(changed, signal);
    this.#checkedAt = this.#now();
  }

  /** The change list since the last token: removed objects go, changed ones are returned. */
  async #changes(signal: AbortSignal | undefined): Promise<string[]> {
    const answer = await this.#send(
      {
        method: "REPORT",
        url: this.url,
        headers: XML,
        body: syncCollection(this.#token),
      },
      signal,
    );
    if (answer.status !== 207) {
      if (this.#token !== "") {
        // The token ran out (RFC 6578 valid-sync-token): start over.
        this.#token = "";
        this.#objects.clear();
        return this.#changes(signal);
      }
      // No change list after all: ETags then.
      this.#syncable = false;
      return this.#compareEtags(signal);
    }
    const { resources, syncToken } = parseMultistatus(answer.body, answer.url);
    const fresh = this.#token === "";
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const resource of resources) {
      if (sameUrl(resource.url, this.url)) continue;
      if (resource.status === 404) {
        this.forget(resource.url);
        continue;
      }
      seen.add(resource.url);
      const etag = propText(resource, DAV, "getetag");
      if (!etag || this.get(resource.url)?.etag !== etag)
        changed.push(resource.url);
    }
    if (fresh)
      for (const object of [...this.#objects.values()])
        if (![...seen].some((url) => sameUrl(url, object.url)))
          this.forget(object.url);
    if (syncToken) this.#token = syncToken;
    return changed;
  }

  /** Every object's ETag: gone ones are dropped, new and changed ones returned. */
  async #compareEtags(signal: AbortSignal | undefined): Promise<string[]> {
    const answer = await this.#send(
      {
        method: "PROPFIND",
        url: this.url,
        headers: { ...XML, Depth: "1" },
        body: ETAGS_PROPFIND,
      },
      signal,
    );
    if (answer.status !== 207) throw new Error(`HTTP ${String(answer.status)}`);
    const { resources } = parseMultistatus(answer.body, answer.url);
    const present: string[] = [];
    const changed: string[] = [];
    for (const resource of resources) {
      if (sameUrl(resource.url, this.url)) continue;
      if (propHas(resource, DAV, "resourcetype", DAV, "collection")) continue;
      present.push(resource.url);
      const etag = propText(resource, DAV, "getetag");
      if (!etag || this.get(resource.url)?.etag !== etag)
        changed.push(resource.url);
    }
    for (const object of [...this.#objects.values()])
      if (!present.some((url) => sameUrl(url, object.url)))
        this.forget(object.url);
    return changed;
  }

  /** Fetches objects by URL (`calendar-multiget`, in batches). */
  async #fetch(
    urls: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (let start = 0; start < urls.length; start += MULTIGET_BATCH) {
      const batch = urls.slice(start, start + MULTIGET_BATCH);
      const answer = await this.#send(
        {
          method: "REPORT",
          url: this.url,
          headers: { ...XML, Depth: "1" },
          body: multiget(
            batch.map((url) => new URL(url).pathname),
            this.#kind,
          ),
        },
        signal,
      );
      if (answer.status !== 207)
        throw new Error(`HTTP ${String(answer.status)}`);
      for (const resource of parseMultistatus(answer.body, answer.url)
        .resources) {
        const text =
          this.#kind === "calendar"
            ? propText(resource, CALDAV, "calendar-data")
            : propText(resource, CARDDAV, "address-data");
        if (resource.status === 404 || !text) {
          this.forget(resource.url);
          continue;
        }
        const etag = propText(resource, DAV, "getetag");
        this.put({ url: resource.url, text, ...(etag ? { etag } : {}) });
      }
    }
  }
}
