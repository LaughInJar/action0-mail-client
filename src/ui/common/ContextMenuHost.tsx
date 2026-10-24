import { useEffect } from "react";
import { useRouter, useUi, useUiStore } from "../../state/context";
import { MailboxMenu } from "../mailboxes/MailboxMenu";
import { RowMenu } from "../messages/RowMenu";
import { MessageMenu } from "../reader/MessageMenu";

/**
 * Shows the open context menu of mail: list rows, a mailbox, a message in
 * the reader. (The calendar shows its events' menus itself.) Going
 * elsewhere, Back included, closes any of them.
 */
export function ContextMenuHost() {
  const menu = useUi((state) => state.contextMenu);
  const setContextMenu = useUi((state) => state.setContextMenu);
  const router = useRouter();
  const store = useUiStore();
  useEffect(
    () =>
      router.subscribe(() => {
        store.getState().setContextMenu(null);
      }),
    [router, store],
  );
  if (!menu) return null;
  const close = () => {
    setContextMenu(null);
  };
  // A new menu (another row, another place) starts fresh.
  const key = JSON.stringify(menu);
  switch (menu.kind) {
    case "rows":
      return (
        <RowMenu key={key} keys={menu.keys} at={menu.at} onClose={close} />
      );
    case "mailbox":
      return (
        <MailboxMenu
          key={key}
          accountId={menu.accountId}
          mailboxId={menu.mailboxId}
          at={menu.at}
          onClose={close}
        />
      );
    case "message":
      return (
        <MessageMenu
          key={key}
          accountId={menu.accountId}
          messageId={menu.messageId}
          at={menu.at}
          onClose={close}
        />
      );
    case "event":
      return null;
  }
}
