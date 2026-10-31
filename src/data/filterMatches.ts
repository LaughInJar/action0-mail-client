import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAccountRegistry } from "../accounts/context";
import type {
  FilterActions,
  FilterCapabilities,
  FilterConditions,
} from "../core/filters";
import { hasConditions } from "../core/filters";
import type { AccountId, Cursor, MailboxId, MessageId } from "../core/ids";
import { inverseOf, type MailIntent } from "../core/intents";
import type { MessageSummary } from "../core/model";
import { useReadyHandle } from "./hooks";
import { queryKeys } from "./keys";
import { cachedMailboxes, useApplyIntent, usePreviewIntent } from "./mutations";

/** Most messages "Also apply" acts on (the newest). */
export const MAX_FILTER_MATCHES = 1000;
const PAGE_SIZE = 100;

/** Mail a filter's conditions find where its server runs it. */
export interface FilterMatches {
  /** Where they were found: All mail (Gmail) or the Inbox. */
  readonly mailboxId: MailboxId;
  /** Newest first, at most {@link MAX_FILTER_MATCHES}. */
  readonly messages: readonly MessageSummary[];
  /** There are more; only the newest are in `messages`. */
  readonly capped: boolean;
}

/**
 * The mail an account's filter with these conditions would have caught
 * (`undefined` conditions: nothing to look for yet). Memory only.
 */
export function useFilterMatches(
  accountId: AccountId,
  conditions: FilterConditions | undefined,
  scope: FilterCapabilities["scope"] | undefined,
) {
  const handle = useReadyHandle(accountId);
  const queryClient = useQueryClient();
  const provider = handle?.provider;
  const filters = handle?.filters;
  const ready =
    provider !== undefined &&
    filters !== undefined &&
    conditions !== undefined &&
    scope !== undefined &&
    hasConditions(conditions);
  return useQuery({
    queryKey: queryKeys.filterMatches(accountId, { conditions, scope }),
    queryFn: ready
      ? async ({ signal }): Promise<FilterMatches | null> => {
          const mailboxes =
            cachedMailboxes(queryClient, accountId).length > 0
              ? cachedMailboxes(queryClient, accountId)
              : await provider.listMailboxes(signal);
          const role = scope === "all" ? "all" : "inbox";
          const where = mailboxes.find((mailbox) => mailbox.role === role);
          if (!where) return null;
          const search = filters.searchOf(conditions).trim();
          if (search === "" && !conditions.hasAttachment) return null;
          const messages: MessageSummary[] = [];
          let cursor: Cursor | undefined;
          do {
            const page = await provider.listMessages(
              {
                mailboxId: where.id,
                ...(search === "" ? {} : { search }),
                limit: PAGE_SIZE,
                ...(cursor ? { cursor } : {}),
              },
              signal,
            );
            messages.push(
              ...page.items.filter(
                (message) =>
                  !conditions.hasAttachment || message.hasAttachments,
              ),
            );
            cursor = page.nextCursor;
          } while (cursor && messages.length < MAX_FILTER_MATCHES);
          return {
            mailboxId: where.id,
            messages: messages.slice(0, MAX_FILTER_MATCHES),
            capped: messages.length > MAX_FILTER_MATCHES || !!cursor,
          };
        }
      : skipToken,
    staleTime: 30_000,
  });
}

/**
 * What a filter's actions do to mail that is already there, in the order
 * they run: labels and flags first, then out of the inbox, Trash last.
 * Forwarding and "never spam" don't apply to existing mail.
 */
export function filterIntents(
  actions: FilterActions,
  matches: FilterMatches,
): MailIntent[] {
  const ids: readonly MessageId[] = matches.messages.map(
    (message) => message.id,
  );
  if (ids.length === 0) return [];
  const flags = {
    ...(actions.markRead ? { seen: true } : {}),
    ...(actions.star ? { flagged: true } : {}),
  };
  return [
    ...(actions.labels.length > 0 && !actions.trash
      ? [
          {
            kind: "set-labels" as const,
            ids,
            add: actions.labels,
            remove: [],
          },
        ]
      : []),
    ...(Object.keys(flags).length > 0
      ? [{ kind: "set-flags" as const, ids, flags }]
      : []),
    ...(actions.trash
      ? [{ kind: "trash" as const, ids }]
      : actions.moveTo !== undefined
        ? [
            {
              kind: "move" as const,
              ids,
              from: matches.mailboxId,
              to: actions.moveTo,
            },
          ]
        : actions.skipInbox
          ? [{ kind: "archive" as const, ids }]
          : []),
  ];
}

/** What applying a filter to existing mail did, so it can be undone. */
export interface AppliedFilter {
  /** Messages it changed. */
  readonly changed: number;
  /** The intents that undo it, in order. */
  readonly undo: readonly MailIntent[];
  /** The messages as it left them. */
  readonly known: readonly MessageSummary[];
}

/**
 * Applies a filter's actions to mail it finds (see {@link filterIntents}),
 * one step after the other so each sees the last one's result, with the
 * same optimistic updates as the toolbar's actions.
 */
export function useApplyFilterToMatches(): (
  accountId: AccountId,
  actions: FilterActions,
  matches: FilterMatches,
) => Promise<AppliedFilter> {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  const preview = usePreviewIntent();
  const { mutateAsync: apply } = useApplyIntent();
  return useCallback(
    async (accountId, actions, matches) => {
      const folders =
        registry
          .get(accountId)
          ?.provider.capabilities.mailboxKinds.includes("folder") === true;
      const mailboxes = cachedMailboxes(queryClient, accountId);
      const latest = new Map(
        matches.messages.map((message) => [message.id, message]),
      );
      const changed = new Set<MessageId>();
      const undo: MailIntent[] = [];
      for (const intent of filterIntents(actions, matches)) {
        const known = [...latest.values()];
        const { changes } = preview({ accountId, intent, known });
        if (changes.length === 0) continue;
        await apply({
          accountId,
          intent: { ...intent, ids: changes.map((change) => change.id) },
          known,
        });
        for (const change of changes) {
          latest.set(change.id, change.after);
          changed.add(change.id);
        }
        undo.unshift(
          ...inverseOf(
            intent,
            changes,
            folders
              ? {
                  isFolder: (id) =>
                    mailboxes.find((mailbox) => mailbox.id === id)?.kind ===
                    "folder",
                }
              : {},
          ),
        );
      }
      return {
        changed: changed.size,
        undo,
        known: [...latest.values()].filter((message) =>
          changed.has(message.id),
        ),
      };
    },
    [apply, preview, queryClient, registry],
  );
}
