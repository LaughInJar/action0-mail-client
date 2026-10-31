/**
 * Address books on a CardDAV server (RFC 6352): the vCards (3.0 and 4.0,
 * read with ical.js) of every address book of a login, kept in memory and
 * brought up to date like calendars. Searched locally for address
 * suggestions; the contacts view reads and writes them through
 * `CardDavContactsProvider`.
 */
import { fold, words } from "../../core/contacts";
import { MailError } from "../../core/errors";
import type { EmailAddress } from "../../core/model";
import { loadIcal, type Ical, type IcalComponent } from "../ical/icalendar";
import { toMailError } from "../imap/mappers";
import type { CaldavBridge, DavRequest, DavResponse } from "./bridge";
import {
  ADDRESSBOOKS_PROPFIND,
  CARDDAV,
  DAV,
  parseMultistatus,
  propHas,
  propText,
  sameUrl,
  writable,
} from "./dav";
import type { CalendarServerList } from "./servers";
import { DavStore } from "./store";

/** One address of a contact, ready to be searched. */
export interface ContactEntry {
  readonly address: EmailAddress;
  /** Folded words of the name, nickname and organization. */
  readonly nameWords: readonly string[];
  /** Folded parts of the address (`anna`, `berger`, `example`, …). */
  readonly addressWords: readonly string[];
  /** The contact marks it as its preferred address. */
  readonly preferred: boolean;
}

/** A match with how good it is (higher is better). */
export interface ContactMatch {
  readonly address: EmailAddress;
  readonly score: number;
}

/** The contacts' addresses in a vCard file (one or several cards). */
export function readContacts(ICAL: Ical, text: string): ContactEntry[] {
  let cards: IcalComponent[];
  try {
    const parsed = ICAL.parse(text) as unknown[];
    // One card parses to a component, several to a list of them.
    const list = (
      Array.isArray(parsed[0]) ? parsed : [parsed]
    ) as ConstructorParameters<Ical["Component"]>[0][];
    cards = list.map((jcal) => new ICAL.Component(jcal));
  } catch {
    return [];
  }
  return cards.flatMap((card) => {
    if (card.name !== "vcard") return [];
    const name = nameOf(card);
    const nickname = textValue(card.getFirstPropertyValue("nickname"));
    const org = textValue(card.getFirstPropertyValue("org"));
    const nameWords = words([name, nickname, org].filter(Boolean).join(" "));
    return card
      .getAllProperties("email")
      .flatMap((property): ContactEntry[] => {
        const address = textValue(property.getFirstValue()).trim();
        if (!address.includes("@")) return [];
        const types = property.getParameter("type");
        // Absent parameters are undefined at run time, whatever the types say.
        const pref: unknown = property.getParameter("pref");
        const preferred =
          pref !== undefined ||
          (Array.isArray(types) ? types : [types]).some(
            (type) => typeof type === "string" && type.toLowerCase() === "pref",
          );
        return [
          {
            address: name ? { name, address } : { address },
            nameWords,
            addressWords: words(address),
            preferred,
          },
        ];
      });
  });
}

/** FN, else the parts of N ("Anna Berger"). */
function nameOf(card: IcalComponent): string {
  const formatted = textValue(card.getFirstPropertyValue("fn")).trim();
  if (formatted) return formatted;
  const parts = card.getFirstPropertyValue("n") as unknown;
  if (!Array.isArray(parts)) return "";
  const [family = "", given = ""] = parts.map((part) => textValue(part));
  return [given, family].filter(Boolean).join(" ").trim();
}

/** A property value as text (structured ones joined: ORG's company and unit). */
function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) => textValue(part))
      .filter(Boolean)
      .join(" ");
  return "";
}

/**
 * How well an entry matches the query: every word of the query must
 * start a word of the name or the address. The whole name starting with
 * it counts most, then a name word, then only the address; a preferred
 * address a little more. 0: no match.
 */
export function scoreOf(entry: ContactEntry, query: string): number {
  const needles = words(query);
  if (needles.length === 0) return 0;
  const all = [...entry.nameWords, ...entry.addressWords];
  if (!needles.every((needle) => all.some((word) => word.startsWith(needle))))
    return 0;
  const name = fold(entry.address.name ?? "");
  const folded = fold(query.trim());
  const base = name.startsWith(folded)
    ? 3
    : needles.some((needle) =>
          entry.nameWords.some((word) => word.startsWith(needle)),
        )
      ? 2
      : 1;
  return base + (entry.preferred ? 0.5 : 0);
}

/** An address book of the server, as found under the home. */
export interface AddressBookEntry {
  /** Its URL, ending in "/". */
  readonly url: string;
  /** Its display name, else the last part of its path. */
  readonly name: string;
  /** The login may only read it (`current-user-privilege-set`). */
  readonly readOnly: boolean;
  readonly store: DavStore;
}

/**
 * The address books of one login (a calendar server's, see
 * {@link CalendarServerList}), for suggestions and the contacts view.
 * Servers set up before contacts were looked for are checked once
 * (`findContacts`). Each book's objects are kept in memory (its
 * {@link DavStore}) for the run.
 */
