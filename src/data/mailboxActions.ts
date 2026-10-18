import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccountRegistry } from "../accounts/context";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import { MailError } from "../core/errors";
import type { AccountId, MailboxId } from "../core/ids";
import type { Mailbox, Message } from "../core/model";
import type { MailboxChange, NewMailbox } from "../core/provider";
import { queryKeys } from "./keys";
import type { MessageListData } from "./optimistic";

/**
 * The user's own mailboxes, which can be renamed, recoloured, moved, hidden
 * and deleted: labels and folders without a role that messages can go into.
 */
export function isOwnMailbox(mailbox: Mailbox): boolean {
  return (
    mailbox.selectable &&
    mailbox.assignable &&
    mailbox.role === undefined &&
    mailbox.kind !== "view"
  );
}

/**
 * Mailboxes others can be nested in: the user's own, and grouping nodes
 * that only exist because something is nested in them (Gmail's implied
 * parents).
 */
export function isNestable(mailbox: Mailbox): boolean {
  return (
    mailbox.kind !== "view" &&
    mailbox.role === undefined &&
    (isOwnMailbox(mailbox) || (!mailbox.selectable && !mailbox.assignable))
  );
}

/** Names from the top level down to `mailbox`, e.g. ["Work", "Clients"]. */
export function mailboxPath(
  mailbox: Mailbox,
  mailboxes: readonly Mailbox[],
): string[] {
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  const names = [mailbox.name];
  const seen = new Set([mailbox.id]);
  let parent =
    mailbox.parentId === undefined ? undefined : byId.get(mailbox.parentId);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    names.unshift(parent.name);
    parent =
      parent.parentId === undefined ? undefined : byId.get(parent.parentId);
  }
  return names;
}

/** `mailbox` and every mailbox nested in it, at any depth. */
export function subtreeIds(
  id: MailboxId,
  mailboxes: readonly Mailbox[],
): Set<MailboxId> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const mailbox of mailboxes) {
      if (
        mailbox.parentId !== undefined &&
        ids.has(mailbox.parentId) &&
        !ids.has(mailbox.id)
      ) {
        ids.add(mailbox.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** The change that undoes `change` on a mailbox that looked like `before`. */
export function inverseChange(
  before: Mailbox,
  change: MailboxChange,
): MailboxChange {
  return {
    ...(change.name === undefined ? {} : { name: before.name }),
    ...(change.parentId === undefined
      ? {}
      : { parentId: before.parentId ?? null }),
    ...(change.color === undefined ? {} : { color: before.color ?? null }),
    ...(change.hidden === undefined ? {} : { hidden: before.hidden }),
  };
}

/** `mailbox` with `change` applied. */
export function applyMailboxChange(
  mailbox: Mailbox,
  change: MailboxChange,
): Mailbox {
  const { parentId, color, ...rest } = mailbox;
  const nextParent =
    change.parentId === undefined ? parentId : (change.parentId ?? undefined);
  const nextColor =
    change.color === undefined ? color : (change.color ?? undefined);
  return {
    ...rest,
    ...(change.name === undefined ? {} : { name: change.name.trim() }),
    ...(change.hidden === undefined ? {} : { hidden: change.hidden }),
    ...(nextParent === undefined ? {} : { parentId: nextParent }),
    ...(nextColor === undefined ? {} : { color: nextColor }),
  };
}

/** Creates, changes and deletes the user's own mailboxes (labels, folders). */
export interface MailboxActions {
  /** Creates a mailbox; it's in the cached list once this resolves. */
  readonly create: (accountId: AccountId, spec: NewMailbox) => Promise<Mailbox>;
  /** Changes a mailbox right away in the cache; rolled back if the provider refuses. */
  readonly update: (
    accountId: AccountId,
    id: MailboxId,
    change: MailboxChange,
  ) => Promise<void>;
  /**
   * Deletes a mailbox: it leaves the cached list and every cached message
   * right away (nested ones move up a level until the list reloads), and
   * comes back if the provider refuses. Can't be undone.
   */
  readonly remove: (accountId: AccountId, id: MailboxId) => Promise<void>;
}

interface UpdateVariables {
  readonly accountId: AccountId;
  readonly id: MailboxId;
  readonly change: MailboxChange;
}

interface RemoveVariables {
  readonly accountId: AccountId;
  readonly id: MailboxId;
}

interface CreateVariables {
  readonly accountId: AccountId;
  readonly spec: NewMailbox;
}

function providerOf(registry: AccountRegistry, accountId: AccountId) {
  const handle = registry.get(accountId);
  if (!handle)
    throw new MailError(
      "auth-required",
      "This account is no longer connected.",
    );
  return handle.provider;
}

/**
 * Stops refetches of the mailboxes and lists (they'd overwrite the
 * optimistic state), then snapshots everything cached for the account.
 */
async function snapshot(queryClient: QueryClient, accountId: AccountId) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queryKeys.mailboxes(accountId) }),
    queryClient.cancelQueries({
      queryKey: [...queryKeys.account(accountId), "messages"],
    }),
  ]);
  return queryClient.getQueriesData({ queryKey: queryKeys.account(accountId) });
}

