import type { QueryClient } from "@tanstack/react-query";
import {
  fieldsOf,
  fitTo,
  mergeFields,
  phoneKey,
  sameFields,
  type AddressBookId,
  type Contact,
  type ContactFields,
  type ContactGroupId,
  type ContactSnapshot,
  type ContactWrite,
  type NewContact,
  type ParsedCard,
} from "../core/contacts";
import { isMailError } from "../core/errors";
import { whileBusy, type ContactSource } from "./contacts";
import { queryKeys } from "./keys";

/** What happens to a card whose contact is already in the address book. */
export type ImportExisting = "skip" | "merge" | "new";

/** What importing a file into an address book would do. */
export interface ImportPreview {
  /** For each card, the contact already there with the same address or phone. */
  readonly existing: readonly (Contact | undefined)[];
  /** How many cards hold something the address book can't store. */
  readonly lossy: number;
}

/** Whether the source stores the cards themselves (CardDAV), so nothing gets lost. */
export const keepsCards = (source: ContactSource) =>
  source.provider.rawCard !== undefined;

/** Looks at the cards against what's in the address book. */
export function previewImport(
  source: ContactSource,
  snapshot: ContactSnapshot | undefined,
  book: AddressBookId,
  cards: readonly ParsedCard[],
): ImportPreview {
  const inBook = (snapshot?.contacts ?? []).filter(
    (contact) => contact.addressBookId === book,
  );
  const byEmail = new Map<string, Contact>();
  const byPhone = new Map<string, Contact>();
  for (const contact of inBook) {
    for (const email of contact.emails)
      byEmail.set(email.value.trim().toLowerCase(), contact);
    for (const phone of contact.phones) {
      const key = phoneKey(phone.value);
      if (key) byPhone.set(key, contact);
    }
  }
  const lossless = keepsCards(source);
  return {
    existing: cards.map(
      (card) =>
        card.fields.emails
          .map((email) => byEmail.get(email.value.trim().toLowerCase()))
          .find(Boolean) ??
        card.fields.phones
          .map((phone) => {
            const key = phoneKey(phone.value);
            return key ? byPhone.get(key) : undefined;
          })
          .find(Boolean),
    ),
    lossy: lossless
      ? 0
      : cards.filter(
          (card) =>
            card.more ||
            fitTo(source.provider.capabilities, card.fields).dropped,
        ).length,
  };
}

/** How an import went, and how to take it back. */
export interface ImportResult {
  readonly created: number;
  readonly merged: number;
  readonly skipped: number;
  readonly failed: number;
  /** The first failure, to say why. */
  readonly error?: unknown;
  /** Deletes what was created and takes the merges back. */
  readonly undo: () => Promise<void>;
}

/** How many contacts are created per call (so Cancel stops in between). */
const CHUNK = 100;

/**
 * Imports the cards into an address book: new ones are created, ones that
 * exist there are skipped, merged into the existing contact (which only
 * gains values) or created anyway. Groups are matched by name, and created
 * when missing. Stops between chunks when `signal` aborts, keeping what
 * was done (and its undo).
 */
