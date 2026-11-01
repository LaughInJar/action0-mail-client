import {
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { useAccounts } from "../accounts/context";
import type { AuthSession } from "../auth/types";
import {
  letterOf,
  matchesSearch,
  nameOf,
  type AddressBook,
  type AddressBookId,
  type Contact,
  type ContactGroupId,
  type ContactId,
  type ContactsAccess,
  type ContactSnapshot,
  type ContactsProvider,
} from "../core/contacts";
import type { AccountId } from "../core/ids";
import { useCalendarServerList, useCalendarServers } from "./calendarServers";
import { queryKeys } from "./keys";

/**
 * Where contacts come from: an account (Google, Outlook, a mail server's
 * CardDAV address books), or a calendar-only CardDAV server.
 */
export interface ContactSource {
  /** The account id, or the calendar-only server's key. */
  readonly key: string;
  readonly kind: "account" | "server";
  /** The account's address, or the server's name. */
  readonly label: string;
  readonly provider: ContactsProvider;
  readonly accountId?: AccountId;
  readonly auth?: AuthSession;
}

/** How often the contacts are checked for changes while shown. */
export const CONTACTS_REFRESH_MS = 5 * 60_000;

/**
 * Contact sources: every account with contacts, then calendar-only
 * servers with address books.
 */
export function useContactSources(): readonly ContactSource[] {
  const accounts = useAccounts();
  const serverSources = useCalendarServers();
  const servers = useCalendarServerList();
  return useMemo(
    () => [
      ...accounts.flatMap((handle): ContactSource[] =>
        handle.contacts
          ? [
              {
                key: handle.account.id,
                kind: "account",
                label: handle.account.email,
                provider: handle.contacts,
                accountId: handle.account.id,
                auth: handle.auth,
              },
            ]
          : [],
      ),
      ...(serverSources?.contactsFor
        ? servers.flatMap((info): ContactSource[] => {
            const provider = info.key.startsWith("caldav:")
              ? serverSources.contactsFor?.(info)
              : undefined;
            return provider
              ? [
                  {
                    key: info.key,
                    kind: "server",
                    label: info.label,
                    provider,
                  },
                ]
              : [];
          })
        : []),
    ],
    [accounts, serverSources, servers],
  );
}

/** A source's sign-in and access, as loaded. */
export interface ContactSourceState {
  readonly source: ContactSource;
  readonly signedIn: boolean;
  readonly access: ContactsAccess;
  readonly snapshot: ContactSnapshot | undefined;
  /** Why it didn't load. */
  readonly error: unknown;
  readonly pending: boolean;
}

/** Whether a source can load: signed in, and allowed to read. */
const canLoad = (signedIn: boolean, access: ContactsAccess) =>
  signedIn && access !== "missing";

/** All sources' sign-in and access, kept current. */
function useAccessStates(
  sources: readonly ContactSource[],
): readonly { signedIn: boolean; access: ContactsAccess }[] {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const unsubscribes = sources.flatMap((source) => [
        source.provider.subscribe(listener),
        ...(source.auth ? [source.auth.subscribe(listener)] : []),
      ]);
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [sources],
  );
  const signature = useSyncExternalStore(subscribe, () =>
    sources
      .map(
        (source) =>
          `${source.auth === undefined || source.auth.status === "signed-in" ? "1" : "0"}${source.provider.access()}`,
      )
      .join(","),
  );
  return useMemo(
    () =>
      signature
        .split(",")
        .filter(Boolean)
        .map((entry) => ({
          signedIn: entry.startsWith("1"),
          access: entry.slice(1) as ContactsAccess,
        })),
    [signature],
  );
}

/** Sources with changes of their own on the way: refreshes wait (per query client). */
const busy = new WeakMap<QueryClient, Map<string, number>>();

const busyOf = (queryClient: QueryClient) => {
  let map = busy.get(queryClient);
  if (!map) {
    map = new Map();
    busy.set(queryClient, map);
  }
  return map;
};

/** Loads a source's contacts, building on what's cached (sync tokens). */
function loadContacts(
  queryClient: QueryClient,
  source: ContactSource,
  signal: AbortSignal,
): Promise<ContactSnapshot> {
  const cached = queryClient.getQueryData<ContactSnapshot>(
    queryKeys.contacts(source.key),
  );
  // A change of the app's own is on its way: what's cached is newer.
  if (cached && (busyOf(queryClient).get(source.key) ?? 0) > 0)
    return Promise.resolve(cached);
  return source.provider.load(cached, signal);
}

