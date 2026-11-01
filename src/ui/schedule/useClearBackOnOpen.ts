import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AccountId, MessageId } from "../../core/ids";
import { queryKeys } from "../../data/keys";
import { useApplyIntent } from "../../data/mutations";
import type { MessageListData } from "../../data/optimistic";

/**
 * Opening mail that came back from snooze takes its "back" mark off (it's
 * no longer pinned atop the Inbox). Quiet: nothing to undo.
 */
export function useClearBackOnOpen(
  accountId: AccountId,
  ids: readonly MessageId[],
): void {
  const queryClient = useQueryClient();
  const { mutateAsync: apply } = useApplyIntent();
  const key = ids.join(",");
  useEffect(() => {
    const wanted = new Set(key.split(","));
    const back = new Set<MessageId>();
    for (const [, data] of queryClient.getQueriesData<MessageListData>({
      queryKey: [...queryKeys.account(accountId), "messages"],
    }))
      for (const page of data?.pages ?? [])
        for (const item of page.items)
          if (item.backFromSnooze && wanted.has(item.id)) back.add(item.id);
    if (back.size === 0) return;
    apply({
      accountId,
      intent: { kind: "clear-back", ids: [...back] },
    }).catch(() => {
      // It stays pinned until it's opened again.
    });
  }, [accountId, key, apply, queryClient]);
}
