import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { AccountId, MailboxId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import type { MailboxChange, NewMailbox } from "../../core/provider";
import {
  inverseChange,
  isNestable,
  mailboxPath,
  subtreeIds,
  useMailboxActions,
} from "../../data/mailboxActions";
import { cachedMailboxes } from "../../data/mutations";
import { useRouter, useUiStore } from "../../state/context";
import type { ConfirmAction } from "../../state/uiStore";
import { errorMessage } from "../common/errorMessage";

/** The confirmed action of a "delete label" confirmation. */
export type DeleteLabelAction = Extract<
  ConfirmAction,
  { readonly kind: "delete-label" }
>;

/** Label management with toasts, undo and confirmation. */
export interface LabelActions {
  /**
   * Creates a label. With `undoable`, the toast offers Undo (which deletes
   * it again). Rejects with the reason; callers show it.
   */
  readonly create: (
    accountId: AccountId,
    spec: NewMailbox,
    options?: { readonly undoable?: boolean },
  ) => Promise<Mailbox>;
  /**
   * Creates the label at a path typed by the user ("Work/2026"), nested in
   * the existing labels along it; missing ones on the way are created too.
   */
  readonly createPath: (
    accountId: AccountId,
    path: readonly string[],
  ) => Promise<Mailbox>;
  /** Changes a label; the toast offers Undo. Rejects with the reason. */
  readonly edit: (
    accountId: AccountId,
    mailbox: Mailbox,
    change: MailboxChange,
  ) => Promise<void>;
  /** Hides a label from the folder list or shows it again (undoable). */
  readonly toggleHidden: (accountId: AccountId, mailbox: Mailbox) => void;
  /** Asks for confirmation before deleting. */
  readonly requestDelete: (accountId: AccountId, mailbox: Mailbox) => void;
  /** Deletes, after the user confirmed. */
  readonly runDelete: (action: DeleteLabelAction) => void;
}

/** Splits a typed path into names: "Work / 2026" → ["Work", "2026"]. */
export function splitPath(text: string): string[] {
  return text
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Where a typed path ends up: the deepest existing mailbox along it (that
 * labels can be nested in) and the names still missing below it.
 */
export function resolvePath(
  path: readonly string[],
  mailboxes: readonly Mailbox[],
): { readonly parentId?: MailboxId; readonly missing: readonly string[] } {
  const key = (names: readonly string[]) =>
    names.map((name) => name.toLowerCase()).join("/");
  const byPath = new Map(
    mailboxes
      .filter(isNestable)
      .map((mailbox) => [key(mailboxPath(mailbox, mailboxes)), mailbox.id]),
  );
  for (let length = path.length; length > 0; length--) {
    const found = byPath.get(key(path.slice(0, length)));
    if (found !== undefined)
      return { parentId: found, missing: path.slice(length) };
  }
  return { missing: path };
}

/** What a change did, for its toast. */
function describe(
  before: Mailbox,
  change: MailboxChange,
  mailboxes: readonly Mailbox[],
): string {
  const fields = Object.keys(change).length;
  const name = change.name?.trim() ?? before.name;
  if (fields !== 1) return `Saved label “${name}”`;
  if (change.name !== undefined) return `Renamed “${before.name}” to “${name}”`;
  if (change.parentId !== undefined) {
    const parent = mailboxes.find((m) => m.id === change.parentId);
    return parent
      ? `Moved “${name}” under “${parent.name}”`
      : `Moved “${name}” to the top level`;
  }
  if (change.color !== undefined)
    return change.color
      ? `Changed the colour of “${name}”`
      : `Removed the colour of “${name}”`;
  return change.hidden
    ? `Hid “${name}” from the folder list`
    : `“${name}” shows in the folder list again`;
}

/** The app's {@link LabelActions}. */
export function useLabelActions(): LabelActions {
  const actions = useMailboxActions();
  const queryClient = useQueryClient();
  const store = useUiStore();
  const router = useRouter();

  return useMemo((): LabelActions => {
    const showError = (prefix: string) => (error: unknown) => {
      store.getState().showToast({
        message: `${prefix}: ${errorMessage(error)}`,
        tone: "error",
      });
    };

    const edit: LabelActions["edit"] = async (accountId, mailbox, change) => {
      const mailboxes = cachedMailboxes(queryClient, accountId);
      await actions.update(accountId, mailbox.id, change);
      const inverse = inverseChange(mailbox, change);
      store.getState().showToast({
        message: describe(mailbox, change, mailboxes),
        tone: "info",
        revert: () => {
          actions
            .update(accountId, mailbox.id, inverse)
            .catch(showError("Couldn’t undo"));
        },
      });
    };

    return {
      create: async (accountId, spec, { undoable = false } = {}) => {
        const mailbox = await actions.create(accountId, spec);
        store.getState().showToast({
          message: `Created label “${mailbox.name}”`,
          tone: "info",
          ...(undoable
            ? {
                revert: () => {
                  actions
                    .remove(accountId, mailbox.id)
                    .catch(showError("Couldn’t undo"));
                },
              }
            : {}),
        });
        return mailbox;
      },

      createPath: async (accountId, path) => {
        const { parentId, missing } = resolvePath(
          path,
          cachedMailboxes(queryClient, accountId),
        );
        let parent = parentId;
        let created: Mailbox | undefined;
        for (const name of missing) {
          created = await actions.create(accountId, {
            name,
            ...(parent === undefined ? {} : { parentId: parent }),
          });
          parent = created.id;
        }
        if (!created) throw new Error("That label exists already.");
        return created;
      },

      edit,

      toggleHidden: (accountId, mailbox) => {
        edit(accountId, mailbox, { hidden: !mailbox.hidden }).catch(
          showError("Couldn’t change the label"),
        );
      },

      requestDelete: (accountId, mailbox) => {
        const mailboxes = cachedMailboxes(queryClient, accountId);
        const nested = subtreeIds(mailbox.id, mailboxes).size > 1;
        store.getState().setConfirm({
          title: `Delete label “${mailbox.name}”?`,
          message: `Messages keep their other labels${nested ? ", and the labels inside it stay" : ""}. This can’t be undone.`,
          confirmLabel: "Delete label",
          action: {
            kind: "delete-label",
            accountId,
            mailboxId: mailbox.id,
            name: mailbox.name,
          },
        });
      },

      runDelete: ({ accountId, mailboxId, name }) => {
        const state = store.getState();
        state.setConfirm(null);
        state.setLabelMenu(null);
        const dialog = state.labelDialog;
        if (dialog?.mode === "edit" && dialog.mailboxId === mailboxId)
          state.setLabelDialog(null);
        // Don't stay in a mailbox that's about to vanish.
        const route = router.getRoute();
        if (route?.accountId === accountId && route.mailboxId === mailboxId) {
          const inbox = cachedMailboxes(queryClient, accountId).find(
            (mailbox) => mailbox.role === "inbox",
          );
          router.navigate(inbox ? { accountId, mailboxId: inbox.id } : null, {
            replace: true,
          });
        }
        actions.remove(accountId, mailboxId).then(
          () => {
            store.getState().showToast({
              message: `Deleted label “${name}”`,
              tone: "info",
            });
          },
          showError(`Couldn’t delete “${name}”`),
        );
      },
    };
  }, [actions, queryClient, router, store]);
}
