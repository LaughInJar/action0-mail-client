import {
  asAddressBookId,
  asContactGroupId,
  asContactId,
  type AddressBook,
  type AddressBookId,
  type Contact,
  type ContactCapabilities,
  type ContactFields,
  type ContactGroup,
  type ContactGroupId,
  type ContactRemoval,
  type ContactsAccess,
  type ContactSnapshot,
  type ContactsProvider,
  type ContactWrite,
  type GroupRemoval,
  type GroupWrite,
  type NewContact,
  type ProgressOptions,
} from "../../core/contacts";
import { isMailError, MailError } from "../../core/errors";
import { loadIcal, type Ical } from "../ical/icalendar";
import {
  cardPhotoOf,
  editCard,
  newCard,
  photoBlob,
  photoUrl,
  readCard,
  storableCard,
  type ReadCard,
} from "../vcard/vcard";
import type { AddressBookEntry, CardDavAddressBooks } from "./contacts";
import { sameUrl } from "./dav";
import type { CalendarServerList } from "./servers";

/** A vCard can hold all of it. */
const CAPABILITIES: ContactCapabilities = {
  emailKinds: true,
  phoneKinds: ["mobile", "home", "work", "other"],
  addressKinds: ["home", "work", "other"],
  oneAddressPerKind: false,
  websiteKinds: true,
  birthdayYear: false,
  groups: true,
  renameGroups: true,
  // A category exists only on the cards that have it.
  emptyGroups: false,
  photos: { change: true, remove: true },
  otherContacts: false,
};

/** Contacts created (or rewritten) at the same time. */
const PARALLEL_CREATES = 4;

export interface CardDavContactsOptions {
  /** The login's address books (shared with its address suggestions). */
  readonly books: CardDavAddressBooks;
  readonly servers: CalendarServerList;
  readonly now?: () => number;
  /** New cards' UIDs (tests). */
  readonly uid?: () => string;
}

/**
 * The contacts of a CardDAV login (a mail server account's calendar
 * server, or a calendar-only one): every address book under its home,
 * read from the books' stores. Writes are conditional (`If-Match`,
 * `If-None-Match: *`); a change made elsewhere meanwhile reloads the book
 * and fails as `contactChanged`. Groups are the cards' CATEGORIES.
 */
export class CardDavContactsProvider implements ContactsProvider {
  readonly capabilities = CAPABILITIES;
  readonly setup = "server" as const;
  readonly #books: CardDavAddressBooks;
  readonly #servers: CalendarServerList;
  readonly #now: () => number;
  readonly #uid: () => string;
  /** Cards read, by object URL, with the ETag they were read at. */
  readonly #read = new Map<
    string,
    { readonly etag: string | undefined; readonly card: ReadCard | undefined }
  >();

  constructor(options: CardDavContactsOptions) {
    this.#books = options.books;
    this.#servers = options.servers;
    this.#now = options.now ?? Date.now;
    this.#uid = options.uid ?? (() => crypto.randomUUID());
  }

  /**
   * Granted once the login has an address book home (or might: a server
   * set up before address books were looked for is checked on load).
   */
  readonly access = (): ContactsAccess => {
    const info = this.#servers.info(this.#books.key);
    return info && (info.contacts !== undefined || !info.contactsChecked)
      ? "granted"
      : "missing";
  };

  /** Address books come with a calendar server, set up in its dialog. */
  readonly requestAccess = (): Promise<void> =>
    Promise.reject(
      new MailError("unavailable", "Set up the calendar server first.", {
        reason: "contactsAccessNeeded",
      }),
    );

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#servers.subscribe(listener);

