import { CONTACTS_SCOPES } from "../../auth/microsoft/msal";
import type { ScopedSession } from "../../auth/types";
import {
  asAddressBookId,
  asContactGroupId,
  asContactId,
  displayNameOf,
  fieldsOf,
  fitTo,
  normalized,
  type AddressBook,
  type AddressBookId,
  type Birthday,
  type Contact,
  type ContactCapabilities,
  type ContactFields,
  type ContactGroup,
  type ContactRemoval,
  type ContactsAccess,
  type ContactSnapshot,
  type ContactsProvider,
  type ContactWrite,
  type GroupRemoval,
  type GroupWrite,
  type NewContact,
  type PostalAddress,
  type ValueKind,
} from "../../core/contacts";
import { MailError } from "../../core/errors";
import { colorOfPreset, OUTLOOK_CATEGORY_COLORS } from "./folders";
import {
  BATCH_LIMIT,
  graphErrorCode,
  type BatchResult,
  type GraphHttp,
} from "./http";
import type {
  GraphCategory,
  GraphContact,
  GraphContactFolder,
  GraphPage,
  GraphPhysicalAddress,
} from "./types";

/** What Outlook contacts can hold. */
export const GRAPH_CONTACT_CAPABILITIES: ContactCapabilities = {
  emailKinds: false,
  maxEmails: 3,
  phoneKinds: ["mobile", "home", "work"],
  maxPhones: { mobile: 1, home: 2, work: 2 },
  addressKinds: ["home", "work", "other"],
  oneAddressPerKind: true,
  websiteKinds: false,
  maxWebsites: 1,
  birthdayYear: true,
  groups: true,
  // Graph can't rename categories.
  renameGroups: false,
  emptyGroups: true,
  groupColors: OUTLOOK_CATEGORY_COLORS.map((color, index) => ({
    id: `preset${String(index)}`,
    color: color.background,
  })),
  // Graph can't delete contact photos (nor change them on personal accounts).
  photos: { change: true, remove: false },
  otherContacts: false,
};

/**
 * The default Contacts folder. Its Graph id is only known once it has
 * sub-folders or contacts, so it gets a fixed one of its own.
 */
const DEFAULT_BOOK = asAddressBookId("contacts");

/** The contact fields action0 reads. */
const SELECT = [
  "id",
  "changeKey",
  "parentFolderId",
  "displayName",
  "givenName",
  "middleName",
  "surname",
  "nickName",
  "emailAddresses",
  "businessPhones",
  "homePhones",
  "mobilePhone",
  "companyName",
  "jobTitle",
  "department",
  "homeAddress",
  "businessAddress",
  "otherAddress",
  "birthday",
  "businessHomePage",
  "personalNotes",
  "categories",
].join(",");

/** Page size of delta rounds. */
const PAGE = "odata.maxpagesize=200";

/** Most pages one listing follows, against a link that never ends. */
const MAX_PAGES = 1000;

/** Most contacts whose photos are kept when deleting (one request each). */
const MAX_PHOTOS = 20;

/** Properties Graph sets itself, left out when a contact is created again. */
const READ_ONLY = new Set([
  "id",
  "changeKey",
  "createdDateTime",
  "lastModifiedDateTime",
  "parentFolderId",
]);

/** The parts of a contact a write can change. */
type Family =
  | "name"
  | "nickname"
  | "emails"
  | "phones"
  | "organization"
  | "addresses"
  | "birthday"
  | "websites"
  | "notes"
  | "groups";

const FAMILIES: readonly Family[] = [
  "name",
  "nickname",
  "emails",
  "phones",
  "organization",
  "addresses",
  "birthday",
  "websites",
  "notes",
  "groups",
];

/** Where change tracking stands, kept in {@link ContactSnapshot.token}. */
interface SyncState {
  /** The default Contacts folder's Graph id, once known. */
  readonly defaultId?: string;
  readonly defaultName?: string;
  /** Delta links by address book. */
  readonly links: Readonly<Record<string, string>>;
}

const enc = encodeURIComponent;

