import { asMailboxId, type MailboxId } from "../../core/ids";
import type { Mailbox, MailboxColor, MailboxRole } from "../../core/model";
import type { GraphCategory, GraphMailFolder } from "./types";

/** The Flagged view: flagged messages of every folder (the star is Outlook's flag). */
export const FLAGGED_VIEW_ID = asMailboxId("view:flagged");

/** All mail except Deleted Items and Junk: used to search everywhere. */
export const ALL_VIEW_ID = asMailboxId("view:all");

/** Mailbox ids that are views of action0, not Outlook folders. */
export function isViewId(id: string): boolean {
  return id.startsWith("view:");
}

/**
 * Categories are listed like views (from all mail), by name: Outlook can't
 * rename a category, so its name is stable.
 */
const CATEGORY_PREFIX = "view:category:";

/** The node the categories are grouped under in the folder list. */
export const CATEGORIES_GROUP_ID = asMailboxId("view:categories");

/** The mailbox id of a category. */
export const categoryId = (name: string): MailboxId =>
  asMailboxId(`${CATEGORY_PREFIX}${name}`);

/** The name of a category's mailbox id; undefined for other ids. */
export function categoryName(id: string): string | undefined {
  return id.startsWith(CATEGORY_PREFIX)
    ? id.slice(CATEGORY_PREFIX.length)
    : undefined;
}

/**
 * Outlook's 25 category colours, `preset0` … `preset24` in order: red,
 * orange, brown, yellow, green, teal, olive, blue, purple, cranberry,
 * steel, dark steel, grey, dark grey, black, then the dark variants.
 */
export const OUTLOOK_CATEGORY_COLORS: readonly MailboxColor[] = [
  { background: "#e74856", text: "#ffffff" },
  { background: "#ff8c00", text: "#000000" },
  { background: "#ab620d", text: "#ffffff" },
  { background: "#fff100", text: "#000000" },
  { background: "#47d041", text: "#000000" },
  { background: "#30c6cc", text: "#000000" },
  { background: "#73aa24", text: "#000000" },
  { background: "#4cb4e7", text: "#000000" },
  { background: "#8764b8", text: "#ffffff" },
  { background: "#f495bf", text: "#000000" },
  { background: "#a0aebe", text: "#000000" },
  { background: "#5a7384", text: "#ffffff" },
  { background: "#b1adab", text: "#000000" },
  { background: "#5d5a58", text: "#ffffff" },
  { background: "#000000", text: "#ffffff" },
  { background: "#750b1c", text: "#ffffff" },
  { background: "#ca5010", text: "#ffffff" },
  { background: "#8e562e", text: "#ffffff" },
  { background: "#986f0b", text: "#ffffff" },
  { background: "#0b6a0b", text: "#ffffff" },
  { background: "#038387", text: "#ffffff" },
  { background: "#5c7e01", text: "#ffffff" },
  { background: "#004e8c", text: "#ffffff" },
  { background: "#5c2e91", text: "#ffffff" },
  { background: "#9b0062", text: "#ffffff" },
];

/** The colour of a category preset (`preset7`); none for `none` or unknown ones. */
export function colorOfPreset(
  preset: string | undefined,
): MailboxColor | undefined {
  const index = /^preset(\d+)$/.exec(preset ?? "")?.[1];
  return index === undefined
    ? undefined
    : OUTLOOK_CATEGORY_COLORS[Number(index)];
}

/** The preset of a colour (`none` if it isn't one of Outlook's). */
export function presetOf(color: MailboxColor | null | undefined): string {
  const index = OUTLOOK_CATEGORY_COLORS.findIndex(
    (candidate) => candidate.background === color?.background,
  );
  return index === -1 ? "none" : `preset${String(index)}`;
}

/** The categories' group node (named by the app: "Categories"). */
export const CATEGORIES_GROUP: Mailbox = {
  id: CATEGORIES_GROUP_ID,
  standard: "categories",
  name: "Categories",
  kind: "view",
  selectable: false,
  hidden: false,
  assignable: false,
};

/** One Outlook category as a label mailbox (in the categories group). */
export function toCategory(
  category: GraphCategory,
  unread: number | undefined,
): Mailbox {
  const color = colorOfPreset(category.color);
  return {
    id: categoryId(category.displayName),
    name: category.displayName,
    parentId: CATEGORIES_GROUP_ID,
    kind: "label",
    selectable: true,
    hidden: false,
    assignable: true,
    ...(color ? { color } : {}),
    ...(unread === undefined ? {} : { counts: { unread, total: 0 } }),
  };
}

