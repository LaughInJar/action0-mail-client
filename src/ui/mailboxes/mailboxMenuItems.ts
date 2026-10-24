import type { Mailbox } from "../../core/model";
import type { ProviderCapabilities } from "../../core/provider";
import { isNestable, isOwnMailbox } from "../../data/mailboxActions";

/** An entry of a mailbox's context menu. */
export type MailboxMenuItem =
  | "open-tab"
  | "mark-all-read"
  | "empty"
  | "rename"
  | "colour"
  | "move-under"
  | "add-inside"
  | "hide"
  | "delete"
  | "new-category";

/** The entries of a mailbox's context menu, in order. */
export interface MailboxMenuItems {
  /** Using the mailbox: open it in a new tab, mark all read, empty it. */
  readonly general: readonly MailboxMenuItem[];
  /** Changing the mailbox itself (or creating one inside it). */
  readonly managing: readonly MailboxMenuItem[];
  /** It's the user's own, but the provider can't rename that kind. */
  readonly cantRename: boolean;
}

/**
 * What the context menu of a mailbox offers: open it in a new tab (web
 * only), mark everything read, empty Trash or Spam, create one inside, and
 * for the user's own mailboxes rename, recolour, move, hide and delete (as
 * far as the provider allows for that kind). The folder tree uses it to
 * leave out the menu where it would be empty.
 */
export function mailboxMenuItems(
  mailbox: Mailbox,
  capabilities: ProviderCapabilities | undefined,
  web: boolean,
): MailboxMenuItems {
  const manage = capabilities?.manageMailboxes ?? false;
  const folderAccount = capabilities?.mailboxKinds.includes("folder") ?? false;
  const rules = capabilities?.mailboxEditing[mailbox.kind];

  const general: MailboxMenuItem[] = [];
  if (mailbox.selectable && web) general.push("open-tab");
  if (
    mailbox.selectable &&
    capabilities?.settableFlags.includes("seen") &&
    mailbox.role !== "drafts" &&
    mailbox.role !== "sent"
  )
    general.push("mark-all-read");
  if (
    (mailbox.role === "trash" || mailbox.role === "junk") &&
    capabilities?.deleteForever
  )
    general.push("empty");

  const managing: MailboxMenuItem[] = [];
  const own = manage && isOwnMailbox(mailbox) && rules !== undefined;
  // A new mailbox inside this one is of the account's own kind.
  const childKind = folderAccount ? "folder" : "label";
  if (own) {
    if (rules.rename) managing.push("rename");
    if (rules.colors.length > 0) managing.push("colour");
    if (rules.nest) managing.push("move-under", "add-inside");
    if (rules.hide) managing.push("hide");
    managing.push("delete");
  } else if (
    manage &&
    (capabilities?.mailboxEditing[childKind]?.nest ?? false) &&
    isNestable(mailbox)
  )
    managing.push("add-inside");
  else if (
    folderAccount &&
    mailbox.standard === "categories" &&
    manage &&
    capabilities?.mailboxEditing.label !== undefined
  )
    managing.push("new-category");

  return { general, managing, cantRename: own && !rules.rename };
}

/** Whether a mailbox has a context menu at all. */
export function hasMailboxMenu(
  mailbox: Mailbox,
  capabilities: ProviderCapabilities | undefined,
  web: boolean,
): boolean {
  const { general, managing } = mailboxMenuItems(mailbox, capabilities, web);
  return general.length + managing.length > 0;
}