/**
 * Outlook contacts through Microsoft Graph: the default Contacts folder and
 * its sub-folders as address books, Outlook categories as groups, delta
 * queries per folder. Needs `Contacts.ReadWrite`, asked for on demand.
 */
export class GraphContactsProvider implements ContactsProvider {
  readonly capabilities: ContactCapabilities;
  readonly setup = "consent" as const;
  readonly #http: GraphHttp;
  readonly #session: ScopedSession;

  /**
   * @param http Client whose token carries {@link CONTACTS_SCOPES}.
   * @param session Tells whether the account consented to them.
   * @param options.personal An Outlook.com account: Graph can't change its
   *   contacts' photos.
   */
  constructor(
    http: GraphHttp,
    session: ScopedSession,
    options: { readonly personal?: boolean } = {},
  ) {
    this.#http = http;
    this.#session = session;
    this.capabilities = {
      ...GRAPH_CONTACT_CAPABILITIES,
      photos: { change: options.personal !== true, remove: false },
    };
  }

  readonly access = (): ContactsAccess =>
    this.#session.hasScopes(CONTACTS_SCOPES) ? "granted" : "missing";

  readonly requestAccess = (): Promise<void> =>
    this.#session.requestScopes(CONTACTS_SCOPES);

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#session.subscribe(listener);

  async load(
    previous: ContactSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<ContactSnapshot> {
    const state = stateOf(previous?.token);
    const [folders, categories] = await Promise.all([
      this.#folders(signal),
      this.#categories(signal),
    ]);
    let defaultId =
      folders.find((folder) => folder.top)?.folder.parentFolderId ??
      state.defaultId;
    defaultId ??= await this.#probeDefault(signal);
    let defaultName =
      defaultId === state.defaultId ? state.defaultName : undefined;
    if (defaultId && defaultName === undefined)
      defaultName = await this.#folderName(defaultId, signal);

    const books: AddressBook[] = [
      {
        id: DEFAULT_BOOK,
        name: defaultName ?? "Contacts",
        readOnly: false,
        isDefault: true,
      },
      ...folders.map(({ folder }) => ({
        id: asAddressBookId(folder.id),
        name: folder.displayName ?? "",
        readOnly: false,
        isDefault: false,
      })),
    ];
    const before = new Map<string, Contact[]>();
    for (const contact of previous?.contacts ?? [])
      before.set(contact.addressBookId, [
        ...(before.get(contact.addressBookId) ?? []),
        contact,
      ]);

    const links: Record<string, string> = {};
    const lists = await Promise.all(
      books.map(async (book) => {
        const link = state.links[book.id];
        const { contacts, link: next } = await this.#bookContacts(
          book.id,
          book.id === DEFAULT_BOOK ? defaultId : book.id,
          previous && link !== undefined
            ? { contacts: before.get(book.id) ?? [], link }
            : undefined,
          signal,
        );
        if (next !== undefined) links[book.id] = next;
        return contacts;
      }),
    );
    const contacts = lists.flat();

    // Categories only on contacts (not in the master list) show too, without colour.
    const groups = [...categories];
    const known = new Set(groups.map((group) => group.name));
    for (const contact of contacts)
      for (const name of contact.groupIds)
        if (!known.has(name)) {
          known.add(name);
          groups.push({ id: asContactGroupId(name), name });
        }

    const next: SyncState = {
      ...(defaultId ? { defaultId } : {}),
      ...(defaultName !== undefined ? { defaultName } : {}),
      links,
    };
    return {
      addressBooks: books,
      groups,
      contacts,
      token: JSON.stringify(next),
    };
  }

