import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  asContactId,
  displayNameOf,
  fieldsOf,
  type AddressBookId,
  type Contact,
  type ContactFields,
  type ContactGroup,
  type ContactSnapshot,
  type NewContact,
} from "../core/contacts";
import { whileBusy, type ContactSource } from "./contacts";
import { queryKeys } from "./keys";

/** A change that was made, with what takes it back. */
export interface AppliedContactChange<T> {
  readonly result: T;
  /** Takes the change back (optimistically too). Rejects with a {@link MailError}. */
  readonly undo: () => Promise<void>;
}

/** Changes to contacts: optimistic, rolled back when the provider refuses. */
export interface ContactWrites {
  readonly create: (
    source: ContactSource,
    book: AddressBookId,
    contact: NewContact,
  ) => Promise<AppliedContactChange<Contact>>;
  readonly update: (
    source: ContactSource,
    contact: Contact,
    fields: ContactFields,
  ) => Promise<AppliedContactChange<Contact>>;
  readonly remove: (
    source: ContactSource,
    contacts: readonly Contact[],
  ) => Promise<AppliedContactChange<undefined>>;
  /** Adds one of Google's "Other contacts" to the contacts. */
  readonly addOther: (
    source: ContactSource,
    contact: Contact,
  ) => Promise<AppliedContactChange<Contact>>;
  /**
   * Merges `others` into `keep` with `fields` (see `mergeFields`): `keep`
   * gets them, the others are deleted.
   */
  readonly merge: (
    source: ContactSource,
    keep: Contact,
    others: readonly Contact[],
    fields: ContactFields,
  ) => Promise<AppliedContactChange<Contact>>;
  /** Creates a group (not undone with the change that needed it). */
  readonly createGroup: (
    source: ContactSource,
    name: string,
  ) => Promise<ContactGroup>;
  /** Creates a group on its own ("New group"), undoably. */
  readonly addGroup: (
    source: ContactSource,
    name: string,
    colorId?: string,
  ) => Promise<AppliedContactChange<ContactGroup>>;
  readonly renameGroup: (
    source: ContactSource,
    group: ContactGroup,
    name: string,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<AppliedContactChange<ContactGroup>>;
  readonly setGroupColor: (
    source: ContactSource,
    group: ContactGroup,
    colorId: string,
  ) => Promise<AppliedContactChange<ContactGroup>>;
  /** Deletes a group; its contacts stay. */
  readonly deleteGroup: (
    source: ContactSource,
    group: ContactGroup,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<AppliedContactChange<undefined>>;
  /** Sets a contact's picture, or removes it (`null`). */
  readonly setPhoto: (
    source: ContactSource,
    contact: Contact,
    photo: Blob | null,
  ) => Promise<AppliedContactChange<Contact>>;
}

/** The writes, bound to the query client. */
export function useContactWrites(): ContactWrites {
  const queryClient = useQueryClient();
  return useMemo(() => createContactWrites(queryClient), [queryClient]);
}

let pendingIds = 0;

/** See {@link ContactWrites}. */
export function createContactWrites(queryClient: QueryClient): ContactWrites {
  const keyOf = (source: ContactSource) => queryKeys.contacts(source.key);

  /** Changes the cached snapshot of a source (if it's cached). */
  const patch = (
    source: ContactSource,
    change: (snapshot: ContactSnapshot) => ContactSnapshot,
  ) => {
    queryClient.setQueryData<ContactSnapshot>(keyOf(source), (snapshot) =>
      snapshot ? change(snapshot) : snapshot,
    );
  };

  /**
   * Runs a provider call with the cache already showing its outcome
   * (`optimistic`), putting the cache back if it fails.
   */
  const run = async <T>(
    source: ContactSource,
    optimistic: (snapshot: ContactSnapshot) => ContactSnapshot,
    call: () => Promise<T>,
    settled: (result: T) => (snapshot: ContactSnapshot) => ContactSnapshot,
  ): Promise<T> =>
    whileBusy(queryClient, source.key, async () => {
      await queryClient.cancelQueries({ queryKey: keyOf(source) });
      const before = queryClient.getQueryData<ContactSnapshot>(keyOf(source));
      patch(source, optimistic);
      try {
        const result = await call();
        patch(source, settled(result));
        return result;
      } catch (error) {
        if (before) queryClient.setQueryData(keyOf(source), before);
        throw error;
      }
    });

  const withContacts =
    (change: (contacts: readonly Contact[]) => readonly Contact[]) =>
    (snapshot: ContactSnapshot): ContactSnapshot => ({
      ...snapshot,
      contacts: change(snapshot.contacts),
    });
  const without = (ids: ReadonlySet<string>) =>
    withContacts((contacts) =>
      contacts.filter((contact) => !ids.has(contact.id)),
    );
  /** Puts these contacts in (replacing ones with the same id, or `replacing`). */
  const putting = (added: readonly Contact[], replacing?: string) =>
    withContacts((contacts) => {
      const ids = new Set(added.map((contact) => contact.id as string));
      return [
        ...contacts.filter(
          (contact) => !ids.has(contact.id) && contact.id !== replacing,
        ),
        ...added,
      ];
    });
  const replacing = (contact: Contact) =>
    withContacts((contacts) =>
      contacts.map((candidate) =>
        candidate.id === contact.id ? contact : candidate,
      ),
    );
  const withFields = (contact: Contact, fields: ContactFields): Contact => {
    const { birthday: _birthday, ...rest } = contact;
    return {
      ...rest,
      ...fields,
      displayName: displayNameOf(fields),
    };
  };

  /** The groups with `group` in place of the one with `id` (also in the contacts). */
  const regrouping =
    (id: string, group: ContactGroup) =>
    (snapshot: ContactSnapshot): ContactSnapshot => ({
      ...snapshot,
      groups: snapshot.groups.map((candidate) =>
        candidate.id === id ? group : candidate,
      ),
      contacts:
        id === group.id
          ? snapshot.contacts
          : snapshot.contacts.map((contact) =>
              contact.groupIds.includes(group.id) ||
              !contact.groupIds.some((other) => other === id)
                ? contact
                : {
                    ...contact,
                    groupIds: contact.groupIds.map((other) =>
                      other === id ? group.id : other,
                    ),
                  },
            ),
    });
  const ungrouping =
    (id: string) =>
    (snapshot: ContactSnapshot): ContactSnapshot => ({
      ...snapshot,
      groups: snapshot.groups.filter((group) => group.id !== id),
    });
  const grouping =
    (group: ContactGroup) =>
    (snapshot: ContactSnapshot): ContactSnapshot => ({
      ...snapshot,
      groups: [
        ...snapshot.groups.filter((candidate) => candidate.id !== group.id),
        group,
      ],
    });
  /**
   * Group changes touch contacts on the server (memberships, vCards):
   * load the changes once done, so their new versions are known.
   */
  const refresh = (source: ContactSource) => {
    void queryClient.invalidateQueries({ queryKey: keyOf(source) });
  };
  const withPhoto = (contact: Contact, photo: Blob | null): Contact => {
    const { photo: _photo, ...rest } = contact;
    return photo && typeof URL.createObjectURL === "function"
      ? { ...rest, photo: { kind: "url", url: URL.createObjectURL(photo) } }
      : rest;
  };

  /** Brings removed contacts back (as the provider returns them). */
  const restoring = async (
    source: ContactSource,
    undo: () => Promise<readonly Contact[]>,
  ) => {
    await run(
      source,
      (snapshot) => snapshot,
      undo,
      (restored) => putting(restored),
    );
  };

  const remove: ContactWrites["remove"] = async (source, contacts) => {
    const ids = new Set(contacts.map((contact) => contact.id as string));
    const removal = await run(
      source,
      without(ids),
      () => source.provider.remove(contacts),
      () => without(ids),
    );
    return {
      result: undefined,
      undo: () => restoring(source, () => removal.undo()),
    };
  };

  const update: ContactWrites["update"] = async (source, contact, fields) => {
    const write = await run(
      source,
      replacing(withFields(contact, fields)),
      () => source.provider.update(contact, fields),
      (done) => replacing(done.contact),
    );
    return {
      result: write.contact,
      undo: async () => {
        await run(
          source,
          replacing(withFields(write.contact, fieldsOf(contact))),
          () => write.undo(),
          (restored) => (restored ? replacing(restored) : (s) => s),
        );
      },
    };
  };

  return {
    create: async (source, book, contact) => {
      const pending: Contact = {
        ...contact.fields,
        id: asContactId(`pending:${String(++pendingIds)}`),
        addressBookId: book,
        displayName: displayNameOf(contact.fields),
      };
      const write = await run(
        source,
        putting([pending]),
        () => source.provider.create(book, contact),
        (done) => putting([done.contact], pending.id),
      );
      return {
        result: write.contact,
        undo: async () => {
          const ids = new Set<string>([write.contact.id]);
          await run(
            source,
            without(ids),
            () => write.undo(),
            () => without(ids),
          );
        },
      };
    },
    update,
    remove,
    addOther: async (source, contact) => {
      const addOther = source.provider.addOther?.bind(source.provider);
      if (!addOther) throw new Error("This source has no Other contacts.");
      const withoutOther = (snapshot: ContactSnapshot): ContactSnapshot => ({
        ...snapshot,
        other: (snapshot.other ?? []).filter(({ id }) => id !== contact.id),
      });
      const write = await run(
        source,
        withoutOther,
        () => addOther(contact),
        (done) => (snapshot) => putting([done.contact])(withoutOther(snapshot)),
      );
      return {
        result: write.contact,
        undo: async () => {
          const ids = new Set<string>([write.contact.id]);
          await run(
            source,
            without(ids),
            () => write.undo(),
            () => (snapshot) => ({
              ...without(ids)(snapshot),
              other: [...(snapshot.other ?? []), contact],
            }),
          );
        },
      };
    },
    merge: async (source, keep, others, fields) => {
      const updated = await update(source, keep, fields);
      let removed: AppliedContactChange<undefined>;
      try {
        removed = await remove(source, others);
      } catch (error) {
        await updated.undo().catch(() => undefined);
        throw error;
      }
      return {
        result: updated.result,
        undo: async () => {
          await removed.undo();
          await updated.undo();
        },
      };
    },
    addGroup: async (source, name, colorId) => {
      let group = await run(
        source,
        (snapshot) => snapshot,
        () => source.provider.createGroup(name),
        (created) => grouping(created),
      );
      const setColor = source.provider.setGroupColor?.bind(source.provider);
      if (colorId !== undefined && colorId !== group.colorId && setColor) {
        const created = group;
        group = await run(
          source,
          (snapshot) => snapshot,
          async () => (await setColor(created, colorId)).group,
          (colored) => regrouping(created.id, colored),
        );
      }
      const added = group;
      return {
        result: added,
        undo: async () => {
          await run(
            source,
            ungrouping(added.id),
            () => source.provider.deleteGroup(added),
            () => ungrouping(added.id),
          );
        },
      };
    },
    renameGroup: async (source, group, name, onProgress) => {
      const rename = source.provider.renameGroup?.bind(source.provider);
      if (!rename) throw new Error("This source can't rename groups.");
      const write = await run(
        source,
        regrouping(group.id, { ...group, name }),
        () => rename(group, name, onProgress ? { onProgress } : {}),
        (done) => regrouping(group.id, done.group),
      );
      refresh(source);
      return {
        result: write.group,
        undo: async () => {
          await run(
            source,
            regrouping(write.group.id, group),
            () => write.undo(),
            (restored) => regrouping(write.group.id, restored ?? group),
          );
          refresh(source);
        },
      };
    },
    setGroupColor: async (source, group, colorId) => {
      const setColor = source.provider.setGroupColor?.bind(source.provider);
      if (!setColor) throw new Error("This source has no group colours.");
      const color = source.provider.capabilities.groupColors?.find(
        (candidate) => candidate.id === colorId,
      );
      const write = await run(
        source,
        regrouping(group.id, {
          ...group,
          colorId,
          ...(color ? { color: color.color } : {}),
        }),
        () => setColor(group, colorId),
        (done) => regrouping(group.id, done.group),
      );
      return {
        result: write.group,
        undo: async () => {
          await run(
            source,
            regrouping(group.id, group),
            () => write.undo(),
            (restored) => regrouping(group.id, restored ?? group),
          );
        },
      };
    },
    deleteGroup: async (source, group, onProgress) => {
      const removal = await run(
        source,
        ungrouping(group.id),
        () =>
          source.provider.deleteGroup(group, onProgress ? { onProgress } : {}),
        () => ungrouping(group.id),
      );
      refresh(source);
      return {
        result: undefined,
        undo: async () => {
          await run(
            source,
            (snapshot) => snapshot,
            () => removal.undo(),
            (restored) => grouping(restored),
          );
          refresh(source);
        },
      };
    },
    setPhoto: async (source, contact, photo) => {
      const write = await run(
        source,
        replacing(withPhoto(contact, photo)),
        () => source.provider.setPhoto(contact, photo),
        (done) => replacing(done.contact),
      );
      return {
        result: write.contact,
        undo: async () => {
          await run(
            source,
            replacing(contact),
            () => write.undo(),
            (restored) => (restored ? replacing(restored) : (s) => s),
          );
        },
      };
    },
    createGroup: async (source, name) =>
      run(
        source,
        (snapshot) => snapshot,
        () => source.provider.createGroup(name),
        (group) => (snapshot) => ({
          ...snapshot,
          groups: [
            ...snapshot.groups.filter(({ id }) => id !== group.id),
            group,
          ],
        }),
      ),
  };
}
