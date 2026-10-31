import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import { useAccountRegistry } from "../accounts/context";
import { MailError } from "../core/errors";
import type {
  AutoReply,
  FilterId,
  FilterProvider,
  FilterSetup,
  FilterSpec,
  MailFilter,
} from "../core/filters";
import type { AccountId } from "../core/ids";
import { useReadyHandle } from "./hooks";
import { queryKeys } from "./keys";

/** Filters and automatic replies rarely change elsewhere. */
const FILTERS_STALE_MS = 5 * 60_000;

/**
 * An account's filters, automatic reply and what can be changed (accounts
 * whose provider has filters). Memory only.
 */
export function useFilterSetup(accountId: AccountId | undefined) {
  const handle = useReadyHandle(accountId);
  const filters = handle?.filters;
  return useQuery({
    queryKey: queryKeys.filters(accountId ?? ("" as AccountId)),
    queryFn: filters ? ({ signal }) => filters.load(signal) : skipToken,
    staleTime: FILTERS_STALE_MS,
  });
}

/**
 * The account's automatic reply, for the notice above the list; checked
 * again every 5 minutes. `undefined` while unknown (or for a mail server
 * whose filter server hasn't been found yet).
 */
export function useAutoReply(accountId: AccountId | undefined) {
  const handle = useReadyHandle(accountId);
  const filters = handle?.filters;
  return useQuery({
    queryKey: queryKeys.autoReply(accountId ?? ("" as AccountId)),
    queryFn: filters
      ? async ({ signal }) => (await filters.autoReply(signal)) ?? null
      : skipToken,
    staleTime: FILTERS_STALE_MS,
    refetchInterval: FILTERS_STALE_MS,
  });
}

/** Where a new filter goes, or which one changes. */
export type FilterTarget =
  | { readonly kind: "new"; readonly position?: number }
  | { readonly kind: "edit"; readonly filter: MailFilter };

/** Changes to an account's filters and automatic reply. */
export interface FilterChanges {
  /** Saves a new or changed filter; resolves with it as the server keeps it. */
  readonly save: (
    accountId: AccountId,
    target: FilterTarget,
    spec: FilterSpec,
  ) => Promise<MailFilter>;
  readonly setEnabled: (
    accountId: AccountId,
    id: FilterId,
    enabled: boolean,
  ) => Promise<void>;
  /** Puts the filters into this order. */
  readonly reorder: (
    accountId: AccountId,
    ids: readonly FilterId[],
  ) => Promise<void>;
  readonly remove: (accountId: AccountId, id: FilterId) => Promise<void>;
  readonly setAutoReply: (
    accountId: AccountId,
    reply: AutoReply,
  ) => Promise<void>;
}

type Change =
  | {
      readonly kind: "save";
      readonly target: FilterTarget;
      readonly spec: FilterSpec;
    }
  | {
      readonly kind: "enable";
      readonly id: FilterId;
      readonly enabled: boolean;
    }
  | { readonly kind: "reorder"; readonly ids: readonly FilterId[] }
  | { readonly kind: "remove"; readonly id: FilterId }
  | { readonly kind: "auto-reply"; readonly reply: AutoReply };

interface ChangeVariables {
  readonly accountId: AccountId;
  readonly change: Change;
}

/**
 * Changes filters and automatic replies on the server. The cached setup
 * shows each change right away and goes back if the server refuses; a
 * refused change (or one the server reports as conflicting) reloads it.
 */