  async load(
    _previous: ContactSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<ContactSnapshot> {
    const books = await this.#books.books(signal, true);
    await Promise.all(books.map((book) => this.#sync(book, signal)));
    const ICAL = await loadIcal();
    const contacts: Contact[] = [];
    const groups = new Set<string>();
    for (const book of books)
      for (const object of book.store.objects()) {
        const card = this.#cardOf(ICAL, object.url, object.etag, object.text);
        if (!card || card.isGroup) continue;
        contacts.push(contactOf(book, object.url, object.etag, card));
        for (const group of card.fields.groupIds) groups.add(group);
      }
    const defaultBook = books.find((book) => !book.readOnly);
    return {
      addressBooks: books.map((book): AddressBook => ({
        id: asAddressBookId(book.url),
        name: book.name,
        readOnly: book.readOnly,
        isDefault: book === defaultBook,
      })),
      groups: [...groups]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ id: asContactGroupId(name), name })),
      contacts,
    };
  }

  async create(
    book: AddressBookId,
    contact: NewContact,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    const entry = await this.#writableBook(book, signal);
    return this.#create(await loadIcal(), entry, contact, signal);
  }

  async createMany(
    book: AddressBookId,
    contacts: readonly NewContact[],
    options: {
      readonly onProgress?: (done: number) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<readonly (ContactWrite | MailError)[]> {
    const { signal } = options;
    const entry = await this.#writableBook(book, signal);
    const ICAL = await loadIcal();
    const results: (ContactWrite | MailError)[] = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < contacts.length) {
        const index = next++;
        const contact = contacts[index];
        if (!contact) continue;
        signal?.throwIfAborted();
        try {
          results[index] = await this.#create(ICAL, entry, contact, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          results[index] = asMailError(error);
        }
        options.onProgress?.(++done);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PARALLEL_CREATES, contacts.length) },
        worker,
      ),
    );
    return results;
  }

  async update(
    contact: Contact,
    fields: ContactFields,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    const entry = await this.#writableBook(contact.addressBookId, signal);
    const object = await this.#current(entry, contact, signal);
    const ICAL = await loadIcal();
    const text = editCard(ICAL, object.text, fields, { now: this.#now() });
    return this.#rewrite(ICAL, entry, object, text, signal);
  }

  async setPhoto(
    contact: Contact,
    photo: Blob | null,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    const entry = await this.#writableBook(contact.addressBookId, signal);
    const object = await this.#current(entry, contact, signal);
    const ICAL = await loadIcal();
    const card = readCard(ICAL, object.text);
    if (!card) throw gone();
    const text = editCard(ICAL, object.text, card.fields, {
      now: this.#now(),
      photo: photo ? await cardPhotoOf(photo) : null,
    });
    return this.#rewrite(ICAL, entry, object, text, signal);
  }

  /** A category is renamed on every card that has it. */
  async renameGroup(
    group: ContactGroup,
    name: string,
    options: ProgressOptions = {},
  ): Promise<GroupWrite> {
    const renamed = asContactGroupId(name.trim());
    if (!renamed)
      throw new MailError("provider", "A group needs a name.", {
        reason: "labelNeedsName",
      });
    const undo = await this.#rewriteGroup(
      group,
      (ids) => [...new Set(ids.map((id) => (id === group.id ? renamed : id)))],
      options,
    );
    return {
      group: { id: renamed, name: renamed },
      undo: async (signal) => {
        await undo(signal);
        return group;
      },
    };
  }

  /** A category is taken off every card that has it (the cards stay). */
  async deleteGroup(
    group: ContactGroup,
    options: ProgressOptions = {},
  ): Promise<GroupRemoval> {
    const undo = await this.#rewriteGroup(
      group,
      (ids) => ids.filter((id) => id !== group.id),
      options,
    );
    return {
      undo: async (signal) => {
        await undo(signal);
        return group;
      },
    };
  }

  /**
   * Writes a card's new text over its old one (`If-Match`); the undo puts
   * the old text back exactly.
   */
  async #rewrite(
    ICAL: Ical,
    entry: AddressBookEntry,
    object: {
      readonly url: string;
      readonly etag?: string;
      readonly text: string;
    },
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<ContactWrite> {
    if (text === object.text) {
      const same = this.#contact(ICAL, entry, object.url, object.etag, text);
      return { contact: same, undo: () => Promise.resolve(same) };
    }
    const written = await this.#put(
      entry,
      object.url,
      text,
      object.etag,
      signal,
    );
    return {
      contact: this.#contact(
        ICAL,
        entry,
        object.url,
        written.etag,
        written.text,
      ),
      undo: async (undoSignal) => {
        const latest = await this.#latestEtag(entry, object.url, undoSignal);
        const back = await this.#put(
          entry,
          object.url,
          object.text,
          latest,
          undoSignal,
        );
        return this.#contact(ICAL, entry, object.url, back.etag, back.text);
      },
    };
  }

  async remove(
    contacts: readonly Contact[],
    signal?: AbortSignal,
  ): Promise<ContactRemoval> {
    const removed: {
      readonly entry: AddressBookEntry;
      readonly url: string;
      readonly text: string;
    }[] = [];
    const restore = () =>
      Promise.all(
        removed.map(({ entry, url, text }) =>
          this.#put(entry, url, text, undefined, undefined),
        ),
      );
    try {
      for (const contact of contacts) {
        const entry = await this.#writableBook(contact.addressBookId, signal);
        const object = await this.#current(entry, contact, signal);
        await this.#delete(entry, object.url, object.etag, signal);
        removed.push({ entry, url: object.url, text: object.text });
      }
    } catch (error) {
      // Nothing half done: the ones already deleted come back.
      await restore().catch(() => undefined);
      throw error;
    }
    return {
      undo: async (undoSignal) => {
        const ICAL = await loadIcal();
        const back: Contact[] = [];
        for (const { entry, url, text } of removed) {
          const written = await this.#put(
            entry,
            url,
            text,
            undefined,
            undoSignal,
          );
          back.push(
            this.#contact(ICAL, entry, url, written.etag, written.text),
          );
        }
        return back;
      },
    };
  }

  /**
   * Changes the categories of every card (in the writable books) that has
   * `group`, a few at a time. A failure puts back the ones already changed.
   * Resolves to what undoes it all: every card's old text, put back exactly.
   */
  async #rewriteGroup(
    group: ContactGroup,
    change: (ids: readonly ContactGroupId[]) => ContactGroupId[],
    options: ProgressOptions,
  ): Promise<(signal?: AbortSignal) => Promise<void>> {
    const { signal } = options;
    const ICAL = await loadIcal();
    const books = (await this.#books.books(signal, true)).filter(
      (book) => !book.readOnly,
    );
    await Promise.all(books.map((book) => this.#sync(book, signal)));
    const targets = books.flatMap((entry) =>
      [...entry.store.objects()].flatMap((object) => {
        const card = this.#cardOf(ICAL, object.url, object.etag, object.text);
        return card && !card.isGroup && card.fields.groupIds.includes(group.id)
          ? [
              {
                entry,
                card,
                url: object.url,
                etag: object.etag,
                text: crlf(object.text),
              },
            ]
          : [];
      }),
    );
    const done: { entry: AddressBookEntry; url: string; text: string }[] = [];
    const putBack = async (undoSignal: AbortSignal | undefined) => {
      await pool(done, async ({ entry, url, text }) => {
        const latest = await this.#latestEtag(entry, url, undoSignal);
        await this.#put(entry, url, text, latest, undoSignal);
      });
    };
    options.onProgress?.(0, targets.length);
    try {
      await pool(targets, async ({ entry, card, url, etag, text }) => {
        const next = editCard(
          ICAL,
          text,
          { ...card.fields, groupIds: change(card.fields.groupIds) },
          { now: this.#now() },
        );
        await this.#put(entry, url, next, etag, signal);
        done.push({ entry, url, text });
        options.onProgress?.(done.length, targets.length);
      });
    } catch (error) {
      // Nothing half done: the cards already changed get their old text back.
      await putBack(undefined).catch(() => undefined);
      throw error;
    }
    return putBack;
  }

  /** A group is a category: it exists once a contact has it. */
  createGroup(name: string): Promise<ContactGroup> {
    const trimmed = name.trim();
    return Promise.resolve({ id: asContactGroupId(trimmed), name: trimmed });
  }

  photo(contact: Contact): Promise<Blob | undefined> {
    const url = contact.photo?.kind === "url" ? contact.photo.url : "";
    const data = /^data:([^;,]+)?;base64,(.*)$/s.exec(url);
    return Promise.resolve(
      data
        ? photoBlob({
            mediaType: data[1] ?? "image/jpeg",
            base64: data[2] ?? "",
          })
        : undefined,
    );
  }

  rawCard(contact: Contact): string | undefined {
    for (const book of this.#books.current()) {
      const object = book.store.get(contact.id);
      if (object) return crlf(object.text);
    }
    return undefined;
  }

  async #create(
    ICAL: Ical,
    entry: AddressBookEntry,
    contact: NewContact,
    signal: AbortSignal | undefined,
  ): Promise<ContactWrite> {
    const uid = this.#uid();
    const now = this.#now();
    const text = contact.card
      ? editCard(
          ICAL,
          storableCard(ICAL, contact.card, { uid, now }),
          contact.fields,
          { now },
        )
      : newCard(contact.fields, {
          uid,
          now,
          ...(contact.photo ? { photo: await cardPhotoOf(contact.photo) } : {}),
        });
    const url = `${entry.url}${encodeURIComponent(uid)}.vcf`;
    const written = await this.#put(entry, url, text, undefined, signal);
    return {
      contact: this.#contact(ICAL, entry, url, written.etag, written.text),
      undo: async (undoSignal) => {
        const latest = await this.#latestEtag(entry, url, undoSignal);
        await this.#delete(entry, url, latest, undoSignal);
        return undefined;
      },
    };
  }

  /** The book a contact goes into or is in, listed again if it's new. */
  async #writableBook(
    id: AddressBookId,
    signal: AbortSignal | undefined,
  ): Promise<AddressBookEntry> {
    const find = (books: readonly AddressBookEntry[]) =>
      books.find((book) => sameUrl(book.url, id));
    const entry =
      find(this.#books.current()) ??
      find(await this.#books.books(signal, true));
    if (!entry)
      throw new MailError("not-found", "This address book is gone.", {
        reason: "contactGone",
      });
    if (entry.readOnly) throw readOnly();
    return entry;
  }

  /**
   * The contact's object as the store has it; one that changed since the
   * contact was read (another ETag) fails as `contactChanged`.
   */
  async #current(
    entry: AddressBookEntry,
    contact: Contact,
    signal: AbortSignal | undefined,
  ) {
    let object = entry.store.get(contact.id);
    if (!object?.etag) {
      await this.#sync(entry, signal, true);
      object = entry.store.get(contact.id);
    }
    if (!object) throw gone();
    if (contact.version !== undefined && object.etag !== contact.version)
      throw changedElsewhere();
    return { ...object, text: crlf(object.text) };
  }

  /**
   * Writes a card over `etag` (`If-Match`) or as a new one. Resolves to
   * its ETag and text as the server keeps them (a server that answers
   * without an ETag is read again, so the next change can use it).
   */
  async #put(
    entry: AddressBookEntry,
    url: string,
    text: string,
    etag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly etag: string | undefined; readonly text: string }> {
    const answer = await this.#books.send(
      {
        method: "PUT",
        url,
        headers: {
          "Content-Type": "text/vcard; charset=utf-8",
          ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
        },
        body: text,
      },
      signal,
    );
    if (answer.status === 412) {
      await this.#sync(entry, signal, true);
      throw changedElsewhere();
    }
    if (answer.status < 200 || answer.status >= 300) throw httpError(answer);
    const newEtag = answer.headers.etag;
    if (newEtag) {
      entry.store.put({ url, text, etag: newEtag });
      return { etag: newEtag, text };
    }
    entry.store.put({ url, text });
    await this.#sync(entry, signal, true);
    const stored = entry.store.get(url);
    return { etag: stored?.etag, text: stored ? crlf(stored.text) : text };
  }

  async #delete(
    entry: AddressBookEntry,
    url: string,
    etag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const answer = await this.#books.send(
      { method: "DELETE", url, headers: etag ? { "If-Match": etag } : {} },
      signal,
    );
    if (answer.status === 412) {
      await this.#sync(entry, signal, true);
      throw changedElsewhere();
    }
    if (answer.status !== 404 && (answer.status < 200 || answer.status >= 300))
      throw httpError(answer);
    entry.store.forget(url);
  }

  /** The object's current ETag: as last seen, else read again. */
  async #latestEtag(
    entry: AddressBookEntry,
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const known = entry.store.get(url)?.etag;
    if (known) return known;
    await this.#sync(entry, signal, true);
    return entry.store.get(url)?.etag;
  }

  /** Brings a book's store up to date; its plain failures become `MailError`s. */
  async #sync(
    entry: AddressBookEntry,
    signal: AbortSignal | undefined,
    force = false,
  ): Promise<void> {
    try {
      await entry.store.sync(signal, force);
    } catch (error) {
      if (signal?.aborted || isMailError(error)) throw error;
      throw new MailError(
        "provider",
        `The contacts server couldn't list “${entry.name}”.`,
        { cause: error },
      );
    }
  }

  #cardOf(
    ICAL: Ical,
    url: string,
    etag: string | undefined,
    text: string,
  ): ReadCard | undefined {
    const known = this.#read.get(url);
    if (known && known.etag === etag && etag !== undefined) return known.card;
    let card: ReadCard | undefined;
    try {
      card = readCard(ICAL, text);
    } catch {
      card = undefined;
    }
    this.#read.set(url, { etag, card });
    return card;
  }

  #contact(
    ICAL: Ical,
    entry: AddressBookEntry,
    url: string,
    etag: string | undefined,
    text: string,
  ): Contact {
    const card = this.#cardOf(ICAL, url, etag, text);
    if (!card) throw gone();
    return contactOf(entry, url, etag, card);
  }
}

