/**
 * Google Contacts through the People API: the user's contacts (with their
 * labels as groups) and the read-only "Other contacts". Reading needs the
 * optional `contacts.readonly` scope asked for when an account connects;
 * changes need the full `contacts` scope, asked for on the first change.
 */
import type { AuthSession, ScopedSession } from "../../auth/types";
import {
  asAddressBookId,
  asContactGroupId,
  asContactId,
  displayNameOf,
  EMPTY_FIELDS,
  fieldsOf,
  normalized,
  type AddressBook,
  type AddressBookId,
  type Birthday,
  type Contact,
  type ContactCapabilities,
  type ContactFields,
  type ContactGroup,
  type ContactPhoto,
  type ContactRemoval,
  type ContactsAccess,
  type ContactSnapshot,
  type ContactsProvider,
  type ContactWrite,
  type NewContact,
  type PhoneKind,
  type PostalAddress,
  type Typed,
  type ValueKind,
} from "../../core/contacts";
import { isMailError, MailError } from "../../core/errors";
import { encodeBase64 } from "../../lib/base64url";
import type { GmailHttp } from "./http";
import type {
  OtherContactsResponse,
  PeopleAddress,
  PeopleBatchItem,
  PeopleBiography,
  PeopleBirthday,
  PeopleConnectionsResponse,
  PeopleContactGroup,
  PeopleContactGroupsResponse,
  PeopleEntry,
  PeopleMembership,
  PeopleName,
  PeopleOrganization,
  PeoplePerson,
  PeopleTyped,
} from "./types";

/** Reading the contacts (asked for when an account connects; optional). */
export const CONTACTS_READ_SCOPE =
  "https://www.googleapis.com/auth/contacts.readonly";
/** Reading the "Other contacts" (asked for with the contacts). */
export const OTHER_CONTACTS_SCOPE =
  "https://www.googleapis.com/auth/contacts.other.readonly";
/** Changing contacts: asked for on the first change ("Allow editing"). */
export const CONTACTS_WRITE_SCOPE = "https://www.googleapis.com/auth/contacts";

/** Everything action0 reads of a contact. */
const PERSON_FIELDS =
  "names,nicknames,emailAddresses,phoneNumbers,organizations,addresses,birthdays,urls,biographies,memberships,photos,metadata";
/** What "Other contacts" have. */
const OTHER_FIELDS = "names,emailAddresses,phoneNumbers,photos";
/** Google's one address book: the user's contacts. */
const BOOK = asAddressBookId("contacts");
const MY_CONTACTS = "contactGroups/myContacts";
const STARRED = "contactGroups/starred";
/** Google's limits per batch request. */
const CREATE_BATCH = 200;
const DELETE_BATCH = 500;
const GET_BATCH = 200;

const CAPABILITIES: ContactCapabilities = {
  emailKinds: true,
  phoneKinds: ["mobile", "home", "work", "other"],
  addressKinds: ["home", "work", "other"],
  oneAddressPerKind: false,
  websiteKinds: true,
  birthdayYear: false,
  groups: true,
  otherContacts: true,
};

/** The fields `updateContact` may change, as action0 names them. */
const FAMILIES = {
  name: "names",
  nickname: "nicknames",
  emails: "emailAddresses",
  phones: "phoneNumbers",
  organization: "organizations",
  addresses: "addresses",
  birthday: "birthdays",
  websites: "urls",
  notes: "biographies",
  groupIds: "memberships",
} as const;
type Family = keyof typeof FAMILIES;

/** The writable person fields of a contact (what a recreated contact keeps). */
const WRITABLE = new Set([
  "addresses",
  "biographies",
  "birthdays",
  "calendarUrls",
  "clientData",
  "emailAddresses",
  "events",
  "externalIds",
  "fileAses",
  "genders",
  "imClients",
  "interests",
  "locales",
  "locations",
  "memberships",
  "miscKeywords",
  "names",
  "nicknames",
  "occupations",
  "organizations",
  "phoneNumbers",
  "relations",
  "sipAddresses",
  "urls",
  "userDefined",
]);

/** Where the change tracking of both lists stands. */
interface Tokens {
  readonly contacts?: string;
  readonly other?: string;
}

/** See the module docs. */
export class GoogleContactsProvider implements ContactsProvider {
  readonly capabilities = CAPABILITIES;
  readonly setup = "consent" as const;
  readonly #http: GmailHttp;
  readonly #session: AuthSession & ScopedSession;
  readonly #fetch: typeof fetch;
  /** Google asks for one change of a user's contacts at a time. */
  #mutations: Promise<unknown> = Promise.resolve();

