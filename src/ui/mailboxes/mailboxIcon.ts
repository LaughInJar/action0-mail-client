import type { Mailbox, MailboxRole } from "../../core/model";
import type { IconName } from "../common/Icon";

/** The icons of the mailboxes with a role. */
export const ROLE_ICONS: Readonly<Record<MailboxRole, IconName>> = {
  inbox: "inbox",
  flagged: "star",
  important: "bookmark",
  sent: "send",
  drafts: "file",
  all: "archive",
  archive: "archive",
  junk: "alert",
  trash: "trash",
};

/** A mailbox's icon: its role's, else a label's or a folder's. */
export function mailboxIcon(mailbox: Mailbox): IconName {
  if (mailbox.role) return ROLE_ICONS[mailbox.role];
  if (mailbox.kind === "label") return "tag";
  return "folder";
}