/** Every source with its state and contacts. */
export function useContactsData(): readonly ContactSourceState[] {
  const queryClient = useQueryClient();
  const sources = useContactSources();
  const states = useAccessStates(sources);
  const queries = useQueries({
    queries: sources.map((source, index) => ({
      queryKey: queryKeys.contacts(source.key),
      queryFn: canLoad(
        states[index]?.signedIn ?? false,
        states[index]?.access ?? "missing",
      )
        ? ({ signal }: { signal: AbortSignal }) =>
            loadContacts(queryClient, source, signal)
        : skipToken,
      staleTime: CONTACTS_REFRESH_MS,
      refetchInterval: CONTACTS_REFRESH_MS,
    })),
  });
  return sources.map((source, index) => {
    const query = queries[index];
    return {
      source,
      signedIn: states[index]?.signedIn ?? false,
      access: states[index]?.access ?? "missing",
      snapshot: query?.data,
      error: query?.error ?? null,
      pending: query?.isPending === true && query.fetchStatus === "fetching",
    };
  });
}

/** One source's contacts, loaded when the source can (for the mail link). */
export function useSourceContacts(source: ContactSource | undefined) {
  const queryClient = useQueryClient();
  const access = useSyncExternalStore(
    source?.provider.subscribe ?? noSubscription,
    () => source?.provider.access() ?? "missing",
  );
  return useQuery({
    queryKey: queryKeys.contacts(source?.key ?? ""),
    queryFn:
      source && access !== "missing"
        ? ({ signal }) => loadContacts(queryClient, source, signal)
        : skipToken,
    staleTime: CONTACTS_REFRESH_MS,
    refetchInterval: CONTACTS_REFRESH_MS,
  });
}

const noSubscription = () => () => undefined;

/**
 * A source's contacts, loading them if needed (e.g. to find a sender
 * before opening the contacts). Undefined when the source can't load.
 */
export async function ensureContacts(
  queryClient: QueryClient,
  source: ContactSource,
): Promise<ContactSnapshot | undefined> {
  if (source.provider.access() === "missing") return undefined;
  return queryClient.query({
    queryKey: queryKeys.contacts(source.key),
    queryFn: ({ signal }) => loadContacts(queryClient, source, signal),
    staleTime: CONTACTS_REFRESH_MS,
  });
}

/** Identifies a contact across sources (in the URL; opaque to the router). */
export type ContactKey = string;

/** The key of a source's contact. */
export const contactKeyOf = (source: string, id: ContactId): ContactKey =>
  JSON.stringify([source, id]);