  async create(
    book: AddressBookId,
    contact: NewContact,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    const created = await this.#http.post<GraphContact>(
      folderPath(book),
      bodyOf(fitted(contact.fields)),
      { retry: false, ...(signal ? { signal } : {}) },
    );
    if (contact.photo) await this.#putPhoto(created.id, contact.photo, signal);
    return this.#written(created, book);
  }

  async createMany(
    book: AddressBookId,
    contacts: readonly NewContact[],
    options: {
      readonly onProgress?: (done: number) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<readonly (ContactWrite | MailError)[]> {
    const { onProgress, signal } = options;
    const results: (ContactWrite | MailError)[] = [];
    for (let start = 0; start < contacts.length; start += BATCH_LIMIT) {
      const chunk = contacts.slice(start, start + BATCH_LIMIT);
      const answers = await this.#http.batch<GraphContact>(
        chunk.map((contact) => ({
          method: "POST",
          path: folderPath(book),
          body: bodyOf(fitted(contact.fields)),
        })),
        signal,
      );
      for (const [index, answer] of answers.entries()) {
        if (!answer.ok) {
          results.push(answer.error);
          continue;
        }
        const photo = chunk[index]?.photo;
        if (photo) await this.#putPhoto(answer.body.id, photo, signal);
        results.push(this.#written(answer.body, book));
      }
      onProgress?.(results.length);
    }
    return results;
  }

  async update(
    contact: Contact,
    fields: ContactFields,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    const before = fieldsOf(contact);
    const after = fitted(fields);
    const changed = changedFamilies(before, after);
    const updated = await this.#patch(
      contact,
      patchOf(after, changed, contact, before),
      signal,
    );
    return {
      contact: updated,
      undo: async (undoSignal) =>
        this.#patch(
          updated,
          patchOf(before, changed, updated, after),
          undoSignal,
        ),
    };
  }

  async remove(
    contacts: readonly Contact[],
    signal?: AbortSignal,
  ): Promise<ContactRemoval> {
    // Read them whole first (with what action0 doesn't show), so undo can
    // create them again as they were; photos for a few.
    const whole = await this.#http.batch<GraphContact>(
      contacts.map((contact) => ({
        method: "GET",
        path: `me/contacts/${enc(contact.id)}`,
      })),
      signal,
    );
    const photos = await Promise.all(
      contacts.map((contact) =>
        contacts.length <= MAX_PHOTOS
          ? this.photo(contact, signal).catch(() => undefined)
          : Promise.resolve(undefined),
      ),
    );

    const deletions =
      contacts.length === 1 && contacts[0]
        ? [await this.#deleteOne(contacts[0].id, signal)]
        : await this.#http.batch<undefined>(
            contacts.map((contact) => ({
              method: "DELETE",
              path: `me/contacts/${enc(contact.id)}`,
            })),
            signal,
          );
    const failed = deletions.find(
      (result): result is { ok: false; error: MailError } =>
        !result.ok && result.error.code !== "not-found",
    );
    if (failed) throw failed.error;

    return {
      undo: async (undoSignal) => {
        const again = contacts.map((contact, index) => {
          const read = whole[index];
          return {
            contact,
            body: read?.ok
              ? recreatable(read.body)
              : bodyOf(fitted(fieldsOf(contact))),
            folder: read?.ok ? read.body.parentFolderId : undefined,
            photo: photos[index],
          };
        });
        const created = await this.#http.batch<GraphContact>(
          again.map(({ contact, body, folder }) => ({
            method: "POST",
            path:
              folder !== undefined
                ? `me/contactFolders/${enc(folder)}/contacts`
                : folderPath(contact.addressBookId),
            body,
          })),
          undoSignal,
        );
        const restored: Contact[] = [];
        for (const [index, answer] of created.entries()) {
          if (!answer.ok) throw answer.error;
          const entry = again[index];
          if (!entry) continue;
          if (entry.photo)
            await this.#putPhoto(answer.body.id, entry.photo, undoSignal);
          restored.push(toContact(answer.body, entry.contact.addressBookId));
        }
        return restored;
      },
    };
  }

  async createGroup(name: string, signal?: AbortSignal): Promise<ContactGroup> {
    const displayName = name.trim();
    if (!displayName)
      throw new MailError("provider", "A category needs a name.", {
        reason: "categoryNeedsName",
      });
    try {
      const created = await this.#http.post<GraphCategory>(
        "me/outlook/masterCategories",
        { displayName, color: presetFor(displayName) },
        { retry: false, ...(signal ? { signal } : {}) },
      );
      return groupOf(created);
    } catch (error) {
      // It exists already: that's the group.
      if (!(error instanceof MailError) || error.status !== 409) throw error;
      const existing = (await this.#categories(signal)).find(
        (group) => group.name === displayName,
      );
      return (
        existing ?? { id: asContactGroupId(displayName), name: displayName }
      );
    }
  }

  async setGroupColor(
    group: ContactGroup,
    colorId: string,
    signal?: AbortSignal,
  ): Promise<GroupWrite> {
    const category = await this.#masterCategory(group, signal);
    const before = category.color ?? "none";
    const recolour = async (color: string, undoSignal?: AbortSignal) => {
      try {
        return groupOf(
          await this.#http.patch<GraphCategory>(
            `me/outlook/masterCategories/${enc(category.id)}`,
            { color },
            undoSignal,
          ),
        );
      } catch (error) {
        throw writeError(error);
      }
    };
    return {
      group: await recolour(colorId, signal),
      undo: (undoSignal) => recolour(before, undoSignal),
    };
  }

  async deleteGroup(
    group: ContactGroup,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GroupRemoval> {
    const category = await this.#masterCategory(group, options.signal);
    try {
      await this.#http.delete(
        `me/outlook/masterCategories/${enc(category.id)}`,
        options.signal,
      );
    } catch (error) {
      throw writeError(error);
    }
    return {
      // Contacts kept the name, so they're in it again.
      undo: async (signal) => {
        try {
          return groupOf(
            await this.#http.post<GraphCategory>(
              "me/outlook/masterCategories",
              {
                displayName: category.displayName,
                color: category.color ?? "none",
              },
              { retry: false, ...(signal ? { signal } : {}) },
            ),
          );
        } catch (error) {
          throw writeError(error);
        }
      },
    };
  }

  async setPhoto(
    contact: Contact,
    photo: Blob | null,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    if (!photo || !this.capabilities.photos.change)
      throw new MailError(
        "unavailable",
        photo
          ? "Outlook.com accounts can't change their contacts' photos."
          : "Outlook can't remove a contact's photo.",
      );
    const previous = await this.photo(contact, signal).catch(() => undefined);
    const after = await this.#replacePhoto(contact, photo, signal);
    return {
      contact: after,
      undo: async (undoSignal) => {
        if (!previous)
          throw new MailError(
            "unavailable",
            "Outlook can't remove a contact's photo again.",
          );
        return this.#replacePhoto(after, previous, undoSignal);
      },
    };
  }

  async photo(
    contact: Contact,
    signal?: AbortSignal,
  ): Promise<Blob | undefined> {
    try {
      const blob = await this.#http.getBlob(
        `me/contacts/${enc(contact.id)}/photo/$value`,
        signal,
      );
      return blob.size > 0 ? blob : undefined;
    } catch (error) {
      if (error instanceof MailError && error.code === "not-found")
        return undefined;
      throw error;
    }
  }

  /** The address books below the default folder, depth first. */
  async #folders(
    signal: AbortSignal | undefined,
  ): Promise<{ folder: GraphContactFolder; top: boolean }[]> {
    const top = await this.#all<GraphContactFolder>(
      "me/contactFolders",
      { $select: "id,displayName,parentFolderId", $top: 100 },
      signal,
    );
    const result: { folder: GraphContactFolder; top: boolean }[] = [];
    const visit = async (
      folders: readonly GraphContactFolder[],
      isTop: boolean,
      depth: number,
    ) => {
      for (const folder of folders) {
        result.push({ folder, top: isTop });
        if (depth >= 10) continue;
        const children = await this.#all<GraphContactFolder>(
          `me/contactFolders/${enc(folder.id)}/childFolders`,
          { $select: "id,displayName,parentFolderId", $top: 100 },
          signal,
        );
        await visit(children, false, depth + 1);
      }
    };
    await visit(top, true, 0);
    return result;
  }

  /** The user's categories; none when Outlook won't list them. */
  async #categories(signal: AbortSignal | undefined): Promise<ContactGroup[]> {
    try {
      const { value = [] } = await this.#http.get<GraphPage<GraphCategory>>(
        "me/outlook/masterCategories",
        undefined,
        signal,
      );
      return value.map(groupOf);
    } catch (error) {
      if (error instanceof MailError && error.code === "provider") return [];
      throw error;
    }
  }

  /** The default folder's id, from one of its contacts (none: unknown). */
  async #probeDefault(
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const { value = [] } = await this.#http.get<GraphPage<GraphContact>>(
      "me/contacts",
      { $top: 1, $select: "id,parentFolderId" },
      signal,
    );
    return value[0]?.parentFolderId;
  }

  /** A folder's name as Outlook shows it ("Kontakte"); none if it can't be read. */
  async #folderName(
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    try {
      const folder = await this.#http.get<GraphContactFolder>(
        `me/contactFolders/${enc(id)}`,
        { $select: "id,displayName" },
        signal,
      );
      return folder.displayName;
    } catch (error) {
      if (error instanceof MailError && fallsBack(error)) return undefined;
      throw error;
    }
  }

  /**
   * One address book's contacts: the changes since its delta link applied
   * to what was loaded before, else a new delta round, else (no folder id,
   * or Graph refuses delta) a plain listing without a link.
   */
  async #bookContacts(
    book: AddressBookId,
    folderId: string | undefined,
    since: { contacts: readonly Contact[]; link: string } | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ contacts: Contact[]; link?: string }> {
    if (since && folderId) {
      try {
        const { items, link } = await this.#round(new URL(since.link), signal);
        const byId = new Map(since.contacts.map((c) => [c.id as string, c]));
        for (const item of items) {
          if (item["@removed"]) byId.delete(item.id);
          else byId.set(item.id, toContact(item, book));
        }
        return { contacts: [...byId.values()], ...(link ? { link } : {}) };
      } catch (error) {
        if (!fallsBack(error)) throw error;
      }
    }
    if (folderId) {
      try {
        const { items, link } = await this.#round(
          this.#http.url(`me/contactFolders/${enc(folderId)}/contacts/delta`, {
            $select: SELECT,
          }),
          signal,
        );
        return {
          contacts: items
            .filter((item) => !item["@removed"])
            .map((item) => toContact(item, book)),
          ...(link ? { link } : {}),
        };
      } catch (error) {
        if (!fallsBack(error)) throw error;
      }
    }
    const items = await this.#all<GraphContact>(
      folderPath(book),
      { $select: SELECT, $top: 500 },
      signal,
    );
    return { contacts: items.map((item) => toContact(item, book)) };
  }

  /** A delta round: every page up to the delta link. */
  async #round(
    start: URL,
    signal: AbortSignal | undefined,
  ): Promise<{ items: GraphContact[]; link?: string }> {
    const items: GraphContact[] = [];
    let url: URL | undefined = start;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const answer: GraphPage<GraphContact> = await this.#http.get(
        url,
        undefined,
        signal,
        PAGE,
      );
      items.push(...(answer.value ?? []));
      const deltaLink = answer["@odata.deltaLink"];
      if (deltaLink) return { items, link: deltaLink };
      const nextLink = answer["@odata.nextLink"];
      url = nextLink ? new URL(nextLink) : undefined;
    }
    return { items };
  }

  /** Every item of a collection, following its pages. */
  async #all<T>(
    path: string,
    params: Readonly<Record<string, string | number>>,
    signal: AbortSignal | undefined,
  ): Promise<T[]> {
    const items: T[] = [];
    let url: URL | undefined = this.#http.url(path, params);
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const answer: GraphPage<T> = await this.#http.get(url, undefined, signal);
      items.push(...(answer.value ?? []));
      const nextLink = answer["@odata.nextLink"];
      url = nextLink ? new URL(nextLink) : undefined;
    }
    return items;
  }

  /** PATCHes a contact unless it changed meanwhile, and returns it as it is then. */
  async #patch(
    contact: Contact,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Contact> {
    if (Object.keys(body).length === 0) return contact;
    try {
      const updated = await this.#http.patch<GraphContact | undefined>(
        `me/contacts/${enc(contact.id)}`,
        body,
        signal,
        undefined,
        contact.version ? { "If-Match": contact.version } : undefined,
      );
      const read =
        updated ??
        (await this.#http.get<GraphContact>(
          `me/contacts/${enc(contact.id)}`,
          { $select: SELECT },
          signal,
        ));
      return toContact(read, contact.addressBookId);
    } catch (error) {
      throw writeError(error);
    }
  }

  async #deleteOne(
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<BatchResult<undefined>> {
    try {
      await this.#http.delete(`me/contacts/${enc(id)}`, signal);
      return { ok: true, body: undefined };
    } catch (error) {
      if (error instanceof MailError) return { ok: false, error };
      throw error;
    }
  }

  /** The master category behind a group (its id is the category's name). */
  async #masterCategory(
    group: ContactGroup,
    signal: AbortSignal | undefined,
  ): Promise<GraphCategory> {
    const { value = [] } = await this.#http.get<GraphPage<GraphCategory>>(
      "me/outlook/masterCategories",
      undefined,
      signal,
    );
    const found = value.find((category) => category.displayName === group.id);
    if (!found)
      throw new MailError("not-found", "This category no longer exists.", {
        status: 404,
        reason: "notACategory",
      });
    return found;
  }

  /** Puts a photo on a contact; the contact as it is afterwards. */
  async #replacePhoto(
    contact: Contact,
    photo: Blob,
    signal: AbortSignal | undefined,
  ): Promise<Contact> {
    try {
      await this.#http.putBlob(
        `me/contacts/${enc(contact.id)}/photo/$value`,
        photo.type === "image/jpeg"
          ? photo
          : new Blob([photo], { type: "image/jpeg" }),
        signal,
      );
      const graph = await this.#http.get<GraphContact>(
        `me/contacts/${enc(contact.id)}`,
        { $select: SELECT },
        signal,
      );
      return toContact(graph, contact.addressBookId);
    } catch (error) {
      throw writeError(error);
    }
  }

  /** Sets a contact's photo; a failure leaves the contact without one. */
  async #putPhoto(id: string, photo: Blob, signal: AbortSignal | undefined) {
    try {
      await this.#http.putBlob(
        `me/contacts/${enc(id)}/photo/$value`,
        photo,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  /** A created contact, with undo deleting it. */
  #written(created: GraphContact, book: AddressBookId): ContactWrite {
    return {
      contact: toContact(created, book),
      undo: async (signal) => {
        const result = await this.#deleteOne(created.id, signal);
        if (!result.ok && result.error.code !== "not-found") throw result.error;
        return undefined;
      },
    };
  }
}