export function useFilterChanges(): FilterChanges {
  const queryClient = useQueryClient();
  const registry = useAccountRegistry();
  const { mutateAsync } = useMutation({
    mutationFn: async ({ accountId, change }: ChangeVariables) =>
      run(filtersOf(registry, accountId), change),
    onMutate: async ({ accountId, change }) => {
      const setupKey = queryKeys.filters(accountId);
      const replyKey = queryKeys.autoReply(accountId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: setupKey }),
        queryClient.cancelQueries({ queryKey: replyKey }),
      ]);
      const setup = queryClient.getQueryData<FilterSetup>(setupKey);
      const reply = queryClient.getQueryData<AutoReply | null>(replyKey);
      if (setup) queryClient.setQueryData(setupKey, optimistic(setup, change));
      if (change.kind === "auto-reply")
        queryClient.setQueryData(replyKey, change.reply);
      return { setup, reply };
    },
    onSuccess: (saved, { accountId, change }) => {
      // The server's version of a saved filter (Gmail gives it a new id).
      if (change.kind !== "save" || !saved) return;
      const { target } = change;
      queryClient.setQueryData<FilterSetup>(
        queryKeys.filters(accountId),
        (setup) =>
          setup && {
            ...setup,
            filters:
              target.kind === "edit"
                ? setup.filters.map((filter) =>
                    filter.id === target.filter.id ? saved : filter,
                  )
                : inserted(setup.filters, saved, target.position),
          },
      );
    },
    onError: (_error, { accountId }, context) => {
      if (context?.setup)
        queryClient.setQueryData(queryKeys.filters(accountId), context.setup);
      if (context?.reply !== undefined)
        queryClient.setQueryData(queryKeys.autoReply(accountId), context.reply);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.filters(accountId),
      });
    },
    onSettled: (_result, _error, { accountId, change }) =>
      change.kind === "auto-reply"
        ? queryClient.invalidateQueries({
            queryKey: queryKeys.autoReply(accountId),
          })
        : undefined,
  });

  return useMemo<FilterChanges>(
    () => ({
      save: async (accountId, target, spec) => {
        const saved = await mutateAsync({
          accountId,
          change: { kind: "save", target, spec },
        });
        if (!saved) throw new Error("A saved filter comes back.");
        return saved;
      },
      setEnabled: async (accountId, id, enabled) => {
        await mutateAsync({
          accountId,
          change: { kind: "enable", id, enabled },
        });
      },
      reorder: async (accountId, ids) => {
        await mutateAsync({ accountId, change: { kind: "reorder", ids } });
      },
      remove: async (accountId, id) => {
        await mutateAsync({ accountId, change: { kind: "remove", id } });
      },
      setAutoReply: async (accountId, reply) => {
        await mutateAsync({
          accountId,
          change: { kind: "auto-reply", reply },
        });
      },
    }),
    [mutateAsync],
  );
}

/** The cached filter setup of an account, if loaded. */
export function cachedFilterSetup(
  queryClient: QueryClient,
  accountId: AccountId,
): FilterSetup | undefined {
  return queryClient.getQueryData<FilterSetup>(queryKeys.filters(accountId));
}

async function run(
  filters: FilterProvider,
  change: Change,
): Promise<MailFilter | undefined> {
  switch (change.kind) {
    case "save":
      return change.target.kind === "edit"
        ? filters.update(change.target.filter.id, change.spec)
        : filters.create(change.spec, change.target.position);
    case "enable":
      await filters.setEnabled(change.id, change.enabled);
      return undefined;
    case "reorder":
      await filters.reorder(change.ids);
      return undefined;
    case "remove":
      await filters.remove(change.id);
      return undefined;
    case "auto-reply":
      await filters.setAutoReply(change.reply);
      return undefined;
  }
}

/** The setup as it will look after `change`. */
function optimistic(setup: FilterSetup, change: Change): FilterSetup {
  switch (change.kind) {
    case "save": {
      const { target } = change;
      // A new filter shows once the server has it (it needs its id).
      if (target.kind === "new") return setup;
      return {
        ...setup,
        filters: setup.filters.map((filter) =>
          filter.id === target.filter.id
            ? { ...filter, ...change.spec }
            : filter,
        ),
      };
    }
    case "enable":
      return {
        ...setup,
        filters: setup.filters.map((filter) =>
          filter.id === change.id
            ? { ...filter, enabled: change.enabled }
            : filter,
        ),
      };
    case "reorder": {
      const byId = new Map(setup.filters.map((filter) => [filter.id, filter]));
      return {
        ...setup,
        filters: change.ids.flatMap((id) => {
          const filter = byId.get(id);
          return filter ? [filter] : [];
        }),
      };
    }
    case "remove":
      return {
        ...setup,
        filters: setup.filters.filter((filter) => filter.id !== change.id),
      };
    case "auto-reply":
      return { ...setup, autoReply: change.reply };
  }
}

function inserted(
  filters: readonly MailFilter[],
  filter: MailFilter,
  position: number | undefined,
): readonly MailFilter[] {
  const at =
    position === undefined
      ? filters.length
      : Math.min(Math.max(position, 0), filters.length);
  return [...filters.slice(0, at), filter, ...filters.slice(at)];
}

function filtersOf(
  registry: AccountRegistry,
  accountId: AccountId,
): FilterProvider {
  const filters = registry.get(accountId)?.filters;
  if (!filters)
    throw new MailError(
      "auth-required",
      "This account is no longer connected.",
      {
        reason: "notConnected",
      },
    );
  return filters;
}
