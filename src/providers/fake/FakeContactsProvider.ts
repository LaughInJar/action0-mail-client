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
  type ContactGroupId,
  type ContactPhoto,
  type ContactRemoval,
  type GroupColor,
  type GroupRemoval,
  type GroupWrite,
  type ContactsAccess,
  type ContactSnapshot,
  type ContactsProvider,
  type ContactWrite,
  type NewContact,
} from "../../core/contacts";
import { MailError } from "../../core/errors";
import { Emitter } from "../../lib/emitter";
import { OUTLOOK_CATEGORY_COLORS } from "../microsoft/folders";
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
  renameGroups: true,
  emptyGroups: true,
  photos: { change: true, remove: true },
  otherContacts: true,
};

/** Outlook's category colours, as group colours. */
const OUTLOOK_COLORS: readonly GroupColor[] = OUTLOOK_CATEGORY_COLORS.map(
  (color, index) => ({ id: `preset${String(index)}`, color: color.background }),
);

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
  renameGroups: false,
  emptyGroups: true,
  groupColors: OUTLOOK_COLORS,
  // Like a work account: photos can be set, never removed.
  photos: { change: true, remove: false },
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
    const outlook = this.capabilities.groupColors !== undefined;
    const color = this.capabilities.groupColors?.[0];
    const group: ContactGroup = {
      // Outlook's categories are known by their names.
      id: asContactGroupId(
        outlook ? name.trim() : `g${String(this.#nextId++)}`,
      ),
      name: name.trim(),
      ...(color ? { color: color.color, colorId: color.id } : {}),
    };
    this.#groups = [...this.#groups, group];
    this.#revision++;
    return group;
  }

  async renameGroup(
    group: ContactGroup,
    name: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GroupWrite> {
    await this.#refuseIfFailing(options.signal);
    if (!this.capabilities.renameGroups)
      throw new MailError("unavailable", "Categories can't be renamed.", {
        reason: "categoryRename",
      });
    const before = this.#group(group.id);
    const after = this.#putGroup({ ...before, name: name.trim() });
    return {
      group: after,
      undo: async (signal) => {
        await this.#refuseIfFailing(signal);
        return this.#putGroup(before);
      },
    };
  }

  async setGroupColor(
    group: ContactGroup,
    colorId: string,
    signal?: AbortSignal,
  ): Promise<GroupWrite> {
    await this.#refuseIfFailing(signal);
    const before = this.#group(group.id);
    const color = this.capabilities.groupColors?.find(
      (candidate) => candidate.id === colorId,
    );
    const after = this.#putGroup({
      ...before,
      ...(color ? { color: color.color, colorId: color.id } : {}),
    });
    return {
      group: after,
      undo: async (undoSignal) => {
        await this.#refuseIfFailing(undoSignal);
        return this.#putGroup(before);
      },
    };
  }

  async deleteGroup(
    group: ContactGroup,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GroupRemoval> {
    await this.#refuseIfFailing(options.signal);
    const before = this.#group(group.id);
    const outlook = this.capabilities.groupColors !== undefined;
    const members = this.#contacts
      .filter((contact) => contact.groupIds.includes(before.id))
      .map((contact) => contact.id);
    this.#groups = this.#groups.filter(
      (candidate) => candidate.id !== before.id,
    );
    // Outlook's contacts keep the category's name; Google's lose the label.
    if (!outlook) this.#setMembers(before.id, members, false);
    this.#revision++;
    return {
      undo: async (signal) => {
        await this.#refuseIfFailing(signal);
        if (outlook) {
          this.#groups = [...this.#groups, before];
          this.#revision++;
          return before;
        }
        // Like Google: a new label with the same members.
        const again: ContactGroup = {
          ...before,
          id: asContactGroupId(`g${String(this.#nextId++)}`),
        };
        this.#groups = [...this.#groups, again];
        this.#setMembers(again.id, members, true);
        this.#revision++;
        return again;
      },
    };
  }

  async setPhoto(
    contact: Contact,
    photo: Blob | null,
    signal?: AbortSignal,
  ): Promise<ContactWrite> {
    await this.#refuseIfFailing(signal);
    if (photo === null && !this.capabilities.photos.remove)
      throw new MailError("unavailable", "Photos can't be removed here.");
    const before = this.#find(contact);
    const previous = this.#photos.get(before.id);
    const after = this.#withPhoto(before, photo);
    return {
      contact: after,
      undo: async (undoSignal) => {
        await this.#refuseIfFailing(undoSignal);
        const current = this.#find(after);
        if (previous) return this.#withPhoto(current, previous);
        const { photo: _photo, ...rest } = current;
        this.#photos.delete(current.id);
        return this.#replace({
          ...rest,
          ...(before.photo ? { photo: before.photo } : {}),
          version: String(Number(current.version ?? "0") + 1),
        });
      },
    };
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

  /** The contact with this picture (`null`: none), with a new version. */
  #withPhoto(contact: Contact, photo: Blob | null): Contact {
    const { photo: _photo, ...rest } = contact;
    if (photo) this.#photos.set(contact.id, photo);
    else this.#photos.delete(contact.id);
    return this.#replace({
      ...rest,
      ...(photo ? { photo: photoOf(photo) } : {}),
      version: String(Number(contact.version ?? "0") + 1),
    });
  }

  #group(id: ContactGroupId): ContactGroup {
    const group = this.#groups.find((candidate) => candidate.id === id);
    if (!group)
      throw new MailError("not-found", "No such group.", { status: 404 });
    return group;
  }

  #putGroup(group: ContactGroup): ContactGroup {
    this.#groups = this.#groups.map((candidate) =>
      candidate.id === group.id ? group : candidate,
    );
    this.#revision++;
    return group;
  }

  /** Adds `group` to these contacts, or takes it away. */
  #setMembers(
    group: ContactGroupId,
    ids: readonly string[],
    member: boolean,
  ): void {
    const chosen = new Set(ids);
    this.#contacts = this.#contacts.map((contact) =>
      chosen.has(contact.id)
        ? {
            ...contact,
            groupIds: member
              ? [...contact.groupIds.filter((id) => id !== group), group]
              : contact.groupIds.filter((id) => id !== group),
            version: String(Number(contact.version ?? "0") + 1),
          }
        : contact,
    );
  }

  #create(book: AddressBookId, contact: NewContact): ContactWrite {
    const id = asContactId(`c${String(this.#nextId++)}`);
    const created: Contact = {
      ...normalizeFor(this.capabilities, contact.fields),
      id,
      addressBookId: book,
      displayName: displayNameOf(contact.fields),
      version: "1",
      ...(contact.photo ? { photo: photoOf(contact.photo) } : {}),
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

/** How a picture the demo keeps is shown: as an object URL where there are any. */
function photoOf(photo: Blob): ContactPhoto {
  return typeof URL.createObjectURL === "function"
    ? { kind: "url", url: URL.createObjectURL(photo) }
    : { kind: "fetch" };
}
