import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAccountRegistry } from "../accounts/context";
import {
  ruleChangesBack,
  withRuleChanges,
  type FocusRuleChange,
} from "../core/focus";
import type { AccountId, Cursor, MailboxId } from "../core/ids";
import type { FocusRule, MessageSummary } from "../core/model";
import type { MailProvider } from "../core/provider";
import { useReadyHandle } from "./hooks";
import { queryKeys } from "./keys";

/** Most of a sender's mail "Always move to …" moves along (the newest). */
export const MAX_SENDER_MAIL = 1000;
const PAGE_SIZE = 100;
const RULES_STALE_MS = 60_000;

/** An account's Focused Inbox sender rules, by address (memory only). */
export function useFocusRules(accountId: AccountId | undefined) {
  const handle = useReadyHandle(accountId);
  const provider = handle?.provider;
  return useQuery({
    queryKey: queryKeys.focusRules(accountId ?? ("" as AccountId)),
    queryFn:
      provider?.capabilities.focusedInbox === true
        ? async ({ signal }) =>
            withRuleChanges(await provider.listFocusRules(signal), [])
        : skipToken,
    staleTime: RULES_STALE_MS,
  });
}

/**
 * Changes sender rules: the cached rules change at once and come back if
 * the provider refuses. Resolves with the changes that undo it.
 */
export function useSetFocusRules(): (
  accountId: AccountId,
  changes: readonly FocusRuleChange[],
) => Promise<FocusRuleChange[]> {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  return useCallback(
    async (accountId, changes) => {
      const provider = registry.get(accountId)?.provider;
      if (!provider) throw new Error(`No account ${accountId}.`);
      const key = queryKeys.focusRules(accountId);
      await queryClient.cancelQueries({ queryKey: key });
      const before =
        queryClient.getQueryData<readonly FocusRule[]>(key) ??
        (await provider.listFocusRules());
      queryClient.setQueryData(key, withRuleChanges(before, changes));
      try {
        for (const change of changes)
          await provider.setFocusRule(change.address, change.focus);
      } catch (error) {
        queryClient.setQueryData(key, before);
        throw error;
      }
      return ruleChangesBack(before, changes);
    },
    [queryClient, registry],
  );
}

/**
 * A sender's mail in a mailbox (a side of the split Inbox), newest first,
 * at most {@link MAX_SENDER_MAIL}: searched by address, then matched
 * exactly on the sender.
 */
export async function senderMail(
  provider: MailProvider,
  mailboxId: MailboxId,
  address: string,
  signal?: AbortSignal,
): Promise<MessageSummary[]> {
  const wanted = address.toLowerCase();
  const found: MessageSummary[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await provider.listMessages(
      {
        mailboxId,
        search: address,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
      signal,
    );
    found.push(
      ...page.items.filter(
        (message) => message.from?.address.toLowerCase() === wanted,
      ),
    );
    cursor = page.nextCursor;
  } while (cursor && found.length < MAX_SENDER_MAIL);
  return found.slice(0, MAX_SENDER_MAIL);
}
