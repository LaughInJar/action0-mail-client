import type { MailError } from "./errors";
import type { Brand } from "./ids";

/**
 * Identifies a contact within its source (a People API resource name, a
 * Graph contact id, a vCard's URL). Opaque; only its provider reads it.
 */
export type ContactId = Brand<string, "ContactId">;
/** Identifies an address book (an Outlook contact folder, a CardDAV collection). Opaque. */
export type AddressBookId = Brand<string, "AddressBookId">;
/** Identifies a group (a Google label, an Outlook or vCard category). Opaque. */
export type ContactGroupId = Brand<string, "ContactGroupId">;

/** Brands a raw string as a {@link ContactId}. */
export const asContactId = (value: string): ContactId => value as ContactId;
/** Brands a raw string as an {@link AddressBookId}. */
export const asAddressBookId = (value: string): AddressBookId =>
  value as AddressBookId;
/** Brands a raw string as a {@link ContactGroupId}. */
export const asContactGroupId = (value: string): ContactGroupId =>
  value as ContactGroupId;

/** What an address, website or postal address is for. */
export type ValueKind = "home" | "work" | "other";
/** What a phone number is for. */
export type PhoneKind = ValueKind | "mobile";

/** A value with what it's for. */
export interface Typed<K extends string> {
  readonly value: string;
  readonly kind: K;
  /**
   * The provider's own name for a type action0 doesn't have ("Assistant",
   * "Fax"): shown instead of the kind, and kept as long as the value is.
   */
  readonly label?: string;
}

export interface PostalAddress {
  readonly street: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
  readonly kind: ValueKind;
  /** See {@link Typed.label}. */
  readonly label?: string;
}

/** A birthday; Google and vCard 4.0 allow one without a year. */
export interface Birthday {
  readonly year?: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
}

/**
 * The parts of a contact action0 shows and edits. Everything else a
 * provider keeps (prefixes, IM handles, anniversaries, custom fields) is
 * left as it is when these change. Empty text means "not set".
 */
export interface ContactFields {
  readonly name: {
    readonly given: string;
    readonly middle: string;
    readonly family: string;
  };
  readonly nickname: string;
  readonly emails: readonly Typed<ValueKind>[];
  readonly phones: readonly Typed<PhoneKind>[];
  readonly organization: {
    readonly company: string;
    readonly title: string;
    readonly department: string;
  };
  readonly addresses: readonly PostalAddress[];
  readonly birthday?: Birthday;
  readonly websites: readonly Typed<ValueKind>[];
  readonly notes: string;
  readonly groupIds: readonly ContactGroupId[];
}

/**
 * A contact's picture: an image URL the page may show as it is (the
 * provider's own, or a `data:` URL), or one to ask the provider for
 * ({@link ContactsProvider.photo}; Outlook's, which may turn out to be none).
 */
export type ContactPhoto =
  { readonly kind: "url"; readonly url: string } | { readonly kind: "fetch" };

export interface Contact extends ContactFields {
  readonly id: ContactId;
  readonly addressBookId: AddressBookId;
  /** The provider's display name; may be empty (see {@link nameOf}). */
  readonly displayName: string;
  readonly photo?: ContactPhoto;
  /**
   * The version that was read (an ETag, a change key), so a change can
   * tell whether someone else changed it meanwhile. Opaque.
   */
  readonly version?: string;
  /**
   * One of Google's "Other contacts" (people the user wrote to, saved by
   * Google): read-only, it can only be added to the contacts.
   */
  readonly other?: true;
}

export interface AddressBook {
  readonly id: AddressBookId;
  readonly name: string;
  readonly readOnly: boolean;
  /** Where new contacts go unless the user chose another one. */
  readonly isDefault: boolean;
}

/** A group of contacts: a Google label, an Outlook or vCard category. */
export interface ContactGroup {
  readonly id: ContactGroupId;
  readonly name: string;
  /** A CSS colour (Outlook categories). */
  readonly color?: string;
}

