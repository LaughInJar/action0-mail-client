import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { ContactSnapshot } from "../../core/contacts";
import type { AccountId } from "../../core/ids";
import type { EmailAddress } from "../../core/model";
import {
  contactKeyOf,
  contactWithAddress,
  ensureContacts,
  listToken,
  useContactSources,
} from "../../data/contacts";
import { queryKeys } from "../../data/keys";
import { useT } from "../../i18n/context";
import { useRouter } from "../../state/context";
import type { MenuEntry } from "../common/ContextMenu";

/**
 * The "Add to contacts" / "Show contact" entry for a person in mail of an
 * account (none when the account has no contacts). It says "Show contact"
 * when the person is among the contacts already loaded; on a click it
 * loads them and opens the contact, or the editor filled in with the name
 * and address.
 */
export function useContactLink(): (
  accountId: AccountId,
  person: EmailAddress,
) => MenuEntry | undefined {
  const sources = useContactSources();
  const queryClient = useQueryClient();
  const router = useRouter();
  const t = useT();
  return useCallback(
    (accountId, person) => {
      const source = sources.find(
        (candidate) => candidate.accountId === accountId,
      );
      if (!source) return undefined;
      const known = contactWithAddress(
        queryClient.getQueryData<ContactSnapshot>(
          queryKeys.contacts(source.key),
        ),
        person.address,
      );
      return {
        id: "contact",
        label: known ? t.contacts.showContact : t.contacts.addToContacts,
        icon: known ? "user" : "user-plus",
        run: () => {
          const list = listToken({ kind: "source", source: source.key });
          void ensureContacts(queryClient, source)
            .catch(() => undefined)
            .then((snapshot) => {
              const found = contactWithAddress(snapshot, person.address);
              if (found)
                router.openContacts({
                  list: found.other
                    ? listToken({ kind: "other", source: source.key })
                    : list,
                  contact: contactKeyOf(source.key, found.id),
                });
              // Not allowed to see the contacts: their list says how to allow it.
              else if (source.provider.access() === "missing")
                router.openContacts({ list });
              else
                router.openContacts({
                  list,
                  create: {
                    ...(person.name ? { name: person.name } : {}),
                    address: person.address,
                  },
                });
            });
        },
      };
    },
    [sources, queryClient, router, t],
  );
}
