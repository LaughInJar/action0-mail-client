import type { MessageId } from "../../core/ids";
import type { MessageSummary } from "../../core/model";
import { IconButton } from "../common/IconButton";
import type { MailActions } from "./useMailActions";
import { useT } from "../../i18n/context";

/** Props of {@link MailActionButtons}. */
export interface MailActionButtonsProps {
  readonly actions: MailActions;
  /**
   * The message shown in the reader, whose state drives the toggles. Omit
   * for the selection bar: then the buttons act on the selection.
   */
  readonly message?: MessageSummary;
  /** Whether Archive applies (the message is in the Inbox). */
  readonly archivable?: boolean;
}

/**
 * The action buttons for a message or the selection. Inside Trash and Spam
 * the set changes: messages there can only be restored or deleted forever.
 */
export function MailActionButtons({
  actions,
  message,
  archivable = true,
}: MailActionButtonsProps) {
  const ids: readonly MessageId[] | undefined = message
    ? [message.id]
    : undefined;
  const quarantined = actions.view === "trash" || actions.view === "junk";
  const a = useT().actions;

  const readState =
    actions.canSetSeen &&
    (message ? (
      <IconButton
        label={message.flags.seen ? a.markUnreadButton : a.markReadButton}
        icon={message.flags.seen ? "mail" : "mail-open"}
        onClick={() => {
          actions.setSeen(!message.flags.seen, { ids: [message.id] });
        }}
      />
    ) : (
      <>
        <IconButton
          label={a.markReadButton}
          icon="mail-open"
          onClick={() => {
            actions.setSeen(true);
          }}
        />
        <IconButton
          label={a.markUnreadButton}
          icon="mail"
          onClick={() => {
            actions.setSeen(false);
          }}
        />
      </>
    ));

  if (quarantined) {
    return (
      <>
        {actions.view === "trash" && actions.canTrash && (
          <IconButton
            label={a.restoreButton}
            icon="inbox"
            onClick={() => {
              actions.trash(ids);
            }}
          />
        )}
        {actions.view === "junk" && actions.canSpam && (
          <IconButton
            label={a.notSpamButton}
            icon="inbox"
            onClick={() => {
              actions.spam(ids);
            }}
          />
        )}
        {actions.canDeleteForever && (
          <IconButton
            label={a.deleteForeverButton}
            icon="trash"
            danger
            onClick={() => {
              actions.requestDeleteForever(ids);
            }}
          />
        )}
        {readState}
      </>
    );
  }

  return (
    <>
      {actions.canArchive && (
        <IconButton
          label={archivable ? a.archiveButton : a.notInInboxButton}
          icon="archive"
          disabled={!archivable}
          onClick={() => {
            actions.archive(ids);
          }}
        />
      )}
      {actions.canTrash && (
        <IconButton
          label={a.trashButton}
          icon="trash"
          onClick={() => {
            actions.trash(ids);
          }}
        />
      )}
      {actions.canSpam && (
        <IconButton
          label={a.spamButton}
          icon="alert"
          onClick={() => {
            actions.spam(ids);
          }}
        />
      )}
      {actions.canMove && (
        <IconButton
          label={a.moveButton}
          icon="folder"
          onClick={() => {
            actions.openPicker("move", ids);
          }}
        />
      )}
      {actions.canLabel && (
        <IconButton
          label={a.labelsButton}
          icon="tag"
          onClick={() => {
            actions.openPicker("labels", ids);
          }}
        />
      )}
      {actions.canStar && (
        <IconButton
          label={
            message
              ? message.flags.flagged
                ? a.unstarButton
                : a.starButton
              : a.starOrUnstarButton
          }
          icon="star"
          {...(message ? { pressed: message.flags.flagged } : {})}
          onClick={() => {
            actions.toggleStar(ids);
          }}
        />
      )}
      {readState}
    </>
  );
}