/**
 * Runs `work` on every item, a few at a time. After a failure no new item
 * starts; once the ones under way have settled, it rejects with the first.
 */
async function pool<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length && !failure) {
      const item = items[next++];
      if (item === undefined) continue;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_CREATES, items.length) }, worker),
  );
  if (failure) throw failure.error;
}

/**
 * A card's text with CRLF line ends, as vCards have them (the last line
 * too): address data arrives inside XML, whose parser turns them into LF,
 * and is read trimmed.
 */
function crlf(text: string): string {
  return `${text.replace(/\r\n|\r|\n/g, "\r\n").replace(/(\r\n)+$/, "")}\r\n`;
}

function contactOf(
  book: AddressBookEntry,
  url: string,
  etag: string | undefined,
  card: ReadCard,
): Contact {
  return {
    ...card.fields,
    id: asContactId(url),
    addressBookId: asAddressBookId(book.url),
    displayName: card.displayName,
    ...(etag ? { version: etag } : {}),
    ...(card.photo
      ? { photo: { kind: "url" as const, url: photoUrl(card.photo) } }
      : {}),
  };
}

function asMailError(error: unknown): MailError {
  return isMailError(error)
    ? error
    : new MailError(
        "provider",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
}

function httpError(answer: { readonly status: number }): MailError {
  if (answer.status === 404 || answer.status === 410) return gone();
  if (answer.status === 403) return readOnly();
  return new MailError(
    "provider",
    `The contacts server answered ${String(answer.status)}.`,
    { status: answer.status },
  );
}

function gone(): MailError {
  return new MailError("not-found", "This contact is gone.", {
    reason: "contactGone",
  });
}

function readOnly(): MailError {
  return new MailError("unavailable", "This address book can't be changed.", {
    status: 403,
    reason: "addressBookReadOnly",
  });
}

function changedElsewhere(): MailError {
  return new MailError("provider", "The contact was changed elsewhere.", {
    status: 412,
    reason: "contactChanged",
  });
}
