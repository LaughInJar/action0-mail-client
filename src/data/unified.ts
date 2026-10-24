import { useMemo } from "react";
import { useAccounts, useSignedIn } from "../accounts/context";
import type { AccountHandle } from "../accounts/types";
import type { AccountId, MailboxId } from "../core/ids";
import type { Mailbox } from "../core/model";
import type { MessageOrder } from "../core/provider";
import {
  messageListOptions,
  threadListOptions,
  useMailboxesOf,
  useNotWhileMutating,
} from "./hooks";
import { useInfiniteLists } from "./infiniteLists";
import type { ListSpec } from "./keys";
import { messageRows, threadRows, type ListRow } from "./listRows";
import { isolatingMailboxes } from "./optimistic";

/** What the UI needs of the query behind a list (one account's, or merged). */
export interface ListQuery {
  /** The first page isn't there yet. */
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  /** Loading anything (a refresh too). */
  readonly isFetching: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
  readonly refetch: () => Promise<unknown>;
}

/** One account's part of a list. */
export interface ListSource {
  readonly accountId: AccountId;
  readonly mailboxes: readonly Mailbox[] | undefined;
  /** The mailbox listed (All inboxes: the Inbox, or everything when searching everywhere). */
  readonly scope: Mailbox | undefined;
  readonly isolating: ReadonlySet<MailboxId>;
  /** Its rows are conversations. */
  readonly conversations: boolean;
}

/** One account's loaded rows, for {@link mergeByDate}. */
export interface MergeSource {
  readonly accountId: AccountId;
  /** In the provider's order. */
  readonly rows: readonly ListRow[];
  /** More pages can be loaded. */
  readonly hasMore: boolean;
}

/**
 * Merges the rows of several accounts by date, keeping each account's own
 * order. Rows only show down to the frontier: the date up to which every
 * account that has more pages has loaded. Further rows wait until that
 * account has loaded more; `behind` are the accounts to load more from.
 */
export function mergeByDate(
  sources: readonly MergeSource[],
  order: MessageOrder,
): { readonly rows: ListRow[]; readonly behind: AccountId[] } {
  const newest = order === "newest";
  /** `a` is listed before `b`. */
  const before = (a: string, b: string) => (newest ? a > b : a < b);
  const dateOf = (row: ListRow) => row.summary.receivedAt;

  // The frontier: the last loaded row that is listed first among accounts
  // with more to load (nothing at all while one of them has no rows).
  let frontier: string | undefined;
  let blocked = false;
  for (const source of sources) {
    if (!source.hasMore) continue;
    const last = source.rows.at(-1);
    if (!last) {
      blocked = true;
      continue;
    }
    if (frontier === undefined || before(dateOf(last), frontier))
      frontier = dateOf(last);
  }
  const behind = sources.flatMap((source) => {
    if (!source.hasMore) return [];
    const last = source.rows.at(-1);
    return !last || blocked || dateOf(last) === frontier
      ? [source.accountId]
      : [];
  });
  if (blocked) return { rows: [], behind };

  const shown = sources.map((source) => {
    if (frontier === undefined) return source.rows;
    const limit = frontier;
    const end = source.rows.findIndex((row) => before(limit, dateOf(row)));
    return end === -1 ? source.rows : source.rows.slice(0, end);
  });
  const rows: ListRow[] = [];
  const next = shown.map(() => 0);
  for (;;) {
    let best = -1;
    shown.forEach((list, index) => {
      const row = list[next[index] ?? 0];
      if (!row) return;
      const bestRow = best === -1 ? undefined : shown[best]?.[next[best] ?? 0];
      if (!bestRow || before(dateOf(row), dateOf(bestRow))) best = index;
    });
    if (best === -1) break;
    const index = next[best] ?? 0;
    const row = shown[best]?.[index];
    if (row) rows.push(row);
    next[best] = index + 1;
  }
  return { rows, behind };
}

/** Which All inboxes list: a search in it, and the order. */
export interface UnifiedSpec {
  /** Provider search syntax; omitted for the whole Inbox. */
  readonly search?: string;
  /** Searches each whole account instead of its Inbox. */
  readonly everywhere: boolean;
  readonly order: MessageOrder;
  /** Conversations where the account has them. */
  readonly conversations: boolean;
}

/** The merged list of All inboxes. */
export interface UnifiedList {
  readonly list: ListQuery;
  /** The rows, once every available account has its first page. */
  readonly rows: readonly ListRow[] | undefined;
  readonly sources: ReadonlyMap<AccountId, ListSource>;
  /** Accounts left out: they need reconnecting, or their list failed. */
  readonly unavailable: readonly AccountId[];
}

interface Planned {
  readonly handle: AccountHandle;
  readonly source: ListSource;
  readonly spec: ListSpec | undefined;
  /** The account can make requests. */
  readonly ready: boolean;
  /** Its mailboxes failed to load. */
  readonly failed: boolean;
}