/** What a source's contacts can hold; the editor offers only that. */
export interface ContactCapabilities {
  /** Email addresses have kinds (Outlook's don't). */
  readonly emailKinds: boolean;
  readonly maxEmails?: number;
  /** The phone kinds there are (Outlook: no "other"). */
  readonly phoneKinds: readonly PhoneKind[];
  /** Most numbers of a kind (Outlook: one mobile, two home, two work). */
  readonly maxPhones?: Partial<Readonly<Record<PhoneKind, number>>>;
  /** The postal address kinds there are. */
  readonly addressKinds: readonly ValueKind[];
  /** At most one postal address per kind (Outlook). */
  readonly oneAddressPerKind: boolean;
  /** Websites have kinds (Outlook keeps one, its business page). */
  readonly websiteKinds: boolean;
  readonly maxWebsites?: number;
  /** A birthday needs a year (Outlook). */
  readonly birthdayYear: boolean;
  /** Contacts can be put into groups, and groups created. */
  readonly groups: boolean;
  /** Google's "Other contacts" are listed ({@link ContactSnapshot.other}). */
  readonly otherContacts: boolean;
}

/**
 * Whether the user let action0 at the contacts: fully, only reading
 * (Google without the write permission), or not at all (Microsoft without
 * `Contacts.ReadWrite`, a mail server without a contacts server).
 */
export type ContactsAccess = "granted" | "readOnly" | "missing";

/** Everything a source has, as loaded. */
export interface ContactSnapshot {
  readonly addressBooks: readonly AddressBook[];
  readonly groups: readonly ContactGroup[];
  /** Every contact of every address book, in no particular order. */
  readonly contacts: readonly Contact[];
  /** Google's "Other contacts" (only with `otherContacts`). */
  readonly other?: readonly Contact[];
  /**
   * Where the provider's change tracking stands (sync tokens), for the
   * next {@link ContactsProvider.load}. Opaque.
   */
  readonly token?: string;
}

/** A contact to create. */
export interface NewContact {
  readonly fields: ContactFields;
  readonly photo?: Blob;
  /**
   * The vCard it came from (an import), which a CardDAV address book stores
   * as it is, so nothing in it gets lost.
   */
  readonly card?: string;
}

/** A change that was made, and how to take it back. */
export interface ContactWrite {
  readonly contact: Contact;
  /**
   * Puts things back as they were: deletes what was created, or restores
   * the fields that were changed (resolving to the contact as it is then).
   */
  readonly undo: (signal?: AbortSignal) => Promise<Contact | undefined>;
}

/** Contacts that were deleted, and how to bring them back. */
export interface ContactRemoval {
  /**
   * Creates them again: exactly as they were where the provider can
   * (CardDAV), else as new contacts with the same fields, groups and photo.
   */
  readonly undo: (signal?: AbortSignal) => Promise<readonly Contact[]>;
}

/**
 * The contacts of one source: an account (Google Contacts, Outlook
 * contacts, a mail server's CardDAV address books) or a calendar-only
 * CardDAV server. Like {@link MailProvider} it caches nothing between
 * calls (what it loaded comes back to it in {@link load}), and rejects with
 * a {@link MailError}.
 */
export interface ContactsProvider {
  readonly capabilities: ContactCapabilities;
  /**
   * How access is given: through the account's permissions (a consent
   * popup), or by setting up a server (mail server accounts).
   */
  readonly setup?: "consent" | "server";
  readonly access: () => ContactsAccess;
  /**
   * Asks for full access (call it from a click). Rejects with `unavailable`
   * if the user declined, and for `setup: "server"`.
   */
  readonly requestAccess: () => Promise<void>;
  /** Tells when {@link access} may have changed. */
  readonly subscribe: (listener: () => void) => () => void;

