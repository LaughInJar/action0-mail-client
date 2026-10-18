import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccountRegistry } from "../accounts/context";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import type { AccountId, MailboxId, SyncToken } from "../core/ids";
import type { Mailbox, Message, MessageSummary } from "../core/model";
import type { ChangeSet } from "../core/provider";
import { listSpecOfKey, queryKeys } from "./keys";
import {
  applyServerChanges,
  isolatingMailboxes,
  type MessageListData,
} from "./optimistic";

/** New mail found by a check: unread Inbox messages not sent by the account itself. */
export interface Arrivals {
  readonly accountId: AccountId;
  readonly inboxId: MailboxId;
  readonly messages: readonly MessageSummary[];
}

/** Keeps the cache of each account in step with the provider. */
export interface MailSync {
  /**
   * Asks the account's provider what changed and applies it to the cache.
   * Checks of one account never overlap. Skipped (and repeated next time)
   * while the session can't make requests or a change of the app's own is
   * still on its way.
   */
  readonly check: (accountId: AccountId) => Promise<Arrivals | undefined>;
}

const instances = new WeakMap<QueryClient, MailSync>();

/** The app's {@link MailSync}. */
export function useMailSyncService(): MailSync {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useMemo(() => {
    let sync = instances.get(queryClient);
    if (!sync) {
      sync = createMailSync(queryClient, registry);
      instances.set(queryClient, sync);
    }
    return sync;
  }, [queryClient, registry]);
}

/** Creates a {@link MailSync}; see {@link useMailSyncService}. */
export function createMailSync(
  queryClient: QueryClient,
  registry: AccountRegistry,
): MailSync {
  const tokens = new Map<AccountId, SyncToken>();
  const running = new Map<AccountId, Promise<Arrivals | undefined>>();

  const apply = (
    accountId: AccountId,
    set: ChangeSet,
  ): Arrivals | undefined => {
    const account = [...queryKeys.account(accountId)];
    if (set.reset) {
      void queryClient.invalidateQueries({ queryKey: account });
      return undefined;
    }
    if (set.changes.length === 0) return undefined;

    const mailboxes =
      queryClient.getQueryData<readonly Mailbox[]>(
        queryKeys.mailboxes(accountId),
      ) ?? [];
    const isolating = isolatingMailboxes(mailboxes);
    for (const [key, data] of queryClient.getQueriesData<MessageListData>({
      queryKey: [...account, "messages"],
    })) {
      const spec = listSpecOfKey(key);
      if (!data || !spec) continue;
      // Whether a message matches a search is the provider's call.
      if (spec.search !== undefined) {
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
        continue;
      }
      const mailbox = mailboxes.find((m) => m.id === spec.mailboxId);
      if (mailbox)
        queryClient.setQueryData(
          key,
          applyServerChanges(data, mailbox, set.changes, isolating, spec.order),
        );
    }
    for (const change of set.changes) {
      if (change.kind === "removed") continue;
      const { id, mailboxIds, flags } = change.message;
      queryClient.setQueryData<Message>(
        queryKeys.message(accountId, id),
        (message) => message && { ...message, mailboxIds, flags },
      );
    }
    void queryClient.invalidateQueries({
      queryKey: queryKeys.mailboxes(accountId),
    });

    const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");
    const me = registry.get(accountId)?.account.email.toLowerCase();
    const arrived = set.changes.flatMap((change) =>
      change.kind === "added" &&
      inbox !== undefined &&
      !change.message.flags.seen &&
      change.message.mailboxIds.includes(inbox.id) &&
      !change.message.mailboxIds.some((id) => isolating.has(id)) &&
      change.message.from?.address.toLowerCase() !== me
        ? [change.message]
        : [],
    );
    return inbox && arrived.length > 0
      ? { accountId, inboxId: inbox.id, messages: arrived }
      : undefined;
  };

  const run = async (accountId: AccountId) => {
    const handle = registry.get(accountId);
    // Our own optimistic changes would be overwritten by older server state.
    if (handle?.auth.status !== "signed-in" || queryClient.isMutating() > 0)
      return undefined;
    const set = await handle.provider.changesSince(tokens.get(accountId));
    // A change started meanwhile: keep the old token and try again later.
    if (queryClient.isMutating() > 0) return undefined;
    tokens.set(accountId, set.token);
    return apply(accountId, set);
  };

  return {
    check: (accountId) => {
      const current = running.get(accountId);
      if (current) return current;
      const next = run(accountId).finally(() => {
        running.delete(accountId);
      });
      running.set(accountId, next);
      return next;
    },
  };
}