/** Outlook's well-known folder names with a role. */
export const ROLE_FOLDERS: ReadonlyMap<string, MailboxRole> = new Map([
  ["inbox", "inbox"],
  ["drafts", "drafts"],
  ["sentitems", "sent"],
  ["deleteditems", "trash"],
  ["junkemail", "junk"],
  ["archive", "archive"],
]);

/** Outlook's internal folders, which aren't shown (nor what's inside them). */
export const INTERNAL_FOLDERS: readonly string[] = [
  "outbox",
  "conversationhistory",
  "syncissues",
  "scheduled",
  "searchfolders",
];

/** The root of the folder tree; its children are the top level. */
export const ROOT_FOLDER = "msgfolderroot";

/** Every well-known name the provider resolves to a folder id. */
export const WELL_KNOWN_NAMES: readonly string[] = [
  ...ROLE_FOLDERS.keys(),
  ...INTERNAL_FOLDERS,
  ROOT_FOLDER,
];

/** `$select` of folder requests. */
export const FOLDER_SELECT =
  "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount";

/** Folder ids by well-known name (names whose folder doesn't exist are absent). */
export type WellKnownFolders = ReadonlyMap<string, string>;

/** The role of a folder id, if it is one of the well-known ones. */
export function roleOf(
  id: string,
  wellKnown: WellKnownFolders,
): MailboxRole | undefined {
  for (const [name, role] of ROLE_FOLDERS)
    if (wellKnown.get(name) === id) return role;
  return undefined;
}

/** Ids of the internal folders. */
export function internalIds(wellKnown: WellKnownFolders): ReadonlySet<string> {
  return new Set(
    INTERNAL_FOLDERS.flatMap((name) => {
      const id = wellKnown.get(name);
      return id === undefined ? [] : [id];
    }),
  );
}

/** One Outlook folder as a mailbox. */
export function toMailbox(
  folder: GraphMailFolder,
  wellKnown: WellKnownFolders,
): Mailbox {
  const role = roleOf(folder.id, wellKnown);
  const root = wellKnown.get(ROOT_FOLDER);
  const parent = folder.parentFolderId;
  return {
    id: asMailboxId(folder.id),
    name: folder.displayName ?? "",
    ...(parent === undefined || parent === root || role !== undefined
      ? {}
      : { parentId: asMailboxId(parent) }),
    kind: "folder",
    ...(role === undefined ? {} : { role }),
    selectable: true,
    hidden: false,
    // Drafts and Sent fill themselves.
    assignable: role !== "drafts" && role !== "sent",
    counts: {
      unread: folder.unreadItemCount ?? 0,
      total: folder.totalItemCount ?? 0,
    },
  };
}

const VIEWS: readonly Mailbox[] = [
  {
    id: FLAGGED_VIEW_ID,
    name: "Flagged",
    kind: "view",
    role: "flagged",
    selectable: true,
    hidden: false,
    assignable: false,
  },
  {
    id: ALL_VIEW_ID,
    name: "All mail",
    kind: "view",
    role: "all",
    selectable: true,
    // Outlook has no such folder; it's there to search everywhere.
    hidden: true,
    assignable: false,
  },
];

/**
 * The account's mailboxes: Outlook's folders (without the internal ones and
 * anything inside them) and action0's views, role folders first.
 */
export function mapFolders(
  folders: readonly GraphMailFolder[],
  wellKnown: WellKnownFolders,
): Mailbox[] {
  const internal = internalIds(wellKnown);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const isInternal = (folder: GraphMailFolder): boolean => {
    for (
      let at: GraphMailFolder | undefined = folder;
      at !== undefined;
      at =
        at.parentFolderId === undefined
          ? undefined
          : byId.get(at.parentFolderId)
    ) {
      if (internal.has(at.id)) return true;
    }
    return false;
  };
  const shown = folders
    .filter((folder) => !isInternal(folder))
    .map((folder) => toMailbox(folder, wellKnown));
  return [
    ...shown.filter((mailbox) => mailbox.role !== undefined),
    ...VIEWS,
    ...shown.filter((mailbox) => mailbox.role === undefined),
  ];
}

/** Folder ids of a mailbox list (views left out). */
export function folderIdsOf(mailboxes: readonly Mailbox[]): MailboxId[] {
  return mailboxes
    .filter((mailbox) => mailbox.kind === "folder")
    .map((mailbox) => mailbox.id);
}