  /**
   * @param http People API client ({@link PEOPLE_API_BASE}).
   * @param session The account's session, which knows the granted scopes.
   * @param options.fetch Loads photos (the apps' native fetch).
   */
  constructor(
    http: GmailHttp,
    session: AuthSession & ScopedSession,
    options: { readonly fetch?: typeof fetch } = {},
  ) {
    this.#http = http;
    this.#session = session;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  readonly access = (): ContactsAccess =>
    this.#session.hasScopes([CONTACTS_WRITE_SCOPE])
      ? "granted"
      : this.#session.hasScopes([CONTACTS_READ_SCOPE])
        ? "readOnly"
        : "missing";

  readonly requestAccess = async (): Promise<void> => {
    try {
      await this.#session.requestScopes([
        CONTACTS_WRITE_SCOPE,
        OTHER_CONTACTS_SCOPE,
      ]);
    } catch (error) {
      // Declining only the Other contacts still allows editing.
      if (!this.#session.hasScopes([CONTACTS_WRITE_SCOPE])) throw error;
    }
  };

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#session.subscribe(listener);

  async load(
    previous: ContactSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<ContactSnapshot> {
    const access = this.access();
    if (access === "missing")
      throw new MailError(
        "unavailable",
        "This account hasn't allowed access to its contacts yet.",
        { reason: "contactsAccessNeeded" },
      );
    const tokens = tokensOf(previous);
    const withOther = this.#session.hasScopes([OTHER_CONTACTS_SCOPE]);
    try {
      const [contacts, groups, other] = await Promise.all([
        this.#sync(
          "people/me/connections",
          "connections",
          { personFields: PERSON_FIELDS },
          previous?.contacts,
          tokens.contacts,
          false,
          signal,
        ),
        this.#groups(signal),
        withOther
          ? this.#sync(
              "otherContacts",
              "otherContacts",
              { readMask: OTHER_FIELDS },
              previous?.other,
              tokens.other,
              true,
              signal,
            )
          : Promise.resolve({ list: [], token: undefined }),
      ]);
      const book: AddressBook = {
        id: BOOK,
        name: "Contacts",
        readOnly: access !== "granted",
        isDefault: true,
      };
      const token: Tokens = {
        ...(contacts.token ? { contacts: contacts.token } : {}),
        ...(other.token ? { other: other.token } : {}),
      };
      return {
        addressBooks: [book],
        groups,
        contacts: contacts.list,
        other: other.list,
        token: JSON.stringify(token),
      };
    } catch (error) {
      throw accessError(error);
    }
  }

  create(
    _book: AddressBookId,
    contact: NewContact,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    return this.#mutate(async () => {
      const person = await this.#http.post<PeoplePerson>(
        `./people:createContact?personFields=${PERSON_FIELDS}`,
        personOf(contact.fields),
        signal,
        { retry: false },
      );
      const withPhoto = contact.photo
        ? await this.#setPhoto(person, contact.photo, signal)
        : person;
      return this.#created(withPhoto);
    });
  }

  createMany(
    _book: AddressBookId,
    contacts: readonly NewContact[],
    options: {
      readonly onProgress?: (done: number) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<readonly (ContactWrite | MailError)[]> {
    return this.#mutate(async () =>
      (
        await this.#createPersons(
          contacts.map((contact) => ({
            person: personOf(contact.fields),
            ...(contact.photo ? { photo: contact.photo } : {}),
          })),
          options,
        )
      ).map((result) =>
        result instanceof MailError ? result : this.#created(result),
      ),
    );
  }

  update(
    contact: Contact,
    fields: ContactFields,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    return this.#mutate(async () => {
      const { before, after } = await this.#update(contact, fields, signal);
      return {
        contact: after,
        undo: (undoSignal) =>
          this.#mutate(
            async () =>
              (await this.#update(after, fieldsOf(before), undoSignal)).after,
          ),
      };
    });
  }

  remove(
    contacts: readonly Contact[],
    signal?: AbortSignal,
  ): Promise<ContactRemoval> {
    return this.#mutate(async () => {
      this.#requireWrite();
      if (contacts.some((contact) => contact.other))
        throw new MailError("unavailable", "Other contacts can't be deleted.", {
          reason: "addressBookReadOnly",
        });
      // What's needed to bring them back: the whole person (so nothing
      // action0 doesn't show gets lost) and the photo.
      const people = await this.#batchGet(contacts, signal).catch(
        () => new Map<string, PeoplePerson>(),
      );
      const photos = await Promise.all(
        contacts.map((contact) =>
          this.photo(contact, signal).catch(() => undefined),
        ),
      );
      try {
        if (contacts.length === 1 && contacts[0]) {
          await this.#http
            .delete(`./${contacts[0].id}:deleteContact`, signal)
            .catch((error: unknown) => {
              if (!isMailError(error, "not-found")) throw error;
            });
        } else {
          for (const chunk of chunks(contacts, DELETE_BATCH))
            await this.#http.post(
              "./people:batchDeleteContacts",
              { resourceNames: chunk.map((contact) => contact.id) },
              signal,
            );
        }
      } catch (error) {
        throw writeError(error);
      }
      return {
        undo: (undoSignal) =>
          this.#mutate(async () => {
            const results = await this.#createPersons(
              contacts.map((contact, index) => {
                const raw = people.get(contact.id);
                const photo = photos[index];
                return {
                  person: raw ? createable(raw) : personOf(fieldsOf(contact)),
                  ...(photo ? { photo } : {}),
                };
              }),
              { ...(undoSignal ? { signal: undoSignal } : {}) },
            );
            const failed = results.find(
              (result): result is MailError => result instanceof MailError,
            );
            if (failed) throw failed;
            return results.flatMap((result) => {
              const restored = result instanceof MailError ? [] : [result];
              return restored.flatMap((person) => contactOf(person) ?? []);
            });
          }),
      };
    });
  }

  createGroup(name: string, signal?: AbortSignal): Promise<ContactGroup> {
    return this.#mutate(async () => {
      this.#requireWrite();
      try {
        const group = await this.#http.post<PeopleContactGroup>(
          "contactGroups",
          { contactGroup: { name: name.trim() } },
          signal,
          { retry: false },
        );
        return {
          id: asContactGroupId(group.resourceName ?? ""),
          name: group.formattedName ?? group.name ?? name.trim(),
        };
      } catch (error) {
        throw writeError(error);
      }
    });
  }

  addOther(contact: Contact, signal?: AbortSignal): Promise<ContactWrite> {
    return this.#mutate(async () => {
      this.#requireWrite();
      try {
        const person = await this.#http.post<PeoplePerson>(
          `./${contact.id}:copyOtherContactToMyContactsGroup`,
          {
            copyMask: "names,emailAddresses,phoneNumbers",
            readMask: PERSON_FIELDS,
          },
          signal,
          { retry: false },
        );
        return this.#created(person);
      } catch (error) {
        throw writeError(error);
      }
    });
  }

  async photo(
    contact: Contact,
    signal?: AbortSignal,
  ): Promise<Blob | undefined> {
    if (contact.photo?.kind !== "url") return undefined;
    try {
      const response = await this.#fetch(contact.photo.url, {
        ...(signal ? { signal } : {}),
      });
      return response.ok ? await response.blob() : undefined;
    } catch {
      return undefined;
    }
  }

  /** A created person as a write whose undo deletes it again. */
  #created(person: PeoplePerson): ContactWrite {
    const contact = contactOf(person);
    if (!contact)
      throw new MailError("provider", "Google Contacts: no contact came back.");
    return {
      contact,
      undo: (signal) =>
        this.#mutate(async () => {
          await this.#http
            .delete(`./${contact.id}:deleteContact`, signal)
            .catch((error: unknown) => {
              if (!isMailError(error, "not-found")) throw writeError(error);
            });
          return undefined;
        }),
    };
  }

  /**
   * Changes the families of fields that differ, on the person as Google
   * has it now; entries that stay the same are sent back untouched.
   */
  async #update(
    contact: Contact,
    fields: ContactFields,
    signal: AbortSignal | undefined,
  ): Promise<{ before: Contact; after: Contact }> {
    this.#requireWrite();
    try {
      const person = await this.#http.get<PeoplePerson>(
        `./${contact.id}`,
        { personFields: PERSON_FIELDS },
        signal,
      );
      if (contact.version !== undefined && person.etag !== contact.version)
        throw changed();
      const before = contactOf(person);
      if (!before) throw changed();
      const wanted = normalized(fields);
      const families = (Object.keys(FAMILIES) as Family[]).filter(
        (family) => !sameFamily(family, normalized(before), wanted),
      );
      if (families.length === 0) return { before, after: before };
      const body: PeoplePerson = {
        ...(person.etag === undefined ? {} : { etag: person.etag }),
        metadata: { sources: person.metadata?.sources ?? [] },
      };
      for (const family of families) writeFamily(body, family, person, wanted);
      const mask = families.map((family) => FAMILIES[family]).join(",");
      const updated = await this.#http.patch<PeoplePerson>(
        `./${contact.id}:updateContact?updatePersonFields=${mask}&personFields=${PERSON_FIELDS}`,
        body,
        signal,
      );
      const after = contactOf(updated);
      if (!after) throw changed();
      return { before, after };
    } catch (error) {
      throw writeError(error);
    }
  }

  /**
   * Creates people in batches, then gives those with a photo theirs.
   * Results are in the order asked for.
   */
  async #createPersons(
    items: readonly { readonly person: PeoplePerson; readonly photo?: Blob }[],
    options: {
      readonly onProgress?: (done: number) => void;
      readonly signal?: AbortSignal;
    },
  ): Promise<(PeoplePerson | MailError)[]> {
    this.#requireWrite();
    const results: (PeoplePerson | MailError)[] = [];
    for (const chunk of chunks(items, CREATE_BATCH)) {
      let answer: { createdPeople?: PeopleBatchItem[] };
      try {
        answer = await this.#http.post<{ createdPeople?: PeopleBatchItem[] }>(
          "./people:batchCreateContacts",
          {
            contacts: chunk.map(({ person }) => ({ contactPerson: person })),
            readMask: PERSON_FIELDS,
          },
          options.signal,
          { retry: false },
        );
      } catch (error) {
        // Nothing of this batch was created; the rest isn't tried.
        if (results.length === 0) throw writeError(error);
        const failed = writeError(error);
        const reason =
          failed instanceof MailError
            ? failed
            : new MailError("provider", String(failed));
        while (results.length < items.length) results.push(reason);
        break;
      }
      const created = answer.createdPeople ?? [];
      for (const [index, item] of chunk.entries()) {
        const one = created[index];
        const person = one?.person;
        if (!person || (one.status?.code ?? 0) !== 0) {
          results.push(
            new MailError(
              "provider",
              `Google Contacts: ${one?.status?.message ?? "the contact wasn't created."}`,
              {
                ...(one?.httpStatusCode ? { status: one.httpStatusCode } : {}),
              },
            ),
          );
          continue;
        }
        results.push(
          item.photo
            ? await this.#setPhoto(person, item.photo, options.signal).catch(
                () => person,
              )
            : person,
        );
      }
      options.onProgress?.(results.length);
    }
    return results;
  }

  async #setPhoto(
    person: PeoplePerson,
    photo: Blob,
    signal: AbortSignal | undefined,
  ): Promise<PeoplePerson> {
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const answer = await this.#http.patch<{ person?: PeoplePerson }>(
      `./${person.resourceName ?? ""}:updateContactPhoto`,
      { photoBytes: encodeBase64(bytes), personFields: PERSON_FIELDS },
      signal,
    );
    return answer.person ?? person;
  }

  /** The whole people behind these contacts, by resource name. */
  async #batchGet(
    contacts: readonly Contact[],
    signal: AbortSignal | undefined,
  ): Promise<Map<string, PeoplePerson>> {
    const people = new Map<string, PeoplePerson>();
    for (const chunk of chunks(contacts, GET_BATCH)) {
      const answer = await this.#http.get<{ responses?: PeopleBatchItem[] }>(
        "./people:batchGet",
        {
          resourceNames: chunk.map((contact) => contact.id),
          personFields: PERSON_FIELDS,
        },
        signal,
      );
      for (const { person } of answer.responses ?? [])
        if (person?.resourceName) people.set(person.resourceName, person);
    }
    return people;
  }

  /**
   * A list with its sync token: all of it, or (with a token and the list
   * it belongs to) only the changes, applied to that list.
   */
  async #sync(
    path: string,
    key: "connections" | "otherContacts",
    params: Readonly<Record<string, string>>,
    previous: readonly Contact[] | undefined,
    token: string | undefined,
    other: boolean,
    signal: AbortSignal | undefined,
  ): Promise<{ list: Contact[]; token: string | undefined }> {
    const fetchAll = async (syncToken?: string) => {
      const people: PeoplePerson[] = [];
      let pageToken: string | undefined;
      let next: string | undefined;
      do {
        const page = await this.#http.get<
          PeopleConnectionsResponse & OtherContactsResponse
        >(
          path,
          {
            ...params,
            pageSize: 1000,
            requestSyncToken: true,
            pageToken,
            syncToken,
          },
          signal,
        );
        people.push(...(page[key] ?? []));
        pageToken = page.nextPageToken;
        next = page.nextSyncToken ?? next;
      } while (pageToken);
      return { people, token: next };
    };
    if (previous && token) {
      try {
        const changes = await fetchAll(token);
        const byId = new Map(previous.map((contact) => [contact.id, contact]));
        for (const person of changes.people) {
          if (!person.resourceName) continue;
          const id = asContactId(person.resourceName);
          if (person.metadata?.deleted) {
            byId.delete(id);
            continue;
          }
          const contact = contactOf(person, other);
          if (contact) byId.set(id, contact);
        }
        return { list: [...byId.values()], token: changes.token ?? token };
      } catch (error) {
        if (!expiredToken(error)) throw error;
      }
    }
    const all = await fetchAll();
    return {
      list: all.people.flatMap(
        (person) =>
          (person.metadata?.deleted ? [] : contactOf(person, other)) ?? [],
      ),
      token: all.token,
    };
  }

  /** The user's labels and Starred (Google's other system groups are left out). */
  async #groups(signal: AbortSignal | undefined): Promise<ContactGroup[]> {
    const groups: ContactGroup[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#http.get<PeopleContactGroupsResponse>(
        "contactGroups",
        { groupFields: "name,groupType", pageSize: 1000, pageToken },
        signal,
      );
      for (const group of page.contactGroups ?? []) {
        const id = group.resourceName;
        if (!id || !shownGroup(id, group.groupType)) continue;
        groups.push({
          id: asContactGroupId(id),
          name:
            group.formattedName ??
            group.name ??
            (id === STARRED ? "Starred" : id),
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return groups;
  }

  #requireWrite() {
    if (!this.#session.hasScopes([CONTACTS_WRITE_SCOPE]))
      throw new MailError(
        "unavailable",
        "Changing contacts needs permission first.",
        { reason: "contactsAccessNeeded" },
      );
  }

  /** Runs a change after the ones before it (Google asks for that). */
  #mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(run, run);
    this.#mutations = result.catch(() => undefined);
    return result;
  }
}

