import {
  asContactGroupId,
  asContactId,
  displayNameOf,
  type AddressBook,
  type AddressBookId,
  type Contact,
  type ContactCapabilities,
  type ContactFields,
  type ContactGroup,
  type ContactRemoval,
  type ContactsAccess,
  type ContactSnapshot,
  type ContactsProvider,
  type ContactWrite,
  type NewContact,
} from "../../core/contacts";
import { MailError } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import { sleep } from "../../lib/sleep";

/** In-memory contacts of a demo account. */
export interface FakeContactsData {
  /** Google-like (labels, Other contacts) or Outlook-like (folders, categories, limits). */
  readonly flavor: "google" | "outlook";
  readonly addressBooks: readonly AddressBook[];
  readonly groups: readonly ContactGroup[];
  readonly contacts: readonly Contact[];
  readonly other?: readonly Contact[];
  /** Pictures of contacts whose photo is `fetch`, by contact id. */
  readonly photos?: ReadonlyMap<string, Blob>;
}

export interface FakeContactsProviderOptions {
  /** Simulated latency per call. */
  readonly latencyMs?: number;
  /** Access as if the account hadn't allowed it (tests). */
  readonly access?: ContactsAccess;
}

const GOOGLE: ContactCapabilities = {
  emailKinds: true,
  phoneKinds: ["mobile", "home", "work", "other"],
  addressKinds: ["home", "work", "other"],
  oneAddressPerKind: false,
  websiteKinds: true,
  birthdayYear: false,
  groups: true,
  otherContacts: true,
};

const OUTLOOK: ContactCapabilities = {
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
  otherContacts: false,
};

/** Contacts of a demo account, kept "on the server" in memory. */
export class FakeContactsProvider implements ContactsProvider {
  readonly capabilities: ContactCapabilities;
  readonly setup = "consent" as const;
  readonly #latencyMs: number;
  readonly #emitter = new Emitter();
  readonly #books: readonly AddressBook[];
  #access: ContactsAccess;
  #groups: readonly ContactGroup[];
  #contacts: readonly Contact[];
  #other: readonly Contact[];
  readonly #photos: Map<string, Blob>;
  #nextId = 1;
  #revision = 1;
  /** Set to make every change fail (tests). */
  failWrites = false;
  /** How often {@link load} ran (tests). */
  loads = 0;

  constructor(
    data: FakeContactsData,
    options: FakeContactsProviderOptions = {},
  ) {
    this.capabilities = data.flavor === "google" ? GOOGLE : OUTLOOK;
    this.#books = data.addressBooks;
    this.#groups = data.groups;
    this.#contacts = data.contacts;
    this.#other = data.other ?? [];
    this.#photos = new Map(data.photos);
    this.#latencyMs = options.latencyMs ?? 0;
    this.#access = options.access ?? "granted";
  }

  readonly access = (): ContactsAccess => this.#access;

  readonly requestAccess = async (): Promise<void> => {
    await this.#delay();
    this.#access = "granted";
    this.#emitter.emit();
  };

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#emitter.subscribe(listener);

