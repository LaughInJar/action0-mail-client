import type { AccountId } from "../../core/ids";
import type { EmailAddress } from "../../core/model";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { copyText } from "../common/clipboard";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { displayName } from "../common/format";
import { useComposeActions } from "../composer/useComposeActions";
import { useContactLink } from "./contactLink";
import { useShowMail } from "./useShowMail";

/**
 * The menu of a sender or recipient in the reader: write to them, show
 * mail with them, copy the address, and add them to the contacts (or show
 * their contact).
 */
export function PersonMenu({
  accountId,
  person,
  at,
  onClose,
}: {
  accountId: AccountId;
  person: EmailAddress;
  at: MenuPosition;
  onClose: () => void;
}) {
  const t = useT();
  const c = t.contacts;
  const store = useUiStore();
  const compose = useComposeActions();
  const showMail = useShowMail();
  const contactLink = useContactLink();
  const contact = contactLink(accountId, person);
  const entries: MenuEntry[] = [
    {
      id: "write",
      label: c.writeMail,
      icon: "mail",
      run: () => {
        compose.composeTo(accountId, [person]);
      },
    },
    {
      id: "show-mail",
      label: c.showMail,
      icon: "search",
      run: () => {
        void showMail(person.address, accountId);
      },
    },
    {
      id: "copy",
      label: c.copyAddress,
      icon: "copy",
      run: () => {
        copyText(person.address, store, t);
      },
    },
    ...(contact ? [{ ...contact, divider: true }] : []),
  ];
  const title = displayName(person, person.address);
  return (
    <ContextMenu
      label={title}
      title={person.name ? `${person.name} <${person.address}>` : title}
      at={at}
      entries={entries}
      onClose={onClose}
    />
  );
}