/**
 * Every account's Inbox (or a search in it), merged by date. Each account's
 * list is its own cached list, so optimistic changes, live updates and the
 * short-lived cache work as for a single mailbox.
 */
export function useUnifiedList(spec: UnifiedSpec | undefined): UnifiedList {
  const handles = useAccounts();
  const signedIn = useSignedIn(handles);
  const mailboxes = useMailboxesOf(handles, signedIn);
  const quiet = useNotWhileMutating();
  const order = spec?.order ?? "newest";

  const planned = useMemo(
    () =>
      handles.map((handle): Planned => {
        const accountId = handle.account.id;
        const boxes = mailboxes.get(accountId);
        const inbox = boxes?.data?.find((mailbox) => mailbox.role === "inbox");
        const scope = spec?.everywhere
          ? (boxes?.data?.find((mailbox) => mailbox.role === "all") ?? inbox)
          : inbox;
        const ready = signedIn.has(accountId);
        return {
          handle,
          ready,
          failed: (boxes?.error ?? null) !== null && !boxes?.data,
          source: {
            accountId,
            mailboxes: boxes?.data,
            scope,
            isolating: isolatingMailboxes(boxes?.data ?? []),
            conversations:
              (spec?.conversations ?? false) &&
              handle.provider.capabilities.threads,
          },
          spec:
            spec && scope && ready
              ? {
                  mailboxId: scope.id,
                  order,
                  ...(spec.search === undefined ? {} : { search: spec.search }),
                }
              : undefined,
        };
      }),
    [handles, mailboxes, signedIn, spec, order],
  );

  const messagePlans = planned.filter(
    (plan) => plan.spec && !plan.source.conversations,
  );
  const threadPlans = planned.filter(
    (plan) => plan.spec && plan.source.conversations,
  );
  const messageResults = useInfiniteLists(
    messagePlans.map((plan) => ({
      ...quiet,
      ...messageListOptions(plan.source.accountId, plan.handle, plan.spec),
    })),
  );
  const threadResults = useInfiniteLists(
    threadPlans.map((plan) => ({
      ...quiet,
      ...threadListOptions(plan.source.accountId, plan.handle, plan.spec),
    })),
  );

  const results = [
    ...messagePlans.map((plan, index) => {
      const result = messageResults[index];
      return {
        plan,
        result,
        rows: result?.data
          ? messageRows(
              plan.source.accountId,
              result.data.pages.flatMap((page) => page.items),
            )
          : undefined,
      };
    }),
    ...threadPlans.map((plan, index) => {
      const result = threadResults[index];
      return {
        plan,
        result,
        rows: result?.data
          ? threadRows(
              plan.source.accountId,
              result.data.pages.flatMap((page) => page.items),
              plan.source.scope,
              plan.source.isolating,
            )
          : undefined,
      };
    }),
  ];

  const unavailable = planned.flatMap((plan) => {
    const listed = results.find((entry) => entry.plan === plan);
    const listFailed = listed?.result?.isError === true && !listed.rows;
    return !plan.ready || plan.failed || listFailed
      ? [plan.source.accountId]
      : [];
  });
  // Waiting for an account's mailboxes or first page.
  const pending =
    planned.some(
      (plan) =>
        plan.ready &&
        !plan.failed &&
        !plan.spec &&
        plan.source.scope === undefined,
    ) || results.some((entry) => !entry.rows && entry.result?.isError !== true);

  const merged = pending
    ? undefined
    : mergeByDate(
        results.flatMap((entry) =>
          entry.rows
            ? [
                {
                  accountId: entry.plan.source.accountId,
                  rows: entry.rows,
                  hasMore: entry.result?.hasNextPage ?? false,
                },
              ]
            : [],
        ),
        order,
      );
  const errors = results.flatMap((entry) =>
    entry.result?.error ? [entry.result.error] : [],
  );
  const behind = merged?.behind ?? [];

  const list: ListQuery = {
    isPending: pending,
    isError: !merged && errors.length > 0,
    error: errors[0] ?? null,
    isFetching: results.some((entry) => entry.result?.isFetching === true),
    hasNextPage: results.some((entry) => entry.result?.hasNextPage === true),
    isFetchingNextPage: results.some(
      (entry) => entry.result?.isFetchingNextPage === true,
    ),
    fetchNextPage: () =>
      Promise.all(
        results.flatMap((entry) =>
          entry.result && behind.includes(entry.plan.source.accountId)
            ? [entry.result.fetchNextPage()]
            : [],
        ),
      ),
    refetch: () =>
      Promise.all(
        results.flatMap((entry) =>
          entry.result ? [entry.result.refetch()] : [],
        ),
      ),
  };

  const sources = useMemo(
    () =>
      new Map(
        planned.map((plan) => [plan.source.accountId, plan.source] as const),
      ),
    [planned],
  );
  return { list, rows: merged?.rows, sources, unavailable };
}