/** Where an address book's contacts are listed and created. */
function folderPath(book: AddressBookId): string {
  return book === DEFAULT_BOOK
    ? "me/contacts"
    : `me/contactFolders/${enc(book)}/contacts`;
}

function stateOf(token: string | undefined): SyncState {
  if (!token) return { links: {} };
  try {
    const parsed = JSON.parse(token) as Partial<SyncState>;
    return {
      ...(typeof parsed.defaultId === "string"
        ? { defaultId: parsed.defaultId }
        : {}),
      ...(typeof parsed.defaultName === "string"
        ? { defaultName: parsed.defaultName }
        : {}),
      links:
        parsed.links && typeof parsed.links === "object" ? parsed.links : {},
    };
  } catch {
    return { links: {} };
  }
}

/**
 * Whether a failed request means "do it the plain way" (an expired delta
 * link, delta refused) rather than a failure to report (no permission,
 * offline, throttled).
 */
function fallsBack(error: unknown): boolean {
  return (
    error instanceof MailError &&
    (error.code === "provider" || error.code === "not-found")
  );
}

/** A write's failure in the app's words: changed elsewhere, or gone. */
function writeError(error: unknown): unknown {
  if (!(error instanceof MailError)) return error;
  if (
    error.status === 412 ||
    (error.status === 409 &&
      graphErrorCode(error) === "ErrorIrresolvableConflict")
  )
    return new MailError(
      "provider",
      "The contact was changed somewhere else.",
      { status: error.status, cause: error, reason: "contactChanged" },
    );
  if (error.code === "not-found")
    return new MailError("not-found", "The contact no longer exists.", {
      status: error.status ?? 404,
      cause: error,
      reason: "contactGone",
    });
  return error;
}

