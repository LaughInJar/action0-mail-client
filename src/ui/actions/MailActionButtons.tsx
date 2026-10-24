import { IconButton } from "../common/IconButton";
import { useT } from "../../i18n/context";
import { mailActionItems, type MailActionTarget } from "./mailActionItems";
import type { MailActions } from "./useMailActions";

/** Props of {@link MailActionButtons}. */
export interface MailActionButtonsProps extends MailActionTarget {
  readonly actions: MailActions;
}

/** All mail actions as buttons (the list's selection bar, which wraps). */
export function MailActionButtons({
  actions,
  ...target
}: MailActionButtonsProps) {
  const a = useT().actions;
  return mailActionItems(actions, target, a).map((item) => (
    <IconButton
      key={item.id}
      label={item.label}
      icon={item.icon}
      onClick={item.run}
      {...(item.disabled ? { disabled: true } : {})}
      {...(item.pressed === undefined ? {} : { pressed: item.pressed })}
      {...(item.danger ? { danger: true } : {})}
    />
  ));
}