/** Puts the snapshot back (after a refused change). */
function restore(
  queryClient: QueryClient,
  saved: ReturnType<QueryClient["getQueriesData"]> | undefined,
) {
  for (const [key, data] of saved ?? []) queryClient.setQueryData(key, data);
}

/** Removes a mailbox from every cached row and message of the account. */
function stripMailbox(
  queryClient: QueryClient,
  accountId: AccountId,
  id: MailboxId,
) {
  const without = <T extends { readonly mailboxIds: readonly MailboxId[] }>(
    item: T,
  ): T =>
    item.mailboxIds.includes(id)
      ? { ...item, mailboxIds: item.mailboxIds.filter((m) => m !== id) }
      : item;
  queryClient.setQueriesData<MessageListData>(
    { queryKey: [...queryKeys.account(accountId), "messages"] },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map(without),
        })),
      },
  );
  queryClient.setQueriesData<Message>(
    { queryKey: [...queryKeys.account(accountId), "message"] },
    (message) => message && without(message),
  );
}

/** The app's {@link MailboxActions}. */
export function useMailboxActions(): MailboxActions {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  const refresh = (accountId: AccountId) =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.mailboxes(accountId),
    });

  const { mutateAsync: create } = useMutation({
    mutationFn: ({ accountId, spec }: CreateVariables) =>
      providerOf(registry, accountId).createMailbox(spec),
    onSuccess: (mailbox, { accountId }) => {
      queryClient.setQueryData<readonly Mailbox[]>(
        queryKeys.mailboxes(accountId),
        (mailboxes) => mailboxes && [...mailboxes, mailbox],
      );
    },
    onSettled: (_data, _error, { accountId }) => refresh(accountId),
  });

  const { mutateAsync: update } = useMutation({
    mutationFn: ({ accountId, id, change }: UpdateVariables) =>
      providerOf(registry, accountId).updateMailbox(id, change),
    onMutate: async ({ accountId, id, change }) => {
      const saved = await snapshot(queryClient, accountId);
      queryClient.setQueryData<readonly Mailbox[]>(
        queryKeys.mailboxes(accountId),
        (mailboxes) =>
          mailboxes?.map((mailbox) =>
            mailbox.id === id ? applyMailboxChange(mailbox, change) : mailbox,
          ),
      );
      return { saved };
    },
    onError: (_error, _variables, context) => {
      restore(queryClient, context?.saved);
    },
    onSettled: (_data, _error, { accountId }) => refresh(accountId),
  });

  const { mutateAsync: remove } = useMutation({
    mutationFn: ({ accountId, id }: RemoveVariables) =>
      providerOf(registry, accountId).deleteMailbox(id),
    onMutate: async ({ accountId, id }) => {
      const saved = await snapshot(queryClient, accountId);
      queryClient.setQueryData<readonly Mailbox[]>(
        queryKeys.mailboxes(accountId),
        (mailboxes) => {
          const gone = mailboxes?.find((mailbox) => mailbox.id === id);
          return mailboxes?.flatMap((mailbox) => {
            if (mailbox.id === id) return [];
            if (mailbox.parentId !== id) return [mailbox];
            const { parentId: _parent, ...rest } = mailbox;
            return [
              gone?.parentId === undefined
                ? rest
                : { ...rest, parentId: gone.parentId },
            ];
          });
        },
      );
      stripMailbox(queryClient, accountId, id);
      return { saved };
    },
    onError: (_error, _variables, context) => {
      restore(queryClient, context?.saved);
    },
    onSuccess: (_data, { accountId, id }) => {
      queryClient.removeQueries({
        queryKey: queryKeys.messages(accountId, id),
      });
    },
    onSettled: (_data, _error, { accountId }) => refresh(accountId),
  });

  return useMemo(
    (): MailboxActions => ({
      create: (accountId, spec) => create({ accountId, spec }),
      update: async (accountId, id, change) => {
        await update({ accountId, id, change });
      },
      remove: (accountId, id) => remove({ accountId, id }),
    }),
    [create, update, remove],
  );
}