/** The sync tokens of the last load. */
function tokensOf(previous: ContactSnapshot | undefined): Tokens {
  if (!previous?.token) return {};
  try {
    const parsed = JSON.parse(previous.token) as Record<string, unknown>;
    const { contacts, other } = parsed;
    return {
      ...(typeof contacts === "string" ? { contacts } : {}),
      ...(typeof other === "string" ? { other } : {}),
    };
  } catch {
    return {};
  }
}

/** Google said the sync token is too old: load everything again. */
function expiredToken(error: unknown): boolean {
  if (!isMailError(error)) return false;
  if (error.status === 410) return true;
  return (
    error.status === 400 &&
    /EXPIRED_SYNC_TOKEN|FAILED_PRECONDITION|sync token/i.test(
      `${error.message} ${JSON.stringify(error.cause ?? "")}`,
    )
  );
}

/** A 403 while reading: the People API is off, or the permission missing. */
function accessError(error: unknown): unknown {
  if (!isMailError(error) || error.status !== 403) return error;
  const disabled = /has not been used|is disabled|SERVICE_DISABLED/i.test(
    `${error.message} ${JSON.stringify(error.cause ?? "")}`,
  );
  return new MailError(
    "unavailable",
    disabled
      ? "The People API isn't enabled in the Google Cloud project."
      : "This account hasn't allowed access to its contacts yet.",
    {
      status: 403,
      cause: error,
      reason: disabled ? "peopleApiDisabled" : "contactsAccessNeeded",
    },
  );
}

