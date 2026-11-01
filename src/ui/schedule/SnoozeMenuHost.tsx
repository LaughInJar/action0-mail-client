import { useUi } from "../../state/context";
import type { MailActions } from "../actions/useMailActions";
import { SnoozeMenu } from "./SendLaterMenu";

/** Snooze's times while they're open (`h`, the Snooze buttons and menus). */
export function SnoozeMenuHost({ actions }: { actions: MailActions }) {
  const menu = useUi((state) => state.snoozeMenu);
  const setMenu = useUi((state) => state.setSnoozeMenu);
  if (!menu) return null;
  return (
    <SnoozeMenu
      at={menu.at}
      onPick={(until) => {
        actions.snooze(until, menu.keys, { exact: menu.exact });
      }}
      onClose={() => {
        setMenu(null);
      }}
    />
  );
}
