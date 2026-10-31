import { useMemo } from "react";
import {
  displayNameOf,
  fieldsOf,
  nameOf,
  type CardToWrite,
  type Contact,
  type ContactSnapshot,
} from "../../core/contacts";
import { useContactCards } from "../../data/contactCards";
import type { ContactSource } from "../../data/contacts";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useRouter, useUiStore } from "../../state/context";
import { errorMessage } from "../common/errorMessage";

/** Contacts to export, with what their groups are called. */
export interface ExportItem {
  readonly source: ContactSource;
  readonly contact: Contact;
  readonly snapshot: ContactSnapshot | undefined;
}

/** How many pictures are fetched at once while exporting. */
const PHOTO_FETCHES = 4;

/** A name usable as a file name ("Anna Berger.vcf"). */
const fileNameOf = (name: string) =>
  `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "contacts"}.vcf`;

/** vCard files: exporting contacts, and reading files to import. */
export function useVcardFiles() {
  const cards = useContactCards();
  const platform = usePlatform();
  const store = useUiStore();
  const router = useRouter();
  const t = useT();
  return useMemo(() => {
    const c = t.contacts;
    const toast = (message: string, tone: "info" | "error" = "error") => {
      store.getState().showToast({ message, tone });
    };

    /** The card of a contact, with its picture where one can be had. */
    const cardOf = async (item: ExportItem): Promise<CardToWrite> => {
      const { source, contact, snapshot } = item;
      const raw = source.provider.rawCard?.(contact);
      const groups = contact.groupIds.flatMap(
        (id) => snapshot?.groups.find((group) => group.id === id)?.name ?? [],
      );
      const photo =
        raw === undefined && contact.photo
          ? await source.provider.photo(contact).catch(() => undefined)
          : undefined;
      return {
        fields: fieldsOf(contact),
        displayName: nameOf(contact) || displayNameOf(contact),
        groups,
        ...(photo ? { photo } : {}),
        ...(raw === undefined ? {} : { raw }),
      };
    };

    return {
      /** Whether files can be read and written at all. */
      available: cards !== null,

      /**
       * Saves the contacts as one .vcf file: shared on Android, saved
       * through the system dialog in the desktop app, downloaded on the web.
       */
      exportContacts: async (items: readonly ExportItem[], name: string) => {
        if (!cards || items.length === 0) return;
        try {
          const written: CardToWrite[] = new Array<CardToWrite>(items.length);
          let next = 0;
          const worker = async () => {
            while (next < items.length) {
              const at = next++;
              const item = items[at];
              if (item) written[at] = await cardOf(item);
            }
          };
          await Promise.all(
            Array.from(
              { length: Math.min(PHOTO_FETCHES, items.length) },
              worker,
            ),
          );
          const text = await cards.format(written);
          const blob = new Blob([text], { type: "text/vcard" });
          const file = fileNameOf(name);
          if (platform.mobile) await platform.mobile.share(blob, file);
          else await platform.saveFile(blob, file);
          toast(c.exported(items.length), "info");
        } catch (error) {
          toast(c.couldntExport(errorMessage(error, t)));
        }
      },

      /**
       * Reads vCard files and opens the import preview for them (into
       * `list`'s address book, if it names one).
       */
      importFiles: async (files: readonly File[], list: string) => {
        if (!cards || files.length === 0) return;
        const vcards = files.filter(
          (file) =>
            /\.(vcf|vcard)$/i.test(file.name) ||
            /^text\/(x-)?vcard/i.test(file.type),
        );
        if (vcards.length === 0) {
          toast(c.notVcard);
          return;
        }
        try {
          const parsed = (
            await Promise.all(
              vcards.map(async (file) => cards.parse(await file.text())),
            )
          ).flat();
          if (parsed.length === 0) {
            toast(t.errors.reasons.vcardUnreadable({}));
            return;
          }
          store.getState().setContactImport({
            fileName: vcards.map((file) => file.name).join(", "),
            cards: parsed,
            list,
          });
          const route = router.getContactsRoute();
          router.openContacts({ list: route?.list ?? list, importing: true });
        } catch (error) {
          toast(c.couldntRead(errorMessage(error, t)));
        }
      },
    };
  }, [cards, platform, store, router, t]);
}