/** The source and id a key names; undefined for anything else. */
export function parseContactKey(
  key: string,
): { readonly source: string; readonly id: ContactId } | undefined {
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
      ? { source: value[0], id: value[1] as ContactId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the contact list shows. */
export type ContactList =
  | { readonly kind: "all" }
  /** Every contact of a source. */
  | { readonly kind: "source"; readonly source: string }
  | {
      readonly kind: "book";
      readonly source: string;
      readonly book: AddressBookId;
    }
  | {
      readonly kind: "group";
      readonly source: string;
      readonly group: ContactGroupId;
    }
  /** Google's "Other contacts". */
  | { readonly kind: "other"; readonly source: string };

/** The list's token in the URL. */
export function listToken(list: ContactList): string {
  switch (list.kind) {
    case "all":
      return "all";
    case "source":
      return JSON.stringify([list.source]);
    case "book":
      return JSON.stringify([list.source, "book", list.book]);
    case "group":
      return JSON.stringify([list.source, "group", list.group]);
    case "other":
      return JSON.stringify([list.source, "other"]);
  }
}

/** The list a token names (All contacts for anything unknown). */
export function parseListToken(token: string): ContactList {
  try {
    const value: unknown = JSON.parse(token);
    if (!Array.isArray(value) || typeof value[0] !== "string")
      return { kind: "all" };
    const [source, kind, id] = value as [string, unknown, unknown];
    if (value.length === 1) return { kind: "source", source };
    if (kind === "other" && value.length === 2)
      return { kind: "other", source };
    if (kind === "book" && typeof id === "string")
      return { kind: "book", source, book: id as AddressBookId };
    if (kind === "group" && typeof id === "string")
      return { kind: "group", source, group: id as ContactGroupId };
  } catch {
    // Not a token: All contacts.
  }
  return { kind: "all" };
}

/** The source a list belongs to, if it's one source's. */
export const sourceOfList = (list: ContactList): string | undefined =>
  list.kind === "all" ? undefined : list.source;

/** A row of the contact list. */
export interface ContactRow {
  readonly key: ContactKey;
  readonly source: ContactSource;
  readonly contact: Contact;
  /** What it's listed under. */
  readonly name: string;
  /** Its letter heading ("#" for names that don't start with a letter). */
  readonly letter: string;
}

/**
 * The rows of a list, sorted by name (`compare`: the locale's), filtered
 * by `search`. "Other contacts" only show in their own list.
 */
export function contactRows(
  states: readonly ContactSourceState[],
  list: ContactList,
  search: string,
  compare: (a: string, b: string) => number,
): ContactRow[] {
  const rows = states.flatMap(({ source, snapshot }) => {
    if (!snapshot) return [];
    if (list.kind !== "all" && list.source !== source.key) return [];
    const contacts =
      list.kind === "other"
        ? (snapshot.other ?? [])
        : snapshot.contacts.filter(
            (contact) =>
              list.kind === "all" ||
              list.kind === "source" ||
              (list.kind === "book" && contact.addressBookId === list.book) ||
              (list.kind === "group" && contact.groupIds.includes(list.group)),
          );
    return contacts
      .filter((contact) => matchesSearch(contact, search))
      .map((contact): ContactRow => {
        const name = nameOf(contact);
        return {
          key: contactKeyOf(source.key, contact.id),
          source,
          contact,
          name,
          letter: letterOf(name),
        };
      });
  });
  return rows.sort(
    (a, b) =>
      (a.letter === "#" ? 1 : 0) - (b.letter === "#" ? 1 : 0) ||
      compare(a.name, b.name) ||
      a.key.localeCompare(b.key),
  );
}

/** Finds the contact a key names in the loaded sources. */
export function findContact(
  states: readonly ContactSourceState[],
  key: ContactKey | undefined,
): ContactRow | undefined {
  const parsed = key === undefined ? undefined : parseContactKey(key);
  if (!parsed || key === undefined) return undefined;
  const state = states.find(({ source }) => source.key === parsed.source);
  const contact =
    state?.snapshot?.contacts.find(({ id }) => id === parsed.id) ??
    state?.snapshot?.other?.find(({ id }) => id === parsed.id);
  if (!state || !contact) return undefined;
  const name = nameOf(contact);
  return { key, source: state.source, contact, name, letter: letterOf(name) };
}

/** A source's contact with one of these addresses (own contacts first). */
export function contactWithAddress(
  snapshot: ContactSnapshot | undefined,
  address: string,
): Contact | undefined {
  const wanted = address.trim().toLowerCase();
  const has = (contact: Contact) =>
    contact.emails.some((email) => email.value.trim().toLowerCase() === wanted);
  return snapshot?.contacts.find(has) ?? snapshot?.other?.find(has);
}

/** Marks a source busy while `run` is on its way, so refreshes don't overwrite it. */
export async function whileBusy<T>(
  queryClient: QueryClient,
  source: string,
  run: () => Promise<T>,
): Promise<T> {
  const map = busyOf(queryClient);
  map.set(source, (map.get(source) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (map.get(source) ?? 1) - 1;
    if (left > 0) map.set(source, left);
    else map.delete(source);
  }
}

/** The book a contact is in, as loaded. */
export const bookOf = (
  snapshot: ContactSnapshot | undefined,
  contact: Contact,
): AddressBook | undefined =>
  snapshot?.addressBooks.find((book) => book.id === contact.addressBookId);

/**
 * Whether a book can take changes: it isn't read-only, or it only is
 * because the user hasn't allowed editing yet (Google), which the first
 * change asks for.
 */
export const canWriteBook = (
  access: ContactsAccess,
  book: AddressBook | undefined,
): boolean =>
  book !== undefined &&
  (access === "readOnly" || (access === "granted" && !book.readOnly));

/** Whether a contact can be changed or deleted (see {@link canWriteBook}). */
export function canChangeContact(
  state: ContactSourceState | undefined,
  contact: Contact,
): boolean {
  return (
    state !== undefined &&
    !contact.other &&
    canWriteBook(state.access, bookOf(state.snapshot, contact))
  );
}

/** An address book new contacts can go into. */
export interface WritableBook {
  readonly source: ContactSource;
  readonly book: AddressBook;
  /** Its token (see {@link listToken}): how it's remembered. */
  readonly token: string;
}

/** Every address book new contacts can go into, source by source. */
export function writableBooks(
  states: readonly ContactSourceState[],
): WritableBook[] {
  return states.flatMap(({ source, access, snapshot }) =>
    (snapshot?.addressBooks ?? [])
      .filter((book) => canWriteBook(access, book))
      .map((book) => ({
        source,
        book,
        token: listToken({ kind: "book", source: source.key, book: book.id }),
      })),
  );
}

/**
 * Where a new contact goes: the list's book (or its source's default
 * book), else the one used last, else the first.
 */
export function targetBook(
  books: readonly WritableBook[],
  list: ContactList,
  last: string,
): WritableBook | undefined {
  if (list.kind === "book") {
    const exact = books.find(
      (entry) =>
        entry.source.key === list.source && entry.book.id === list.book,
    );
    if (exact) return exact;
  }
  if (list.kind !== "all") {
    const ofSource = books.filter((entry) => entry.source.key === list.source);
    const preferred =
      ofSource.find((entry) => entry.token === last) ??
      ofSource.find((entry) => entry.book.isDefault) ??
      ofSource[0];
    if (preferred) return preferred;
  }
  return (
    books.find((entry) => entry.token === last) ??
    books.find((entry) => entry.book.isDefault) ??
    books[0]
  );
}
