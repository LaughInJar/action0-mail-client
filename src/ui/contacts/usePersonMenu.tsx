import { useState, type ReactNode } from "react";
import type { AccountId } from "../../core/ids";
import type { EmailAddress } from "../../core/model";
import type { MenuPosition } from "../../state/uiStore";
import { PersonMenu } from "./PersonMenu";

/**
 * Senders' and recipients' menus in the reader: `onPerson` for the
 * header's names, and the menu to render while one is open.
 */
export function usePersonMenu(accountId: AccountId): {
  readonly onPerson: (person: EmailAddress, at: MenuPosition) => void;
  readonly menu: ReactNode;
} {
  const [open, setOpen] = useState<{
    person: EmailAddress;
    at: MenuPosition;
  } | null>(null);
  return {
    onPerson: (person, at) => {
      setOpen({ person, at });
    },
    menu: open && (
      <PersonMenu
        accountId={accountId}
        person={open.person}
        at={open.at}
        onClose={() => {
          setOpen(null);
        }}
      />
    ),
  };
}