/** Failures of a change, as the app describes them. */
function writeError(error: unknown): unknown {
  if (!isMailError(error) || error.reason) return error;
  if (error.status === 403) return accessError(error);
  if (error.code === "not-found")
    return new MailError("not-found", "This contact no longer exists.", {
      status: 404,
      cause: error,
      reason: "contactGone",
    });
  if (
    error.status === 400 &&
    /FAILED_PRECONDITION|etag/i.test(
      `${error.message} ${JSON.stringify(error.cause ?? "")}`,
    )
  )
    return changed(error);
  return error;
}

function changed(cause?: unknown): MailError {
  return new MailError(
    "provider",
    "This contact was changed somewhere else meanwhile.",
    { status: 412, reason: "contactChanged", ...(cause ? { cause } : {}) },
  );
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let at = 0; at < list.length; at += size)
    result.push(list.slice(at, at + size));
  return result;
}

/** Groups shown as groups: the user's labels and Starred. */
function shownGroup(id: string, groupType?: string): boolean {
  if (id === STARRED) return true;
  if (groupType !== undefined) return groupType === "USER_CONTACT_GROUP";
  return !/^contactGroups\/(myContacts|friends|family|coworkers|chatBuddies|all|blocked)$/.test(
    id,
  );
}

/**
 * Entries of the user's own contact data. Others (a linked Google
 * profile's) can't be changed, and Google ignores them in updates.
 */