function groupOf(category: GraphCategory): ContactGroup {
  const color = colorOfPreset(category.color)?.background;
  return {
    id: asContactGroupId(category.displayName),
    name: category.displayName,
    ...(color && category.color ? { color, colorId: category.color } : {}),
  };
}

/** One of Outlook's colours for a new category, by its name. */
function presetFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `preset${String(hash % 25)}`;
}

/** The fields as Outlook can keep them. */
function fitted(fields: ContactFields): ContactFields {
  return normalized(fitTo(GRAPH_CONTACT_CAPABILITIES, fields).fields);
}

const text = (value: string | null | undefined) => (value ?? "").trim();

/** A Graph contact as action0's. Its photo is fetched on demand. */
export function toContact(graph: GraphContact, book: AddressBookId): Contact {
  const address = (
    value: GraphPhysicalAddress | null | undefined,
    kind: ValueKind,
  ): PostalAddress[] => {
    const parts = {
      street: text(value?.street),
      city: text(value?.city),
      region: text(value?.state),
      postalCode: text(value?.postalCode),
      country: text(value?.countryOrRegion),
    };
    return Object.values(parts).some(Boolean) ? [{ ...parts, kind }] : [];
  };
  const birthday = birthdayOf(graph.birthday);
  const homePage = text(graph.businessHomePage);
  const version =
    graph["@odata.etag"] ??
    (graph.changeKey ? `W/"${graph.changeKey}"` : undefined);
  return {
    id: asContactId(graph.id),
    addressBookId: book,
    displayName: text(graph.displayName),
    name: {
      given: text(graph.givenName),
      middle: text(graph.middleName),
      family: text(graph.surname),
    },
    nickname: text(graph.nickName),
    emails: (graph.emailAddresses ?? [])
      .map((email) => text(email.address))
      .filter(Boolean)
      .map((value) => ({ value, kind: "other" as const })),
    phones: [
      ...(text(graph.mobilePhone)
        ? [{ value: text(graph.mobilePhone), kind: "mobile" as const }]
        : []),
      ...(graph.homePhones ?? [])
        .map(text)
        .filter(Boolean)
        .map((value) => ({ value, kind: "home" as const })),
      ...(graph.businessPhones ?? [])
        .map(text)
        .filter(Boolean)
        .map((value) => ({ value, kind: "work" as const })),
    ],
    organization: {
      company: text(graph.companyName),
      title: text(graph.jobTitle),
      department: text(graph.department),
    },
    addresses: [
      ...address(graph.homeAddress, "home"),
      ...address(graph.businessAddress, "work"),
      ...address(graph.otherAddress, "other"),
    ],
    ...(birthday ? { birthday } : {}),
    websites: homePage ? [{ value: homePage, kind: "work" }] : [],
    notes: graph.personalNotes ?? "",
    groupIds: (graph.categories ?? []).map(asContactGroupId),
    // Graph has no "has a photo" flag: ask when it's shown.
    photo: { kind: "fetch" },
    ...(version ? { version } : {}),
  };
}

