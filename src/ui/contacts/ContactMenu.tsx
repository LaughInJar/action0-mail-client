import type { EmailAddress } from "../../core/model";
import {
  canChangeContact,
  type ContactRow,
  type ContactSourceState,
} from "../../data/contacts";
import { useT } from "../../i18n/context";
import { useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { copyText } from "../common/clipboard";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { useComposeActions } from "../composer/useComposeActions";
import { useShowMail } from "./useShowMail";

/** What the menu's entries do that needs the contacts' screen. */
export interface ContactMenuHandlers {
  readonly select: (row: ContactRow) => void;
  readonly open: (row: ContactRow) => void;
  readonly edit: (row: ContactRow) => void;
  readonly remove: (rows: readonly ContactRow[]) => void;
  readonly merge: (rows: readonly ContactRow[]) => void;
  readonly exportRows: (rows: readonly ContactRow[]) => void;
  readonly addOther: (row: ContactRow) => void;
}

/**
 * The menu of one contact or of the selection: writing to them, copying,
 * editing, merging, exporting, deleting (what each allows).
 */
export function ContactMenu({
  rows,
  at,
  states,
  fromList,
  touch,
  canExport,
  handlers,
  onClose,
}: {
  rows: readonly ContactRow[];
  at: MenuPosition;
  states: readonly ContactSourceState[];
  /** Opened on a list row (offers Open, and Select on touch). */
  fromList: boolean;
  touch: boolean;
  canExport: boolean;
  handlers: ContactMenuHandlers;
  onClose: () => void;
}) {
  const t = useT();
  const c = t.contacts;
  const store = useUiStore();
  const compose = useComposeActions();
  const showMail = useShowMail();
  const first = rows[0];
  if (!first) return null;
  const stateOf = (row: ContactRow) =>
    states.find((state) => state.source.key === row.source.key);
  const changeable = rows.every((row) =>
    canChangeContact(stateOf(row), row.contact),
  );
  const oneSource = rows.every((row) => row.source.key === first.source.key);
  const recipients: EmailAddress[] = rows.flatMap((row) => {
    const address = row.contact.emails[0]?.value;
    return address
      ? [{ address, ...(row.name ? { name: row.name } : {}) }]
      : [];
  });
  const single = rows.length === 1;
  const address = first.contact.emails[0]?.value;

  const entries: MenuEntry[] = [
    ...(single && fromList && touch
      ? [
          {
            id: "select",
            label: c.select,
            icon: "check" as const,
            run: () => {
              handlers.select(first);
            },
          },
        ]
      : []),
    ...(single && fromList
      ? [
          {
            id: "open",
            label: t.menus.open,
            icon: "user" as const,
            run: () => {
              handlers.open(first);
            },
          },
        ]
      : []),
    ...(recipients.length > 0
      ? [
          {
            id: "write",
            label: single ? c.writeMail : c.writeToAll(recipients.length),
            icon: "mail" as const,
            divider: single && fromList,
            run: () => {
              compose.composeTo(
                oneSource ? first.source.accountId : undefined,
                recipients,
              );
            },
          },
        ]
      : []),
    ...(single && address
      ? [
          {
            id: "show-mail",
            label: c.showMail,
            icon: "search" as const,
            run: () => {
              void showMail(address, first.source.accountId);
            },
          },
          {
            id: "copy",
            label: c.copyAddress,
            icon: "copy" as const,
            run: () => {
              copyText(address, store, t);
            },
          },
        ]
      : []),
    ...(single && first.contact.other
      ? [
          {
            id: "add-other",
            label: c.addToContacts,
            icon: "user-plus" as const,
            divider: true,
            run: () => {
              handlers.addOther(first);
            },
          },
        ]
      : []),
    ...(single && changeable
      ? [
          {
            id: "edit",
            label: c.edit,
            icon: "pencil" as const,
            divider: true,
            run: () => {
              handlers.edit(first);
            },
          },
        ]
      : []),
    ...(!single && changeable && oneSource
      ? [
          {
            id: "merge",
            label: c.merge,
            icon: "merge" as const,
            divider: true,
            run: () => {
              handlers.merge(rows);
            },
          },
        ]
      : []),
    ...(canExport
      ? [
          {
            id: "export",
            label: c.exportContacts,
            icon: "download" as const,
            run: () => {
              handlers.exportRows(rows);
            },
          },
        ]
      : []),
    ...(changeable
      ? [
          {
            id: "delete",
            label: c.delete,
            icon: "trash" as const,
            danger: true,
            divider: true,
            run: () => {
              handlers.remove(rows);
            },
          },
        ]
      : []),
  ];

  const title = single
    ? first.name || c.unnamed
    : c.menuForSelection(rows.length);
  return (
    <ContextMenu
      label={single ? c.menuFor(title) : title}
      title={title}
      at={at}
      entries={entries}
      onClose={onClose}
    />
  );
}