  async load(
    _previous: ContactSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<ContactSnapshot> {
    await this.#delay(signal);
    this.loads++;
    if (this.#access === "missing")
      throw new MailError("unavailable", "Contacts aren't allowed.", {
        reason: "contactsAccessNeeded",
      });
    return {
      addressBooks: this.#books,
      groups: this.#groups,
      contacts: this.#contacts,
      ...(this.capabilities.otherContacts ? { other: this.#other } : {}),
      token: String(this.#revision),
    };
  }

  async create(
    book: AddressBookId,
    contact: NewContact,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    await this.#refuseIfFailing(signal);
    return this.#create(book, contact);
  }

  async createMany(
    book: AddressBookId,
    contacts: readonly NewContact[],
    options: {
      readonly onProgress?: (done: number) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<readonly (ContactWrite | MailError)[]> {
    await this.#refuseIfFailing(options.signal);
    return contacts.map((contact, index) => {
      const write = this.#create(book, contact);
      options.onProgress?.(index + 1);
      return write;
    });
  }

  async update(
    contact: Contact,
    fields: ContactFields,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    await this.#refuseIfFailing(signal);
    const before = this.#find(contact);
    if (before.version !== contact.version)
      throw new MailError("provider", "The contact was changed.", {
        status: 412,
        reason: "contactChanged",
      });
    const after = this.#write(before, fields);
    return {
      contact: after,
      undo: async (undoSignal) => {
        await this.#refuseIfFailing(undoSignal);
        return this.#write(this.#find(after), before);
      },
    };
  }

  async remove(
    contacts: readonly Contact[],
    signal?: AbortSignal,
  ): Promise<ContactRemoval> {
    await this.#refuseIfFailing(signal);
    const removed = contacts.map((contact) => this.#find(contact));
    const ids = new Set(removed.map((contact) => contact.id));
    this.#contacts = this.#contacts.filter((contact) => !ids.has(contact.id));
    this.#revision++;
    return {
      undo: async (undoSignal) => {
        await this.#refuseIfFailing(undoSignal);
        // Like Google and Outlook: back as new contacts.
        return removed.map((contact) => {
          const photo = this.#photos.get(contact.id);
          return this.#create(contact.addressBookId, {
            fields: contact,
            ...(photo ? { photo } : {}),
          }).contact;
        });
      },
    };
  }

  async createGroup(name: string, signal?: AbortSignal): Promise<ContactGroup> {
    await this.#refuseIfFailing(signal);
    const group = {
      id: asContactGroupId(`g${String(this.#nextId++)}`),
      name: name.trim(),
    };
    this.#groups = [...this.#groups, group];
    this.#revision++;
    return group;
  }

  async addOther(
    contact: Contact,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    await this.#refuseIfFailing(signal);
    const other = this.#other.find((candidate) => candidate.id === contact.id);
    if (!other)
      throw new MailError("not-found", "No such contact.", {
        status: 404,
        reason: "contactGone",
      });
    this.#other = this.#other.filter((candidate) => candidate !== other);
    const { other: _other, ...rest } = other;
    const added: Contact = {
      ...rest,
      id: asContactId(`c${String(this.#nextId++)}`),
      addressBookId: this.#defaultBook(),
      version: "1",
    };
    this.#contacts = [...this.#contacts, added];
    this.#revision++;
    return {
      contact: added,
      undo: async (undoSignal) => {
        await this.#refuseIfFailing(undoSignal);
        this.#contacts = this.#contacts.filter((c) => c.id !== added.id);
        this.#other = [...this.#other, other];
        this.#revision++;
        return undefined;
      },
    };
  }

  async photo(
    contact: Contact,
    signal?: AbortSignal,
  ): Promise<Blob | undefined> {
    await this.#delay(signal);
    if (contact.photo?.kind === "url") {
      const response = await fetch(contact.photo.url);
      return response.blob();
    }
    return this.#photos.get(contact.id);
  }

  #create(book: AddressBookId, contact: NewContact): ContactWrite {
    const id = asContactId(`c${String(this.#nextId++)}`);
    const created: Contact = {
      ...normalizeFor(this.capabilities, contact.fields),
      id,
      addressBookId: book,
      displayName: displayNameOf(contact.fields),
      version: "1",
      ...(contact.photo ? { photo: { kind: "fetch" as const } } : {}),
    };
    if (contact.photo) this.#photos.set(id, contact.photo);
    this.#contacts = [...this.#contacts, created];
    this.#revision++;
    return {
      contact: created,
      undo: async (signal) => {
        await this.#refuseIfFailing(signal);
        this.#contacts = this.#contacts.filter((c) => c.id !== id);
        this.#revision++;
        return undefined;
      },
    };
  }

  /** Writes the fields into the stored contact, with a new version. */
  #write(contact: Contact, fields: ContactFields): Contact {
    const next: Contact = {
      ...contact,
      ...normalizeFor(this.capabilities, fields),
      displayName: displayNameOf(fields),
      version: String(Number(contact.version ?? "0") + 1),
    };
    if (!fields.birthday) {
      const { birthday: _birthday, ...rest } = next;
      return this.#replace(rest);
    }
    return this.#replace(next);
  }

  #replace(contact: Contact): Contact {
    this.#contacts = this.#contacts.map((candidate) =>
      candidate.id === contact.id ? contact : candidate,
    );
    this.#revision++;
    return contact;
  }

  #find(contact: Contact): Contact {
    const found = this.#contacts.find(
      (candidate) => candidate.id === contact.id,
    );
    if (!found)
      throw new MailError("not-found", "No such contact.", {
        status: 404,
        reason: "contactGone",
      });
    return found;
  }

  #defaultBook(): AddressBookId {
    const book =
      this.#books.find((candidate) => candidate.isDefault) ?? this.#books[0];
    if (!book) throw new Error("The demo has no address book.");
    return book.id;
  }

  async #delay(signal?: AbortSignal) {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs, signal);
    signal?.throwIfAborted();
  }

  async #refuseIfFailing(signal?: AbortSignal) {
    await this.#delay(signal);
    if (this.failWrites)
      throw new MailError("provider", "The demo server refused the change.", {
        status: 500,
        reason: "demoRefused",
      });
    if (this.#access !== "granted")
      throw new MailError("unavailable", "Changing contacts isn't allowed.", {
        status: 403,
        reason: "contactsAccessNeeded",
      });
  }
}

/** The fields without what the flavour can't hold (Outlook's email kinds). */
function normalizeFor(
  capabilities: ContactCapabilities,
  fields: ContactFields,
): ContactFields {
  return capabilities.emailKinds
    ? fields
    : {
        ...fields,
        emails: fields.emails.map(({ value }) => ({ value, kind: "other" })),
      };
}