  /**
   * Everything the source has. With what the last call returned, only the
   * changes since are fetched where the provider can (sync tokens).
   */
  load(
    previous: ContactSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<ContactSnapshot>;
  create(
    book: AddressBookId,
    contact: NewContact,
    signal?: AbortSignal,
  ): Promise<ContactWrite>;
  /**
   * Creates many (an import), in batches where the provider has them.
   * Each result is in the place of its contact: the write, or why that one
   * failed. Rejects only when nothing could be tried.
   */
  createMany(
    book: AddressBookId,
    contacts: readonly NewContact[],
    options?: {
      /** Called with how many are done so far. */
      readonly onProgress?: (done: number) => void;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly (ContactWrite | MailError)[]>;
  /**
   * Changes the fields that differ from `contact` (the version shown);
   * everything else stays as it is. Rejects with `contactChanged` when the
   * contact was changed elsewhere since it was read.
   */
  update(
    contact: Contact,
    fields: ContactFields,
    signal?: AbortSignal,
  ): Promise<ContactWrite>;
  remove(
    contacts: readonly Contact[],
    signal?: AbortSignal,
  ): Promise<ContactRemoval>;
  /** Creates a group (only with `groups`). */
  createGroup(name: string, signal?: AbortSignal): Promise<ContactGroup>;
  /** Adds one of the "Other contacts" to the contacts (only with `otherContacts`). */
  addOther?(contact: Contact, signal?: AbortSignal): Promise<ContactWrite>;
  /** The contact's picture, if it has one. */
  photo(contact: Contact, signal?: AbortSignal): Promise<Blob | undefined>;
  /** The contact's vCard as the server keeps it (CardDAV), for exporting it unchanged. */
  rawCard?(contact: Contact): string | undefined;
}

/** A contact read from a vCard file. */
export interface ParsedCard {
  /** Its fields; `groupIds` is empty (see {@link groups}). */
  readonly fields: ContactFields;
  /** The card's own display name (FN). */
  readonly displayName: string;
  /** Its categories, by name. */
  readonly groups: readonly string[];
  readonly photo?: Blob;
  /** It has details outside {@link ContactFields} (IM handles, anniversaries, …). */
  readonly more: boolean;
  /** The card itself, as vCard 3.0 or 4.0 (a 2.1 card converted). */
  readonly card: string;
}

/** A contact to write into a vCard file. */
export interface CardToWrite {
  readonly fields: ContactFields;
  readonly displayName: string;
  /** Its groups, by name. */
  readonly groups: readonly string[];
  readonly photo?: Blob;
  /** The card as its server keeps it (CardDAV): written as it is. */
  readonly raw?: string;
}

/** Reading and writing vCard files (import and export). */
export interface ContactCards {
  /** The cards in a .vcf file (vCard 2.1, 3.0 and 4.0); unreadable ones are skipped. */
  readonly parse: (text: string) => Promise<readonly ParsedCard[]>;
  /** One .vcf file (vCard 3.0) with these contacts. */
  readonly format: (cards: readonly CardToWrite[]) => Promise<string>;
}

/** A contact with nothing filled in. */
export const EMPTY_FIELDS: ContactFields = {
  name: { given: "", middle: "", family: "" },
  nickname: "",
  emails: [],
  phones: [],
  organization: { company: "", title: "", department: "" },
  addresses: [],
  websites: [],
  notes: "",
  groupIds: [],
};

/** Lower case without accents ("Jürgen" → "jurgen"). */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** The folded words of a text ("Anna-Maria Öz" → anna, maria, oz). */
export function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The full name from its parts ("Anna Maria Berger"). */
export function fullNameOf(fields: ContactFields): string {
  const { given, middle, family } = fields.name;
  return [given, middle, family]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * The name a new or changed contact is shown under: its full name, else
 * its nickname, company or first address.
 */
export function displayNameOf(fields: ContactFields): string {
  return (
    fullNameOf(fields) ||
    fields.nickname.trim() ||
    fields.organization.company.trim() ||
    fields.emails[0]?.value.trim() ||
    fields.phones[0]?.value.trim() ||
    ""
  );
}

/** The name a contact is listed under (empty only for an empty contact). */
export function nameOf(contact: Contact): string {
  return contact.displayName.trim() || displayNameOf(contact);
}

/** Up to two initials ("Anna Berger" → "AB", "anna@x" → "A"). */
export function initialsOf(name: string): string {
  const parts = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter((part) => /\p{L}|\p{N}/u.test(part));
  const first = parts[0]?.match(/\p{L}|\p{N}/u)?.[0] ?? "";
  const last =
    parts.length > 1 ? (parts.at(-1)?.match(/\p{L}|\p{N}/u)?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** The letter a contact is listed under ("#" for anything but a letter). */
export function letterOf(name: string): string {
  const first = fold(name.trim()).charAt(0);
  return /\p{L}/u.test(first) ? first.toUpperCase() : "#";
}

/**
 * Whether the contact matches a search: every word of the query starts a
 * word of its name, nickname, company or an address, or (digits only)
 * appears in a phone number.
 */
export function matchesSearch(contact: Contact, query: string): boolean {
  const needles = words(query);
  if (needles.length === 0) return true;
  const haystack = [
    ...words(nameOf(contact)),
    ...words(fullNameOf(contact)),
    ...words(contact.nickname),
    ...words(contact.organization.company),
    ...contact.emails.flatMap((email) => [
      fold(email.value),
      ...words(email.value),
    ]),
  ];
  const phones = contact.phones.map((phone) => digitsOf(phone.value));
  return needles.every(
    (needle) =>
      haystack.some((word) => word.startsWith(needle)) ||
      (/^\d{3,}$/.test(needle) &&
        phones.some((phone) => phone.includes(needle))),
  );
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

/**
 * A phone number reduced so that ways of writing it compare equal
 * ("+43 664 123 4567" and "0664 1234567"): its last nine digits.
 * Undefined for numbers too short to say.
 */
export function phoneKey(value: string): string | undefined {
  const digits = digitsOf(value);
  return digits.length >= 7 ? digits.slice(-9) : undefined;
}

/** Why contacts were found to be the same person. */
export type DuplicateReason = "email" | "phone" | "name";

/** Contacts that look like the same person. */
export interface DuplicateGroup {
  /** The most complete one first (it's what the others merge into). */
  readonly contacts: readonly Contact[];
  /** The strongest thing they share. */
  readonly reason: DuplicateReason;
}

/**
 * Contacts that look like the same person: sharing an address, a phone
 * number or a full name of two words or more. Contacts are grouped
 * transitively; "Other contacts" are never part of it.
 */
export function findDuplicates(contacts: readonly Contact[]): DuplicateGroup[] {
  const own = contacts.filter((contact) => !contact.other);
  const parent = own.map((_, index) => index);
  const root = (index: number): number => {
    let at = index;
    while (parent[at] !== at) at = parent[at] ?? at;
    return at;
  };
  const strength: Record<DuplicateReason, number> = {
    email: 3,
    phone: 2,
    name: 1,
  };
  const reasons = new Map<number, DuplicateReason>();
  const join = (a: number, b: number, reason: DuplicateReason) => {
    const [ra, rb] = [root(a), root(b)];
    const best = [reasons.get(ra), reasons.get(rb), reason]
      .filter((r): r is DuplicateReason => r !== undefined)
      .reduce((x, y) => (strength[y] > strength[x] ? y : x));
    if (ra !== rb) parent[rb] = ra;
    reasons.set(ra, best);
  };
  const byKey = (
    reason: DuplicateReason,
    keysOf: (contact: Contact) => readonly string[],
  ) => {
    const first = new Map<string, number>();
    own.forEach((contact, index) => {
      for (const key of new Set(keysOf(contact))) {
        const seen = first.get(key);
        if (seen === undefined) first.set(key, index);
        else join(seen, index, reason);
      }
    });
  };
  byKey("email", (contact) =>
    contact.emails.map((email) => email.value.trim().toLowerCase()),
  );
  byKey("phone", (contact) =>
    contact.phones.flatMap((phone) => phoneKey(phone.value) ?? []),
  );
  byKey("name", (contact) => {
    const name = words(fullNameOf(contact) || contact.displayName);
    return name.length >= 2 ? [name.join(" ")] : [];
  });
  const groups = new Map<number, Contact[]>();
  own.forEach((contact, index) => {
    const at = root(index);
    groups.set(at, [...(groups.get(at) ?? []), contact]);
  });
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([at, members]) => ({
      contacts: [...members].sort((a, b) => completeness(b) - completeness(a)),
      reason: reasons.get(at) ?? "name",
    }));
}

/** How much a contact holds (filled fields and values; a photo counts too). */
export function completeness(contact: ContactFields & { photo?: unknown }) {
  const texts = [
    contact.name.given,
    contact.name.middle,
    contact.name.family,
    contact.nickname,
    contact.organization.company,
    contact.organization.title,
    contact.organization.department,
    contact.notes,
  ].filter((text) => text.trim()).length;
  return (
    texts +
    contact.emails.length +
    contact.phones.length +
    contact.addresses.length +
    contact.websites.length +
    (contact.birthday ? 1 : 0) +
    (contact.photo ? 1 : 0)
  );
}

const addressKey = (address: PostalAddress) =>
  words(
    [
      address.street,
      address.postalCode,
      address.city,
      address.region,
      address.country,
    ].join(" "),
  ).join(" ");

/** Adds the values of `extra` that `list` doesn't have yet (by `key`). */
function union<T>(
  list: readonly T[],
  extra: readonly T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set(list.map(key));
  const result = [...list];
  for (const item of extra) {
    const at = key(item);
    if (at && !seen.has(at)) {
      seen.add(at);
      result.push(item);
    }
  }
  return result;
}

/**
 * One contact out of several: `base` keeps what it has, and gets every
 * value of the others it doesn't have yet (addresses, numbers, groups);
 * empty fields are filled from the first that has them, and notes are
 * joined. Never overwrites.
 */
export function mergeFields(
  base: ContactFields,
  others: readonly ContactFields[],
): ContactFields {
  return others.reduce<ContactFields>((merged, other) => {
    const text = (mine: string, theirs: string) =>
      mine.trim() ? mine : theirs;
    const notes =
      !other.notes.trim() || merged.notes.includes(other.notes.trim())
        ? merged.notes
        : merged.notes.trim()
          ? `${merged.notes.trim()}\n\n${other.notes.trim()}`
          : other.notes;
    const named = Boolean(fullNameOf(merged));
    return {
      name: named ? merged.name : other.name,
      nickname: text(merged.nickname, other.nickname),
      emails: union(merged.emails, other.emails, (email) =>
        email.value.trim().toLowerCase(),
      ),
      phones: union(
        merged.phones,
        other.phones,
        (phone) => phoneKey(phone.value) ?? phone.value.trim(),
      ),
      organization: {
        company: text(merged.organization.company, other.organization.company),
        title: text(merged.organization.title, other.organization.title),
        department: text(
          merged.organization.department,
          other.organization.department,
        ),
      },
      addresses: union(merged.addresses, other.addresses, addressKey),
      ...((merged.birthday ?? other.birthday)
        ? { birthday: merged.birthday ?? other.birthday }
        : {}),
      websites: union(merged.websites, other.websites, (site) =>
        site.value.trim().toLowerCase(),
      ),
      notes,
      groupIds: union(merged.groupIds, other.groupIds, (id) => id),
    };
  }, base);
}

/**
 * The fields as a source can hold them: kinds it lacks become one it has
 * (where there's room), and what doesn't fit is left out (`dropped`).
 */
export function fitTo(
  capabilities: ContactCapabilities,
  fields: ContactFields,
): { readonly fields: ContactFields; readonly dropped: boolean } {
  let dropped = false;
  const capped = <T>(list: readonly T[], max: number | undefined): T[] => {
    if (max === undefined || list.length <= max) return [...list];
    dropped = true;
    return list.slice(0, max);
  };
  const emails = capped(
    capabilities.emailKinds
      ? fields.emails
      : fields.emails.map(({ value }) => ({ value, kind: "other" as const })),
    capabilities.maxEmails,
  );

  const counts = new Map<PhoneKind, number>();
  const room = (kind: PhoneKind) =>
    capabilities.phoneKinds.includes(kind) &&
    (counts.get(kind) ?? 0) < (capabilities.maxPhones?.[kind] ?? Infinity);
  const phones = fields.phones.flatMap((phone) => {
    const order: PhoneKind[] = [phone.kind, "mobile", "home", "work", "other"];
    const kind = order.find(room);
    if (!kind) {
      dropped = true;
      return [];
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return [kind === phone.kind ? phone : { value: phone.value, kind }];
  });

  const used = new Set<ValueKind>();
  const addresses = fields.addresses.flatMap((address) => {
    const order: ValueKind[] = [address.kind, "other", "home", "work"];
    const kind = order.find(
      (candidate) =>
        capabilities.addressKinds.includes(candidate) &&
        !(capabilities.oneAddressPerKind && used.has(candidate)),
    );
    if (!kind) {
      dropped = true;
      return [];
    }
    used.add(kind);
    return [kind === address.kind ? address : { ...address, kind }];
  });

  const websites = capped(
    capabilities.websiteKinds
      ? fields.websites
      : fields.websites.map(({ value }) => ({ value, kind: "work" as const })),
    capabilities.maxWebsites,
  );

  const birthdayFits =
    fields.birthday !== undefined &&
    !(capabilities.birthdayYear && fields.birthday.year === undefined);
  if (fields.birthday && !birthdayFits) dropped = true;
  const { birthday: _birthday, ...rest } = fields;
  return {
    fields: {
      ...rest,
      emails,
      phones,
      addresses,
      websites,
      ...(birthdayFits ? { birthday: fields.birthday } : {}),
      groupIds: capabilities.groups ? fields.groupIds : [],
    },
    dropped: dropped || (!capabilities.groups && fields.groupIds.length > 0),
  };
}

/** Whether two sets of fields are the same (what a save would change). */
export function sameFields(a: ContactFields, b: ContactFields): boolean {
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

/** Fields with blank values left out and text trimmed, for comparing and saving. */
export function normalized(fields: ContactFields): ContactFields {
  const typed = <K extends string>(list: readonly Typed<K>[]) =>
    list
      .map((item) => ({ ...item, value: item.value.trim() }))
      .filter((item) => item.value);
  const { birthday, ...rest } = fields;
  return {
    ...rest,
    name: {
      given: fields.name.given.trim(),
      middle: fields.name.middle.trim(),
      family: fields.name.family.trim(),
    },
    nickname: fields.nickname.trim(),
    emails: typed(fields.emails),
    phones: typed(fields.phones),
    organization: {
      company: fields.organization.company.trim(),
      title: fields.organization.title.trim(),
      department: fields.organization.department.trim(),
    },
    addresses: fields.addresses
      .map((address) => ({
        ...address,
        street: address.street.trim(),
        city: address.city.trim(),
        region: address.region.trim(),
        postalCode: address.postalCode.trim(),
        country: address.country.trim(),
      }))
      .filter((address) => addressKey(address)),
    websites: typed(fields.websites),
    notes: fields.notes.trim(),
    ...(birthday ? { birthday } : {}),
  };
}

/** The fields of a contact (without its id, photo and the like). */
export function fieldsOf(contact: ContactFields): ContactFields {
  return {
    name: contact.name,
    nickname: contact.nickname,
    emails: contact.emails,
    phones: contact.phones,
    organization: contact.organization,
    addresses: contact.addresses,
    ...(contact.birthday ? { birthday: contact.birthday } : {}),
    websites: contact.websites,
    notes: contact.notes,
    groupIds: contact.groupIds,
  };
}