export class CardDavAddressBooks {
  readonly key: string;
  readonly #bridge: CaldavBridge;
  readonly #servers: CalendarServerList;
  readonly #now: () => number;
  /** Stores by book URL, kept across listings so their sync state stays. */
  readonly #stores = new Map<string, DavStore>();
  #listed: Promise<AddressBookEntry[]> | undefined;
  #current: readonly AddressBookEntry[] = [];
  /** Read contacts by object URL, with the ETag they were read at. */
  readonly #read = new Map<
    string,
    { readonly etag: string | undefined; readonly entries: ContactEntry[] }
  >();

  constructor(options: {
    readonly bridge: CaldavBridge;
    readonly key: string;
    readonly servers: CalendarServerList;
    readonly now?: () => number;
  }) {
    this.#bridge = options.bridge;
    this.key = options.key;
    this.#servers = options.servers;
    this.#now = options.now ?? Date.now;
  }

  /** The login's address book home, looked for first if it never was. */
  async home(): Promise<string | undefined> {
    await this.#servers.ready;
    let info = this.#servers.info(this.key);
    if (info && !info.contactsChecked)
      info = await this.#servers.findContacts(this.key);
    return info?.contacts;
  }

  /** The address books as last listed (none before the first listing). */
  current(): readonly AddressBookEntry[] {
    return this.#current;
  }

  /**
   * The address books under the home: listed once, or again with
   * `refresh` (books added on the server meanwhile then show up).
   */
  books(
    signal?: AbortSignal,
    refresh = false,
  ): Promise<readonly AddressBookEntry[]> {
    if (refresh || !this.#listed) {
      const listing = this.#list(signal);
      this.#listed = listing;
      listing.catch(() => {
        if (this.#listed === listing) this.#listed = undefined;
      });
    }
    return this.#listed;
  }

  /** Every contact address matching `query`, best first. */
  async search(query: string, signal?: AbortSignal): Promise<ContactMatch[]> {
    const books = await this.books(signal);
    const ICAL = await loadIcal();
    const matches = new Map<string, ContactMatch>();
    for (const book of books) {
      await book.store.sync(signal);
      for (const object of book.store.objects()) {
        let read = this.#read.get(object.url);
        if (!read || read.etag !== object.etag || read.etag === undefined) {
          read = {
            etag: object.etag,
            entries: readContacts(ICAL, object.text),
          };
          this.#read.set(object.url, read);
        }
        for (const entry of read.entries) {
          const score = scoreOf(entry, query);
          if (score === 0) continue;
          const key = entry.address.address.toLowerCase();
          const known = matches.get(key);
          if (!known || known.score < score)
            matches.set(key, { address: entry.address, score });
        }
      }
    }
    return [...matches.values()].sort(
      (a, b) =>
        b.score - a.score ||
        (a.address.name ?? a.address.address).localeCompare(
          b.address.name ?? b.address.address,
        ),
    );
  }

  /**
   * A request with this login. The native side's failures become
   * `MailError`s, and a refused login is `auth-required`.
   */
  async send(request: DavRequest, signal?: AbortSignal): Promise<DavResponse> {
    const service = hostOf(request.url);
    let answer: DavResponse;
    try {
      answer = await this.#bridge.request(this.key, request, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw toMailError(error, { service });
    }
    if (answer.status === 401)
      throw new MailError(
        "auth-required",
        "The contacts server refused the login.",
        { status: 401, reason: "contactsLoginRefused", params: { service } },
      );
    return answer;
  }

  async #list(signal: AbortSignal | undefined): Promise<AddressBookEntry[]> {
    const home = await this.home();
    if (!home) {
      this.#current = [];
      return [];
    }
    const answer = await this.send(
      {
        method: "PROPFIND",
        url: home,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: "1",
        },
        body: ADDRESSBOOKS_PROPFIND,
      },
      signal,
    );
    if (answer.status !== 207)
      throw new MailError(
        "provider",
        `The contacts server answered ${String(answer.status)}.`,
        { status: answer.status },
      );
    const books = parseMultistatus(answer.body, answer.url)
      .resources.filter((resource) => !sameUrl(resource.url, home))
      .filter((resource) =>
        propHas(resource, DAV, "resourcetype", CARDDAV, "addressbook"),
      )
      .map((resource): AddressBookEntry => {
        const url = resource.url.endsWith("/")
          ? resource.url
          : `${resource.url}/`;
        let store = this.#stores.get(url);
        if (!store) {
          store = new DavStore(
            url,
            propText(resource, DAV, "sync-token") !== undefined,
            (request, inner) => this.send(request, inner),
            this.#now,
            "addressbook",
          );
          this.#stores.set(url, store);
        }
        return {
          url,
          name: propText(resource, DAV, "displayname") ?? lastSegment(url),
          readOnly: !writable(resource),
          store,
        };
      });
    this.#current = books;
    return books;
  }
}

/** "contacts" for ".../addressbooks/me/contacts/". */
function lastSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts.at(-1) ?? url);
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Matches of several address books as one list: an address found in
 * more than one counts with its best score.
 */
export function mergeMatches(
  lists: readonly (readonly ContactMatch[])[],
): EmailAddress[] {
  const best = new Map<string, ContactMatch>();
  for (const list of lists)
    for (const match of list) {
      const key = match.address.address.toLowerCase();
      const known = best.get(key);
      if (!known || known.score < match.score) best.set(key, match);
    }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .map((match) => match.address);
}