export async function runImport(
  queryClient: QueryClient,
  options: {
    readonly source: ContactSource;
    readonly book: AddressBookId;
    readonly cards: readonly ParsedCard[];
    readonly existing: ImportPreview["existing"];
    readonly mode: ImportExisting;
    readonly onProgress?: (done: number) => void;
    readonly signal?: AbortSignal;
  },
): Promise<ImportResult> {
  const { source, book, cards, existing, mode, signal } = options;
  const provider = source.provider;
  const key = queryKeys.contacts(source.key);
  const lossless = keepsCards(source);
  return whileBusy(queryClient, source.key, async () => {
    const groups = await groupsFor(queryClient, source, cards);
    const fieldsOfCard = (card: ParsedCard): ContactFields =>
      fitTo(provider.capabilities, {
        ...card.fields,
        groupIds: card.groups.flatMap((name) => {
          const id = groups.get(name.trim().toLowerCase());
          return id ? [id] : [];
        }),
      }).fields;

    let done = 0;
    let skipped = 0;
    let failed = 0;
    let error: unknown;
    const merges: ContactWrite[] = [];
    const creates: ContactWrite[] = [];
    const toCreate: NewContact[] = [];
    const progress = () => options.onProgress?.(done);

    for (const [index, card] of cards.entries()) {
      const match = existing[index];
      if (match && mode === "skip") {
        skipped++;
        done++;
        continue;
      }
      if (match && mode === "merge") {
        signal?.throwIfAborted();
        const merged = fitTo(
          provider.capabilities,
          mergeFields(fieldsOf(match), [fieldsOfCard(card)]),
        ).fields;
        if (sameFields(merged, fieldsOf(match))) skipped++;
        else
          try {
            merges.push(await provider.update(match, merged, signal));
          } catch (cause) {
            if (signal?.aborted) break;
            failed++;
            error ??= cause;
          }
        done++;
        progress();
        continue;
      }
      toCreate.push({
        fields: fieldsOfCard(card),
        ...(card.photo ? { photo: card.photo } : {}),
        ...(lossless ? { card: card.card } : {}),
      });
    }

    const base = done;
    for (let at = 0; at < toCreate.length && !signal?.aborted; at += CHUNK) {
      const chunk = toCreate.slice(at, at + CHUNK);
      try {
        const results = await provider.createMany(book, chunk, {
          onProgress: (count) => {
            options.onProgress?.(base + at + count);
          },
          ...(signal ? { signal } : {}),
        });
        for (const result of results)
          if (isMailError(result) || result instanceof Error) {
            failed++;
            error ??= result;
          } else creates.push(result);
      } catch (cause) {
        if (signal?.aborted) break;
        failed += chunk.length;
        error ??= cause;
      }
      done = base + Math.min(at + CHUNK, toCreate.length);
      progress();
    }

    const created = creates.map((write) => write.contact);
    const mergedContacts = merges.map((write) => write.contact);
    queryClient.setQueryData<ContactSnapshot>(key, (snapshot) => {
      if (!snapshot) return snapshot;
      const replaced = new Map(
        mergedContacts.map((contact) => [contact.id as string, contact]),
      );
      return {
        ...snapshot,
        contacts: [
          ...snapshot.contacts.map(
            (contact) => replaced.get(contact.id) ?? contact,
          ),
          ...created,
        ],
      };
    });

    return {
      created: created.length,
      merged: merges.length,
      skipped,
      failed,
      ...(error === undefined ? {} : { error }),
      undo: () =>
        whileBusy(queryClient, source.key, async () => {
          const restored: Contact[] = [];
          for (const write of merges) {
            const back = await write.undo();
            if (back) restored.push(back);
          }
          if (created.length > 0) await provider.remove(created);
          const gone = new Set(created.map((contact) => contact.id as string));
          const back = new Map(
            restored.map((contact) => [contact.id as string, contact]),
          );
          queryClient.setQueryData<ContactSnapshot>(key, (snapshot) =>
            snapshot
              ? {
                  ...snapshot,
                  contacts: snapshot.contacts
                    .filter((contact) => !gone.has(contact.id))
                    .map((contact) => back.get(contact.id) ?? contact),
                }
              : snapshot,
          );
        }),
    };
  });
}

/**
 * The groups the cards name, by lower-case name: the source's own, plus
 * new ones for names it doesn't have (where it has groups).
 */
async function groupsFor(
  queryClient: QueryClient,
  source: ContactSource,
  cards: readonly ParsedCard[],
): Promise<Map<string, ContactGroupId>> {
  const snapshot = queryClient.getQueryData<ContactSnapshot>(
    queryKeys.contacts(source.key),
  );
  const groups = new Map(
    (snapshot?.groups ?? []).map((group) => [
      group.name.trim().toLowerCase(),
      group.id,
    ]),
  );
  if (!source.provider.capabilities.groups) return groups;
  const wanted = new Map<string, string>();
  for (const card of cards)
    for (const name of card.groups) {
      const folded = name.trim().toLowerCase();
      if (folded && !groups.has(folded)) wanted.set(folded, name.trim());
    }
  for (const [folded, name] of wanted) {
    const group = await source.provider.createGroup(name);
    groups.set(folded, group.id);
    queryClient.setQueryData<ContactSnapshot>(
      queryKeys.contacts(source.key),
      (current) =>
        current ? { ...current, groups: [...current.groups, group] } : current,
    );
  }
  return groups;
}
