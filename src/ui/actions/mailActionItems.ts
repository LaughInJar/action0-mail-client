import { messageKey, type AccountId, type MessageKey } from "../../core/ids";
import type { MessageSummary } from "../../core/model";
import type { IconName } from "../common/Icon";
import type { MailActions } from "./useMailActions";
import type { I18n } from "../../i18n/context";

/** One action of a toolbar (see `OverflowToolbar`). */
export interface ToolbarItem {
  readonly id: string;
  /** Accessible name and tooltip, with the shortcut ("Archive (a)"). */
  readonly label: string;
  readonly icon: IconName;
  readonly run: () => void;
  readonly disabled?: boolean;
  /** Toggle state (the star). */
  readonly pressed?: boolean;
  readonly danger?: boolean;
  /**
   * When space runs out, items move into the ⋯ menu lowest `keep` first;
   * without one an item always stays.
   */
  readonly keep?: number;
  /** Answering (Reply, Forward) or acting on the mail; a divider separates them. */
  readonly group: "answer" | "mail";
}

/** What the mail actions act on. */
export interface MailActionTarget {
  /**
   * The message shown in the reader, whose state drives the toggles. Omit
   * for the selection bar: then the buttons act on the selection.
   */
  readonly message?: MessageSummary;
  /** The account of `message`. */
  readonly accountId?: AccountId;
  /** Whether Archive applies (the message is in the Inbox). */
  readonly archivable?: boolean;
  /** Explicit rows to act on (a context menu); else `message`, else the targets. */
  readonly keys?: readonly MessageKey[];
  /** The keys are messages, not rows (one message of a conversation). */
  readonly exact?: boolean;
}

/**
 * The mail actions for a message or the selection, as toolbar items.
 * Inside Trash and Spam the set changes: messages there can only be
 * restored or deleted forever.
 */
export function mailActionItems(
  actions: MailActions,
  {
    message,
    accountId,
    archivable = true,
    keys,
    exact = false,
  }: MailActionTarget,
  a: I18n["actions"],
): ToolbarItem[] {
  const ids: readonly MessageKey[] | undefined =
    keys ??
    (message && accountId !== undefined
      ? [messageKey(accountId, message.id)]
      : undefined);
  const options = { exact };
  const quarantined = actions.view === "trash" || actions.view === "junk";
  const item = (fields: Omit<ToolbarItem, "group">): ToolbarItem => ({
    ...fields,
    group: "mail",
  });

  const readState: ToolbarItem[] = !actions.canSetSeen
    ? []
    : message
      ? [
          item({
            id: "read",
            label: message.flags.seen ? a.markUnreadButton : a.markReadButton,
            icon: message.flags.seen ? "mail" : "mail-open",
            keep: 8,
            run: () => {
              actions.setSeen(!message.flags.seen, {
                ...(ids ? { keys: ids } : {}),
                exact,
              });
            },
          }),
        ]
      : [
          item({
            id: "read",
            label: a.markReadButton,
            icon: "mail-open",
            keep: 8,
            run: () => {
              actions.setSeen(true, { ...(ids ? { keys: ids } : {}), exact });
            },
          }),
          item({
            id: "unread",
            label: a.markUnreadButton,
            icon: "mail",
            keep: 8,
            run: () => {
              actions.setSeen(false, { ...(ids ? { keys: ids } : {}), exact });
            },
          }),
        ];

  if (quarantined)
    return [
      ...(actions.view === "trash" && actions.canTrash
        ? [
            item({
              id: "restore",
              label: a.restoreButton,
              icon: "inbox",
              run: () => {
                actions.trash(ids, options);
              },
            }),
          ]
        : []),
      ...(actions.view === "junk" && actions.canSpam
        ? [
            item({
              id: "not-spam",
              label: a.notSpamButton,
              icon: "inbox",
              run: () => {
                actions.spam(ids, options);
              },
            }),
          ]
        : []),
      ...(actions.canDeleteForever
        ? [
            item({
              id: "delete-forever",
              label: a.deleteForeverButton,
              icon: "trash",
              danger: true,
              run: () => {
                actions.requestDeleteForever(ids);
              },
            }),
          ]
        : []),
      ...readState,
    ];

  return [
    ...(actions.canArchive
      ? [
          item({
            id: "archive",
            label: archivable ? a.archiveButton : a.notInInboxButton,
            icon: "archive",
            disabled: !archivable,
            run: () => {
              actions.archive(ids, options);
            },
          }),
        ]
      : []),
    ...(actions.canTrash
      ? [
          item({
            id: "trash",
            label: a.trashButton,
            icon: "trash",
            run: () => {
              actions.trash(ids, options);
            },
          }),
        ]
      : []),
    ...(actions.canSpam
      ? [
          item({
            id: "spam",
            label: a.spamButton,
            icon: "alert",
            keep: 3,
            run: () => {
              actions.spam(ids, options);
            },
          }),
        ]
      : []),
    ...(actions.canMove
      ? [
          item({
            id: "move",
            label: a.moveButton,
            icon: "folder",
            keep: 5,
            run: () => {
              actions.openPicker("move", ids, options);
            },
          }),
        ]
      : []),
    ...(actions.canLabel
      ? [
          item({
            id: "labels",
            label: actions.labelsAreCategories
              ? a.categoriesButton
              : a.labelsButton,
            icon: "tag",
            keep: 4,
            run: () => {
              actions.openPicker("labels", ids, options);
            },
          }),
        ]
      : []),
    ...(actions.canStar
      ? [
          item({
            id: "star",
            label: message
              ? message.flags.flagged
                ? a.unstarButton
                : a.starButton
              : a.starOrUnstarButton,
            icon: "star",
            ...(message ? { pressed: message.flags.flagged } : {}),
            keep: 7,
            run: () => {
              actions.toggleStar(ids, options);
            },
          }),
        ]
      : []),
    ...readState,
  ];
}