/**
 * A birthday from Outlook's date and time. Outlook keeps it at midnight of
 * the day in the time zone it was entered in (or at noon), so the nearest
 * whole day in UTC is the day meant.
 */
export function birthdayOf(
  value: string | null | undefined,
): Birthday | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  const day = new Date(time + 12 * 3_600_000);
  return {
    year: day.getUTCFullYear(),
    month: day.getUTCMonth() + 1,
    day: day.getUTCDate(),
  };
}

/** A birthday as Outlook keeps it: just before noon UTC, the same day everywhere near. */
export function graphBirthday(birthday: Birthday | undefined): string | null {
  if (birthday?.year === undefined) return null;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(birthday.year, 4)}-${pad(birthday.month)}-${pad(birthday.day)}T11:59:00Z`;
}

const graphAddress = (address: PostalAddress | undefined) => ({
  street: address?.street ?? "",
  city: address?.city ?? "",
  state: address?.region ?? "",
  postalCode: address?.postalCode ?? "",
  countryOrRegion: address?.country ?? "",
});

/** The Graph properties of some families of fields. */
function propertiesOf(
  fields: ContactFields,
  families: ReadonlySet<Family>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const name = displayNameOf(fields);
  const orNull = (value: string) => value.trim() || null;
  if (families.has("name")) {
    body.givenName = orNull(fields.name.given);
    body.middleName = orNull(fields.name.middle);
    body.surname = orNull(fields.name.family);
  }
  if (families.has("nickname")) body.nickName = orNull(fields.nickname);
  if (families.has("emails") || families.has("name"))
    body.emailAddresses = fields.emails.map((email) => ({
      address: email.value,
      name: name || email.value,
    }));
  if (families.has("phones")) {
    body.mobilePhone =
      fields.phones.find((phone) => phone.kind === "mobile")?.value ?? null;
    body.homePhones = fields.phones
      .filter((phone) => phone.kind === "home")
      .map((phone) => phone.value);
    body.businessPhones = fields.phones
      .filter((phone) => phone.kind === "work")
      .map((phone) => phone.value);
  }
  if (families.has("organization")) {
    body.companyName = orNull(fields.organization.company);
    body.jobTitle = orNull(fields.organization.title);
    body.department = orNull(fields.organization.department);
  }
  if (families.has("addresses")) {
    const of = (kind: ValueKind) =>
      fields.addresses.find((address) => address.kind === kind);
    body.homeAddress = graphAddress(of("home"));
    body.businessAddress = graphAddress(of("work"));
    body.otherAddress = graphAddress(of("other"));
  }
  if (families.has("birthday")) body.birthday = graphBirthday(fields.birthday);
  if (families.has("websites"))
    body.businessHomePage = fields.websites[0]?.value ?? null;
  if (families.has("notes")) body.personalNotes = fields.notes;
  if (families.has("groups")) body.categories = [...fields.groupIds];
  return body;
}

/** A new contact's properties: everything, with its display name. */
function bodyOf(fields: ContactFields): Record<string, unknown> {
  return {
    ...propertiesOf(fields, new Set(FAMILIES)),
    displayName: displayNameOf(fields),
  };
}

/**
 * The properties that change from `before` to `fields`, with a new display
 * name when the name changed or the old one was only made from the fields.
 */
function patchOf(
  fields: ContactFields,
  changed: ReadonlySet<Family>,
  contact: Contact,
  before: ContactFields,
): Record<string, unknown> {
  const body = propertiesOf(fields, changed);
  const made =
    !contact.displayName || contact.displayName === displayNameOf(before);
  if (
    changed.has("name") ||
    (made && displayNameOf(fields) !== displayNameOf(before))
  )
    body.displayName = displayNameOf(fields);
  return body;
}

/** The families whose values differ. */
function changedFamilies(
  before: ContactFields,
  after: ContactFields,
): Set<Family> {
  const a = normalized(fitTo(GRAPH_CONTACT_CAPABILITIES, before).fields);
  const b = normalized(after);
  const same = (x: unknown, y: unknown) =>
    JSON.stringify(x) === JSON.stringify(y);
  const kindless = (fields: ContactFields) =>
    fields.emails.map((email) => email.value.toLowerCase());
  const changed = new Set<Family>();
  if (!same(a.name, b.name)) changed.add("name");
  if (a.nickname !== b.nickname) changed.add("nickname");
  if (!same(kindless(a), kindless(b))) changed.add("emails");
  if (!same(a.phones, b.phones)) changed.add("phones");
  if (!same(a.organization, b.organization)) changed.add("organization");
  if (!same(a.addresses, b.addresses)) changed.add("addresses");
  if (!same(a.birthday, b.birthday)) changed.add("birthday");
  if (
    !same(
      a.websites.map((w) => w.value),
      b.websites.map((w) => w.value),
    )
  )
    changed.add("websites");
  if (a.notes !== b.notes) changed.add("notes");
  if (!same(a.groupIds, b.groupIds)) changed.add("groups");
  return changed;
}

/** A contact read whole, without what Graph sets itself, to create it again. */
function recreatable(graph: GraphContact): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(graph).filter(
      ([key, value]) =>
        !READ_ONLY.has(key) && !key.startsWith("@") && value !== null,
    ),
  );
}