function own<T extends PeopleEntry>(list: readonly T[] | undefined): T[] {
  return (list ?? []).filter((entry) => {
    const type = entry.metadata?.source?.type;
    return type === undefined || type === "CONTACT";
  });
}

/** The main entry: the primary one of the user's own, else the first. */
function main<T extends PeopleEntry>(
  list: readonly T[] | undefined,
): T | undefined {
  const mine = own(list);
  return mine.find((entry) => entry.metadata?.primary) ?? mine[0];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

const KINDS: readonly ValueKind[] = ["home", "work", "other"];
const PHONE_KINDS: readonly PhoneKind[] = ["mobile", "home", "work", "other"];

/** A Google type as a kind, or as a label of its own ("Home fax"). */
function typedOf<K extends string>(
  entry: { type?: string; formattedType?: string },
  kinds: readonly K[],
): { kind: K; label?: string } {
  const type = entry.type?.trim() ?? "";
  const known = kinds.find((kind) => kind === type.toLowerCase());
  if (known) return { kind: known };
  const fallback = (kinds.includes("other" as K) ? "other" : kinds[0]) as K;
  const label = entry.formattedType?.trim() || type;
  return label ? { kind: fallback, label } : { kind: fallback };
}

function typedList<K extends string>(
  list: readonly PeopleTyped[] | undefined,
  kinds: readonly K[],
): Typed<K>[] {
  return own(list).flatMap((entry) => {
    const value = text(entry.value).trim();
    return value ? [{ value, ...typedOf(entry, kinds) }] : [];
  });
}

function addressOf(entry: PeopleAddress): PostalAddress {
  return {
    street: text(entry.streetAddress),
    city: text(entry.city),
    region: text(entry.region),
    postalCode: text(entry.postalCode),
    country: text(entry.country),
    ...typedOf(entry, KINDS),
  };
}

function birthdayOf(list: readonly PeopleBirthday[] | undefined) {
  const dated = own(list).filter(
    (entry) => entry.date?.month !== undefined && entry.date.day !== undefined,
  );
  const entry =
    dated.find((candidate) => candidate.metadata?.primary) ?? dated[0];
  const date = entry?.date;
  if (!date?.month || !date.day) return undefined;
  const birthday: Birthday = {
    month: date.month,
    day: date.day,
    ...(date.year ? { year: date.year } : {}),
  };
  return birthday;
}

/** Google's photo URLs end in a size (`=s100`): ask for a sharper one. */
function photoOf(person: PeoplePerson): ContactPhoto | undefined {
  const photos = (person.photos ?? []).filter(
    (photo) => photo.url && !photo.default,
  );
  const photo = photos.find((p) => p.metadata?.primary) ?? photos[0];
  if (!photo?.url) return undefined;
  return { kind: "url", url: photo.url.replace(/=s\d+(-[a-z]+)?$/, "=s200") };
}

/** A person as a contact (undefined without a resource name). */
export function contactOf(
  person: PeoplePerson,
  other = false,
): Contact | undefined {
  if (!person.resourceName) return undefined;
  const name = main(person.names);
  const organization = main(person.organizations);
  const birthday = birthdayOf(person.birthdays);
  const photo = photoOf(person);
  const displayName =
    (person.names ?? []).find((entry) => entry.metadata?.primary)
      ?.displayName ??
    name?.displayName ??
    "";
  const fields: ContactFields = {
    name: {
      given: text(name?.givenName),
      middle: text(name?.middleName),
      family: text(name?.familyName),
    },
    nickname: text(main(person.nicknames)?.value),
    emails: typedList(person.emailAddresses, KINDS),
    phones: typedList(person.phoneNumbers, PHONE_KINDS),
    organization: {
      company: text(organization?.name),
      title: text(organization?.title),
      department: text(organization?.department),
    },
    addresses: own(person.addresses).map(addressOf),
    ...(birthday ? { birthday } : {}),
    websites: typedList(person.urls, KINDS),
    notes: text(main(person.biographies)?.value),
    groupIds: (person.memberships ?? []).flatMap((membership) => {
      const id = membership.contactGroupMembership?.contactGroupResourceName;
      return id && shownGroup(id) ? [asContactGroupId(id)] : [];
    }),
  };
  return {
    ...fields,
    id: asContactId(person.resourceName),
    addressBookId: BOOK,
    displayName: displayName.trim() || displayNameOf(fields),
    ...(photo ? { photo } : {}),
    ...(person.etag ? { version: person.etag } : {}),
    ...(other ? { other: true as const } : {}),
  };
}

/** Whether a family of fields is the same in both. */
function sameFamily(family: Family, a: ContactFields, b: ContactFields) {
  if (family === "groupIds")
    return (
      a.groupIds.length === b.groupIds.length &&
      a.groupIds.every((id) => b.groupIds.includes(id))
    );
  return canonical(a[family]) === canonical(b[family]);
}

/** JSON with keys in a fixed order, so equal values compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}

/** An entry without what Google works out itself. */
function bare<T extends PeopleEntry>(entry: T): T {
  const {
    formattedType: _type,
    canonicalForm: _canonical,
    formattedValue: _value,
    ...rest
  } = entry;
  return rest as T;
}

/**
 * Entries for these values: an unchanged one is sent back as Google had
 * it; a changed one keeps what else its entry had.
 */
function typedEntries<K extends string>(
  originals: readonly PeopleTyped[],
  wanted: readonly Typed<K>[],
  kinds: readonly K[],
): PeopleTyped[] {
  const unused = [...originals];
  const take = (index: number) => unused.splice(index, 1)[0] ?? {};
  const typeOf = (item: Typed<K>) => item.label ?? item.kind;
  return wanted.map((item) => {
    const same = unused.findIndex((entry) => {
      const { kind, label } = typedOf(entry, kinds);
      return (
        text(entry.value).trim() === item.value &&
        kind === item.kind &&
        label === item.label
      );
    });
    if (same >= 0) return take(same);
    if (item.label) {
      const labelled = unused.findIndex(
        (entry) => typedOf(entry, kinds).label === item.label,
      );
      if (labelled >= 0) return { ...bare(take(labelled)), value: item.value };
    }
    const sameValue = unused.findIndex(
      (entry) => text(entry.value).trim() === item.value,
    );
    if (sameValue >= 0) return { ...bare(take(sameValue)), type: typeOf(item) };
    return { value: item.value, type: typeOf(item) };
  });
}

function addressEntries(
  originals: readonly PeopleAddress[],
  wanted: readonly PostalAddress[],
): PeopleAddress[] {
  const unused = [...originals];
  return wanted.map((address, index) => {
    const same = unused.findIndex(
      (entry) =>
        canonical(normalizedAddress(addressOf(entry))) === canonical(address),
    );
    if (same >= 0) return unused.splice(same, 1)[0] ?? {};
    // A changed address keeps what else its entry had (extended address, PO box).
    const original = originals[index];
    const at = original ? unused.indexOf(original) : -1;
    const base = at >= 0 ? (unused.splice(at, 1)[0] ?? {}) : {};
    return {
      ...bare(base),
      streetAddress: address.street,
      city: address.city,
      region: address.region,
      postalCode: address.postalCode,
      country: address.country,
      type: address.label ?? address.kind,
    };
  });
}

function normalizedAddress(address: PostalAddress): PostalAddress {
  return (
    normalized({ ...EMPTY_FIELDS, addresses: [address] }).addresses[0] ??
    address
  );
}

/** Puts one family of `wanted` into `body`, on top of what `person` has. */
function writeFamily(
  body: PeoplePerson,
  family: Family,
  person: PeoplePerson,
  wanted: ContactFields,
) {
  switch (family) {
    case "name": {
      const original: PeopleName = main(person.names) ?? {};
      const {
        displayName: _display,
        displayNameLastFirst: _lastFirst,
        unstructuredName: _unstructured,
        givenName: _given,
        middleName: _middle,
        familyName: _family,
        ...rest
      } = original;
      const { given, middle, family: last } = wanted.name;
      const parts = {
        ...(given ? { givenName: given } : {}),
        ...(middle ? { middleName: middle } : {}),
        ...(last ? { familyName: last } : {}),
      };
      const kept = Object.keys(rest).some((key) => key !== "metadata");
      body.names =
        Object.keys(parts).length > 0 || kept ? [{ ...rest, ...parts }] : [];
      return;
    }
    case "nickname": {
      const [first, ...others] = own(person.nicknames);
      body.nicknames = wanted.nickname
        ? [{ ...(first ?? {}), value: wanted.nickname }, ...others]
        : others;
      return;
    }
    case "emails":
      body.emailAddresses = typedEntries(
        own(person.emailAddresses),
        wanted.emails,
        KINDS,
      );
      return;
    case "phones":
      body.phoneNumbers = typedEntries(
        own(person.phoneNumbers),
        wanted.phones,
        PHONE_KINDS,
      );
      return;
    case "websites":
      body.urls = typedEntries(own(person.urls), wanted.websites, KINDS);
      return;
    case "organization": {
      const [first, ...others] = own(person.organizations);
      const { company, title, department } = wanted.organization;
      const {
        name: _n,
        title: _t,
        department: _d,
        ...rest
      }: PeopleOrganization = first ?? {};
      const filled = company || title || department;
      body.organizations = filled
        ? [
            {
              ...rest,
              ...(company ? { name: company } : {}),
              ...(title ? { title } : {}),
              ...(department ? { department } : {}),
            },
            ...others,
          ]
        : others;
      return;
    }
    case "addresses":
      body.addresses = addressEntries(own(person.addresses), wanted.addresses);
      return;
    case "birthday": {
      const original: PeopleBirthday = main(person.birthdays) ?? {};
      const { text: _text, date: _date, ...rest } = original;
      const { birthday } = wanted;
      body.birthdays = birthday
        ? [
            {
              ...rest,
              date: {
                ...(birthday.year ? { year: birthday.year } : {}),
                month: birthday.month,
                day: birthday.day,
              },
            },
          ]
        : [];
      return;
    }
    case "notes": {
      const original: PeopleBiography = main(person.biographies) ?? {};
      body.biographies = wanted.notes
        ? [{ ...original, value: wanted.notes, contentType: "TEXT_PLAIN" }]
        : [];
      return;
    }
    case "groupIds": {
      const kept = (person.memberships ?? []).filter((membership) => {
        const id = membership.contactGroupMembership?.contactGroupResourceName;
        return !id || !shownGroup(id);
      });
      const added: PeopleMembership[] = wanted.groupIds.map((id) => ({
        contactGroupMembership: { contactGroupResourceName: id },
      }));
      const memberships = [...kept, ...added];
      body.memberships = memberships.some(
        (membership) => membership.contactGroupMembership,
      )
        ? memberships
        : [membershipOf(MY_CONTACTS), ...memberships];
      return;
    }
  }
}

const membershipOf = (id: string): PeopleMembership => ({
  contactGroupMembership: { contactGroupResourceName: id },
});

/** A new person with these fields (in My Contacts and the chosen groups). */
export function personOf(fields: ContactFields): PeoplePerson {
  const wanted = normalized(fields);
  const person: PeoplePerson = {};
  for (const family of Object.keys(FAMILIES) as Family[])
    writeFamily(person, family, {}, wanted);
  // A new contact belongs to My Contacts, like those made in Google Contacts.
  const memberships = person.memberships ?? [];
  person.memberships = memberships.some(
    (membership) =>
      membership.contactGroupMembership?.contactGroupResourceName ===
      MY_CONTACTS,
  )
    ? memberships
    : [membershipOf(MY_CONTACTS), ...memberships];
  return Object.fromEntries(
    Object.entries(person).filter(
      ([, value]) => !Array.isArray(value) || value.length > 0,
    ),
  );
}

/**
 * A person as it can be created again: its writable fields, without what
 * Google adds itself (ids, sources, formatted values).
 */
function createable(person: PeoplePerson): PeoplePerson {
  const result: PeoplePerson = {};
  for (const [key, value] of Object.entries(person)) {
    if (!WRITABLE.has(key) || !Array.isArray(value)) continue;
    const entries = (value as PeopleEntry[])
      .filter((entry) => {
        const type = entry.metadata?.source?.type;
        return type === undefined || type === "CONTACT";
      })
      .map((entry) => {
        const {
          metadata: _metadata,
          formattedType: _type,
          canonicalForm: _canonical,
          formattedProtocol: _protocol,
          ...rest
        } = entry;
        if (key === "names") {
          const {
            displayName: _display,
            displayNameLastFirst: _lastFirst,
            ...name
          } = rest;
          return name;
        }
        if (key === "memberships") {
          const membership = rest as PeopleMembership;
          const id =
            membership.contactGroupMembership?.contactGroupResourceName;
          return id ? membershipOf(id) : undefined;
        }
        return rest;
      })
      .filter((entry) => entry !== undefined);
    if (entries.length > 0) result[key] = entries;
  }
  return result;
}
