import { useAccountHandle } from "../../accounts/context";
import type { AccountId, MailboxId } from "../../core/ids";
import { findMailbox } from "../../data/hooks";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import { useUiStore } from "../../state/context";
import type { MenuPosition } from "../../state/uiStore";
import { useMarkAllRead } from "../actions/useMarkAllRead";
import { ContextMenu, type MenuEntry } from "../common/ContextMenu";
import { useMailboxList } from "../common/mailboxNames";
import { grouped } from "../common/menuEntries";
import { routeUrl } from "../common/routeUrl";
import { mailboxTexts } from "../labels/mailboxTexts";
import { useLabelActions } from "../labels/useLabelActions";
import { mailboxMenuItems, type MailboxMenuItem } from "./mailboxMenuItems";

/** Props of {@link MailboxMenu}. */
export interface MailboxMenuProps {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly at: MenuPosition;
  readonly onClose: () => void;
}

/**
 * The context menu of a mailbox in the folder tree; what it offers is
 * decided by {@link mailboxMenuItems}.
 */
export function MailboxMenu({
  accountId,
  mailboxId,
  at,
  onClose,
}: MailboxMenuProps) {
  const { data: mailboxes } = useMailboxList(accountId);
  const mailbox = findMailbox(mailboxes, mailboxId);
  const capabilities = useAccountHandle(accountId)?.provider.capabilities;
  const t = useT();
  const m = t.menus;
  const l = mailboxTexts(t, capabilities, mailbox?.kind);
  const platform = usePlatform();
  const store = useUiStore();
  const labels = useLabelActions();
  const markAllRead = useMarkAllRead();
  if (!mailbox) return null;

  const items = mailboxMenuItems(
    mailbox,
    capabilities,
    platform.kind === "web",
  );
  const edit = (focus: "name" | "parent" | "color") => () => {
    store
      .getState()
      .setLabelDialog({ mode: "edit", accountId, mailboxId, focus });
  };
  const create = (kind?: "label") => () => {
    store.getState().setLabelDialog({
      mode: "create",
      accountId,
      ...(kind ? { kind } : { parentId: mailboxId }),
    });
  };
  const entryOf = (item: MailboxMenuItem): MenuEntry => {
    switch (item) {
      case "open-tab":
        return {
          id: item,
          label: m.openInNewTab,
          icon: "external-link",
          run: () => {
            platform.openExternal(routeUrl({ accountId, mailboxId }));
          },
        };
      case "mark-all-read":
        return {
          id: item,
          label: m.markAllRead,
          icon: "mail-open",
          disabled: mailbox.counts?.unread === 0,
          run: () => {
            markAllRead(accountId, mailbox);
          },
        };
      case "empty":
        return {
          id: item,
          label: t.actions.empty(mailbox.name),
          icon: "trash",
          danger: true,
          run: () => {
            const a = t.actions;
            store.getState().setConfirm({
              title: a.emptyTitle(mailbox.name),
              message: a.emptyMessage(mailbox.name),
              confirmLabel: a.empty(mailbox.name),
              action: {
                kind: "empty",
                accountId,
                mailboxId,
                name: mailbox.name,
              },
            });
          },
        };
      case "rename":
        return { id: item, label: l.rename, run: edit("name") };
      case "colour":
        return { id: item, label: l.colourMenu, run: edit("color") };
      case "move-under":
        return { id: item, label: l.moveUnder, run: edit("parent") };
      case "add-inside":
        return { id: item, label: l.addSublabel, run: create() };
      case "hide":
        return {
          id: item,
          label: mailbox.hidden ? l.showInFolderList : l.hideFromFolderList,
          run: () => {
            labels.toggleHidden(accountId, mailbox);
          },
        };
      case "delete":
        return {
          id: item,
          label: l.deleteMenu,
          danger: true,
          run: () => {
            labels.requestDelete(accountId, mailbox);
          },
        };
      case "new-category":
        return {
          id: item,
          label: t.categories.newLabel,
          run: create("label"),
        };
    }
  };

  const entries = grouped(
    items.general.map(entryOf),
    items.managing.map(entryOf),
  );
  if (entries.length === 0) return null;
  return (
    <ContextMenu
      label={l.menuOf(mailbox.name)}
      title={mailbox.name}
      at={at}
      entries={entries}
      {...(items.cantRename ? { note: l.cantRename } : {})}
      onClose={onClose}
    />
  );
}
