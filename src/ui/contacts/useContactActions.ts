import { useMemo } from "react";
import {
  displayNameOf,
  fieldsOf,
  fitTo,
  mergeFields,
  nameOf,
  type AddressBookId,
  type Contact,
  type ContactFields,
  type ContactGroupId,
} from "../../core/contacts";
import type { ContactSource } from "../../data/contacts";
import { useContactWrites } from "../../data/contactEdits";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";

/** What the contacts do, each change with an undo toast. */
export interface ContactActions {
  /**
   * Makes sure the source's contacts can be changed, asking for the
   * permission first (Google without it; call it from a click). False
   * when it can't (declined, or not allowed at all); says why.
   */
  readonly ensureWritable: (source: ContactSource) => Promise<boolean>;
  /**
   * Saves a new contact into `book`, or the changes to `contact`; groups
   * named in `newGroups` are created first. Resolves to the saved contact;
   * rejects with the reason (the editor shows it).
   */
  readonly save: (input: {
    readonly source: ContactSource;
    readonly contact?: Contact;
    readonly book: AddressBookId;
    readonly fields: ContactFields;
    readonly newGroups: readonly string[];
  }) => Promise<Contact>;
  /** Deletes contacts of one source (undo brings them back). */
  readonly remove: (
    source: ContactSource,
    contacts: readonly Contact[],
  ) => Promise<boolean>;
  /** Adds one of the "Other contacts" to the contacts. */
  readonly addOther: (
    source: ContactSource,
    contact: Contact,
  ) => Promise<Contact | undefined>;
  /**
   * Merges contacts of one source into the most complete one (the first).
   * Resolves to it, or undefined if it failed (said in a toast).
   */
  readonly merge: (
    source: ContactSource,
    contacts: readonly Contact[],
    options?: { readonly quiet?: boolean },
  ) => Promise<Contact | undefined>;
  /** Merges several sets of duplicates, as one undoable change. */
  readonly mergeAll: (
    source: ContactSource,
    sets: readonly (readonly Contact[])[],
  ) => Promise<void>;
}

/** See {@link ContactActions}. */
export function useContactActions(): ContactActions {
  const writes = useContactWrites();
  const store = useUiStore();
  const t = useT();
  return useMemo<ContactActions>(() => {
    const c = t.contacts;
    const toast = (message: string, tone: "info" | "error" = "error") => {
      store.getState().showToast({ message, tone });
    };
    const undoable = (message: string, undo: () => Promise<void>) => {
      store.getState().showToast({
        message,
        tone: "info",
        revert: () => {
          undo().catch((error: unknown) => {
            toast(`${t.actions.couldntUndo}: ${errorMessage(error, t)}`);
          });
        },
      });
    };

    const ensureWritable = async (source: ContactSource) => {
      const access = source.provider.access();
      if (access === "granted") return true;
      if (access === "missing") {
        toast(c.readOnlyContacts);
        return false;
      }
      try {
        await source.provider.requestAccess();
        return source.provider.access() === "granted";
      } catch (error) {
        toast(errorMessage(error, t));
        return false;
      }
    };

    /** Merged fields of contacts, as the source can hold them. */
    const merged = (source: ContactSource, contacts: readonly Contact[]) => {
      const [keep, ...others] = contacts;
      if (!keep) throw new Error("Nothing to merge.");
      return {
        keep,
        others,
        fields: fitTo(
          source.provider.capabilities,
          mergeFields(fieldsOf(keep), others.map(fieldsOf)),
        ).fields,
      };
    };

    return {
      ensureWritable,

      save: async ({ source, contact, book, fields, newGroups }) => {
        const groupIds: ContactGroupId[] = [...fields.groupIds];
        for (const name of newGroups) {
          const group = await writes.createGroup(source, name);
          if (!groupIds.includes(group.id)) groupIds.push(group.id);
        }
        const complete = { ...fields, groupIds };
        if (contact) {
          const applied = await writes.update(source, contact, complete);
          undoable(c.saved(nameOf(applied.result)), applied.undo);
          return applied.result;
        }
        const applied = await writes.create(source, book, { fields: complete });
        undoable(
          c.created(nameOf(applied.result) || displayNameOf(complete)),
          applied.undo,
        );
        return applied.result;
      },

      remove: async (source, contacts) => {
        try {
          const applied = await writes.remove(source, contacts);
          const first = contacts[0];
          undoable(
            c.deleted(contacts.length, first ? nameOf(first) : ""),
            applied.undo,
          );
          return true;
        } catch (error) {
          toast(c.couldntDelete(errorMessage(error, t)));
          return false;
        }
      },

      addOther: async (source, contact) => {
        try {
          const applied = await writes.addOther(source, contact);
          undoable(c.addedOther(nameOf(applied.result)), applied.undo);
          return applied.result;
        } catch (error) {
          toast(c.couldntSave(errorMessage(error, t)));
          return undefined;
        }
      },

      merge: async (source, contacts, { quiet = false } = {}) => {
        try {
          const { keep, others, fields } = merged(source, contacts);
          const applied = await writes.merge(source, keep, others, fields);
          if (!quiet) undoable(c.merged(nameOf(applied.result)), applied.undo);
          return applied.result;
        } catch (error) {
          toast(c.couldntMerge(errorMessage(error, t)));
          return undefined;
        }
      },

      mergeAll: async (source, sets) => {
        const undos: (() => Promise<void>)[] = [];
        try {
          for (const contacts of sets) {
            const { keep, others, fields } = merged(source, contacts);
            const applied = await writes.merge(source, keep, others, fields);
            undos.push(applied.undo);
          }
        } catch (error) {
          toast(c.couldntMerge(errorMessage(error, t)));
        }
        if (undos.length === 0) return;
        undoable(c.mergedAll(undos.length), async () => {
          for (const undo of undos.reverse()) await undo();
        });
      },
    };
  }, [writes, store, t]);
}
